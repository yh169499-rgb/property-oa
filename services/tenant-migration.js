const { TENANT_TABLES, tableExists } = require('./tenant-schema');

const DEFAULT_INPUT = Object.freeze({
  testSupervisorPhone: '13800000001',
  testTenantId: 'tenant-test',
  testTenantName: '全流程测试企业',
  testStaffLimit: 4,
});

function all(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) {
  return all(db, sql, params)[0] || null;
}

function hasColumn(db, table, column) {
  if (!tableExists(db, table)) return false;
  const result = db.exec(`PRAGMA table_info(${table})`);
  return Boolean(result[0]?.values.some((row) => row[1] === column));
}

function count(db, sql, params = []) {
  return Number(one(db, sql, params)?.count || 0);
}

function conflict(code, table, countValue) {
  return { code, table, count: Number(countValue) };
}

function normalizeInput(input = {}) {
  return {
    testSupervisorPhone: String(
      input.testSupervisorPhone ?? DEFAULT_INPUT.testSupervisorPhone
    ).trim(),
    testTenantId: String(input.testTenantId ?? DEFAULT_INPUT.testTenantId).trim(),
    testTenantName: String(input.testTenantName ?? DEFAULT_INPUT.testTenantName).trim(),
    testStaffLimit: Number(input.testStaffLimit ?? DEFAULT_INPUT.testStaffLimit),
    nowIso: String(input.nowIso || new Date().toISOString()),
  };
}

function inputConflicts(input) {
  const invalid = [];
  if (!input.testSupervisorPhone) invalid.push(conflict('INVALID_SUPERVISOR_PHONE', 'input', 1));
  if (!input.testTenantId) invalid.push(conflict('INVALID_TENANT_ID', 'input', 1));
  if (!input.testTenantName) invalid.push(conflict('INVALID_TENANT_NAME', 'input', 1));
  if (!Number.isInteger(input.testStaffLimit)
    || input.testStaffLimit < 1
    || input.testStaffLimit > 999) {
    invalid.push(conflict('INVALID_TEST_STAFF_LIMIT', 'input', 1));
  }
  if (!input.nowIso || Number.isNaN(Date.parse(input.nowIso))) {
    invalid.push(conflict('INVALID_NOW_ISO', 'input', 1));
  }
  return invalid;
}

function emptyTenantRows(db) {
  const result = [];
  for (const table of TENANT_TABLES) {
    if (!hasColumn(db, table, 'tenant_id')) continue;
    const where = table === 'users'
      ? "COALESCE(tenant_id, '') = '' AND role <> 'platform_owner'"
      : "COALESCE(tenant_id, '') = ''";
    const rowCount = count(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`);
    if (rowCount > 0) result.push({ table, count: rowCount });
  }
  return result;
}

function invalidStaffLimitConflicts(db) {
  if (!tableExists(db, 'tenants')) return [];
  const invalid = all(db, 'SELECT staff_limit FROM tenants').filter((row) => {
    const value = Number(row.staff_limit);
    return !Number.isInteger(value) || value < 1 || value > 999;
  });
  return invalid.length ? [conflict('INVALID_STAFF_LIMIT', 'tenants', invalid.length)] : [];
}

function tenantOwnerConflicts(db) {
  if (!tableExists(db, 'tenants') || !tableExists(db, 'users')) return [];
  const conflicts = [];
  const activeTenants = all(db, `SELECT id,owner_user_id FROM tenants WHERE status='active'`);
  for (const tenant of activeTenants) {
    const supervisors = all(db, `SELECT id FROM users
      WHERE tenant_id=? AND role='\u4e3b\u7ba1' AND status='active'`, [tenant.id]);
    if (supervisors.length !== 1) {
      conflicts.push(conflict('ACTIVE_TENANT_SUPERVISOR_COUNT', 'users', supervisors.length));
    }
    if (tenant.owner_user_id == null) {
      conflicts.push(conflict('ACTIVE_TENANT_OWNER_MISSING', 'tenants', 1));
    } else if (supervisors.length === 1
      && Number(tenant.owner_user_id) !== Number(supervisors[0].id)) {
      conflicts.push(conflict('ACTIVE_TENANT_OWNER_MISMATCH', 'tenants', 1));
    }
  }
  return conflicts;
}

function queryConflict(db, definition) {
  if (!definition.tables.every((table) => tableExists(db, table))) return null;
  if (definition.columns
    && !definition.columns.every(([table, column]) => hasColumn(db, table, column))) return null;
  const rowCount = count(db, definition.sql);
  return rowCount > 0 ? conflict(definition.code, definition.table, rowCount) : null;
}

function tenantReferenceConflicts(db) {
  const conflicts = [];
  if (tableExists(db, 'tenants')) {
    for (const table of TENANT_TABLES) {
      if (!hasColumn(db, table, 'tenant_id')) continue;
      const rowCount = count(db, `SELECT COUNT(*) AS count FROM ${table} child
        LEFT JOIN tenants t ON t.id=child.tenant_id
        WHERE COALESCE(child.tenant_id,'')<>'' AND t.id IS NULL`);
      if (rowCount > 0) conflicts.push(conflict('UNKNOWN_TENANT_REFERENCE', table, rowCount));
    }
  }

  const definitions = [
    {
      code: 'ORPHAN_PROFILE_USER', table: 'staff_profiles',
      tables: ['staff_profiles', 'users'], columns: [['staff_profiles', 'user_id']],
      sql: `SELECT COUNT(*) AS count FROM staff_profiles sp
        LEFT JOIN users u ON u.id=sp.user_id
        WHERE sp.user_id IS NOT NULL AND u.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_PROFILE_USER', table: 'staff_profiles',
      tables: ['staff_profiles', 'users'], columns: [['staff_profiles', 'user_id']],
      sql: `SELECT COUNT(*) AS count FROM staff_profiles sp
        JOIN users u ON u.id=sp.user_id
        WHERE COALESCE(sp.tenant_id,'')<>COALESCE(u.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_PROFILE_MANAGER', table: 'staff_profiles',
      tables: ['staff_profiles'], columns: [['staff_profiles', 'manager_id']],
      sql: `SELECT COUNT(*) AS count FROM staff_profiles sp
        LEFT JOIN staff_profiles manager ON manager.id=sp.manager_id
        WHERE sp.manager_id IS NOT NULL AND manager.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_PROFILE_MANAGER', table: 'staff_profiles',
      tables: ['staff_profiles'], columns: [['staff_profiles', 'manager_id']],
      sql: `SELECT COUNT(*) AS count FROM staff_profiles sp
        JOIN staff_profiles manager ON manager.id=sp.manager_id
        WHERE COALESCE(sp.tenant_id,'')<>COALESCE(manager.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_PERMISSION_COMMUNITY', table: 'community_permissions',
      tables: ['community_permissions', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM community_permissions cp
        LEFT JOIN communities c ON c.id=cp.community_id WHERE c.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_PERMISSION', table: 'community_permissions',
      tables: ['community_permissions', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM community_permissions cp
        JOIN communities c ON c.id=cp.community_id
        WHERE COALESCE(cp.tenant_id,'')<>COALESCE(c.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_INVITE_COMMUNITY', table: 'invite_codes',
      tables: ['invite_codes', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM invite_codes invite
        LEFT JOIN communities c ON c.id=invite.community_id WHERE c.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_INVITE_COMMUNITY', table: 'invite_codes',
      tables: ['invite_codes', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM invite_codes invite
        JOIN communities c ON c.id=invite.community_id
        WHERE COALESCE(invite.tenant_id,'')<>COALESCE(c.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_REGISTRATION_COMMUNITY', table: 'pending_registrations',
      tables: ['pending_registrations', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM pending_registrations registration
        LEFT JOIN communities c ON c.id=registration.community_id
        WHERE COALESCE(registration.community_id,'')<>'' AND c.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_REGISTRATION_COMMUNITY', table: 'pending_registrations',
      tables: ['pending_registrations', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM pending_registrations registration
        JOIN communities c ON c.id=registration.community_id
        WHERE COALESCE(registration.tenant_id,'')<>COALESCE(c.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_MEMBERSHIP', table: 'community_memberships',
      tables: ['community_memberships', 'communities', 'staff_profiles'],
      sql: `SELECT COUNT(*) AS count FROM community_memberships cm
        LEFT JOIN communities c ON c.id=cm.community_id
        LEFT JOIN staff_profiles sp ON sp.id=cm.staff_profile_id
        WHERE c.id IS NULL OR sp.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_MEMBERSHIP', table: 'community_memberships',
      tables: ['community_memberships', 'communities', 'staff_profiles'],
      sql: `SELECT COUNT(*) AS count FROM community_memberships cm
        JOIN communities c ON c.id=cm.community_id
        JOIN staff_profiles sp ON sp.id=cm.staff_profile_id
        WHERE COALESCE(cm.tenant_id,'')<>COALESCE(c.tenant_id,'')
          OR COALESCE(cm.tenant_id,'')<>COALESCE(sp.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_TICKET_COMMUNITY', table: 'tickets',
      tables: ['tickets', 'communities'], columns: [['tickets', 'community_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket
        LEFT JOIN communities c ON c.id=ticket.community_id
        WHERE COALESCE(ticket.community_id,'')<>'' AND c.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_TICKET_COMMUNITY', table: 'tickets',
      tables: ['tickets', 'communities'], columns: [['tickets', 'community_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket
        JOIN communities c ON c.id=ticket.community_id
        WHERE COALESCE(ticket.tenant_id,'')<>COALESCE(c.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_TICKET_ASSIGNEE_USER', table: 'tickets',
      tables: ['tickets', 'users'], columns: [['tickets', 'assignee_user_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket LEFT JOIN users u
        ON u.id=ticket.assignee_user_id
        WHERE ticket.assignee_user_id IS NOT NULL AND u.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_TICKET_ASSIGNEE_USER', table: 'tickets',
      tables: ['tickets', 'users'], columns: [['tickets', 'assignee_user_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket JOIN users u
        ON u.id=ticket.assignee_user_id
        WHERE COALESCE(ticket.tenant_id,'')<>COALESCE(u.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_TICKET_ASSIGNEE_PROFILE', table: 'tickets',
      tables: ['tickets', 'staff_profiles'], columns: [['tickets', 'assignee_staff_profile_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket LEFT JOIN staff_profiles sp
        ON sp.id=ticket.assignee_staff_profile_id
        WHERE ticket.assignee_staff_profile_id IS NOT NULL AND sp.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_TICKET_ASSIGNEE_PROFILE', table: 'tickets',
      tables: ['tickets', 'staff_profiles'], columns: [['tickets', 'assignee_staff_profile_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket JOIN staff_profiles sp
        ON sp.id=ticket.assignee_staff_profile_id
        WHERE COALESCE(ticket.tenant_id,'')<>COALESCE(sp.tenant_id,'')`,
    },
    {
      code: 'TICKET_ASSIGNEE_IDENTITY_MISMATCH', table: 'tickets',
      tables: ['tickets', 'staff_profiles'],
      columns: [['tickets', 'assignee_user_id'], ['tickets', 'assignee_staff_profile_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket JOIN staff_profiles sp
        ON sp.id=ticket.assignee_staff_profile_id
        WHERE ticket.assignee_user_id IS NOT NULL
          AND sp.user_id IS NOT ticket.assignee_user_id`,
    },
    {
      code: 'ORPHAN_TICKET_RULE', table: 'tickets',
      tables: ['tickets', 'performance_rule_versions'],
      columns: [['tickets', 'performance_rule_version_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket LEFT JOIN performance_rule_versions p
        ON p.id=ticket.performance_rule_version_id
        WHERE ticket.performance_rule_version_id IS NOT NULL AND p.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_TICKET_RULE', table: 'tickets',
      tables: ['tickets', 'performance_rule_versions'],
      columns: [['tickets', 'performance_rule_version_id']],
      sql: `SELECT COUNT(*) AS count FROM tickets ticket JOIN performance_rule_versions p
        ON p.id=ticket.performance_rule_version_id
        WHERE COALESCE(ticket.tenant_id,'')<>COALESCE(p.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_SHIFT_STAFF', table: 'shift_assignments',
      tables: ['shift_assignments', 'staff_profiles'],
      sql: `SELECT COUNT(*) AS count FROM shift_assignments sa LEFT JOIN staff_profiles sp
        ON sp.id=sa.staff_id WHERE sa.staff_id IS NOT NULL AND sp.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_SHIFT_STAFF', table: 'shift_assignments',
      tables: ['shift_assignments', 'staff_profiles'],
      sql: `SELECT COUNT(*) AS count FROM shift_assignments sa JOIN staff_profiles sp
        ON sp.id=sa.staff_id
        WHERE COALESCE(sa.tenant_id,'')<>COALESCE(sp.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_SHIFT_TEMPLATE', table: 'shift_assignments',
      tables: ['shift_assignments', 'shift_templates'],
      sql: `SELECT COUNT(*) AS count FROM shift_assignments sa LEFT JOIN shift_templates st
        ON st.id=sa.template_id WHERE sa.template_id IS NOT NULL AND st.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_SHIFT_TEMPLATE', table: 'shift_assignments',
      tables: ['shift_assignments', 'shift_templates'],
      sql: `SELECT COUNT(*) AS count FROM shift_assignments sa JOIN shift_templates st
        ON st.id=sa.template_id
        WHERE COALESCE(sa.tenant_id,'')<>COALESCE(st.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_ATTENDANCE_ASSIGNMENT', table: 'attendance_records',
      tables: ['attendance_records', 'shift_assignments'],
      sql: `SELECT COUNT(*) AS count FROM attendance_records ar LEFT JOIN shift_assignments sa
        ON sa.id=ar.shift_assignment_id
        WHERE ar.shift_assignment_id IS NOT NULL AND sa.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_ATTENDANCE', table: 'attendance_records',
      tables: ['attendance_records', 'shift_assignments', 'staff_profiles'],
      sql: `SELECT COUNT(*) AS count FROM attendance_records ar
        LEFT JOIN shift_assignments sa ON sa.id=ar.shift_assignment_id
        LEFT JOIN staff_profiles sp ON sp.id=ar.staff_id
        WHERE (sa.id IS NOT NULL AND COALESCE(ar.tenant_id,'')<>COALESCE(sa.tenant_id,''))
          OR (sp.id IS NOT NULL AND COALESCE(ar.tenant_id,'')<>COALESCE(sp.tenant_id,''))`,
    },
    {
      code: 'ORPHAN_ATTENDANCE_CHANGE', table: 'attendance_change_logs',
      tables: ['attendance_change_logs', 'attendance_records'],
      sql: `SELECT COUNT(*) AS count FROM attendance_change_logs log
        LEFT JOIN attendance_records ar ON ar.id=log.attendance_id
        WHERE log.attendance_id IS NOT NULL AND ar.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_ATTENDANCE_CHANGE', table: 'attendance_change_logs',
      tables: ['attendance_change_logs', 'attendance_records'],
      sql: `SELECT COUNT(*) AS count FROM attendance_change_logs log
        JOIN attendance_records ar ON ar.id=log.attendance_id
        WHERE COALESCE(log.tenant_id,'')<>COALESCE(ar.tenant_id,'')`,
    },
    {
      code: 'ORPHAN_TICKET_ACTIVITY', table: 'ticket_activity_logs',
      tables: ['ticket_activity_logs', 'tickets', 'users', 'staff_profiles'],
      sql: `SELECT COUNT(*) AS count FROM ticket_activity_logs log
        LEFT JOIN tickets ticket ON ticket.id=log.ticket_id
        LEFT JOIN users u ON u.id=log.actor_user_id
        LEFT JOIN staff_profiles sp ON sp.id=log.actor_staff_id
        WHERE (log.ticket_id IS NOT NULL AND ticket.id IS NULL)
          OR (log.actor_user_id IS NOT NULL AND u.id IS NULL)
          OR (log.actor_staff_id IS NOT NULL AND sp.id IS NULL)`,
    },
    {
      code: 'CROSS_TENANT_TICKET_ACTIVITY', table: 'ticket_activity_logs',
      tables: ['ticket_activity_logs', 'tickets', 'users', 'staff_profiles'],
      sql: `SELECT COUNT(*) AS count FROM ticket_activity_logs log
        LEFT JOIN tickets ticket ON ticket.id=log.ticket_id
        LEFT JOIN users u ON u.id=log.actor_user_id
        LEFT JOIN staff_profiles sp ON sp.id=log.actor_staff_id
        WHERE (ticket.id IS NOT NULL AND COALESCE(log.tenant_id,'')<>COALESCE(ticket.tenant_id,''))
          OR (u.id IS NOT NULL AND u.role<>'platform_owner'
            AND COALESCE(log.tenant_id,'')<>COALESCE(u.tenant_id,''))
          OR (sp.id IS NOT NULL AND COALESCE(log.tenant_id,'')<>COALESCE(sp.tenant_id,''))`,
    },
    {
      code: 'ORPHAN_AI_REPORT', table: 'ai_report_analyses',
      tables: ['ai_report_analyses', 'staff_profiles', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM ai_report_analyses report
        LEFT JOIN staff_profiles sp ON sp.id=report.staff_profile_id
        LEFT JOIN communities c ON c.id=report.community_id
        WHERE sp.id IS NULL OR c.id IS NULL`,
    },
    {
      code: 'CROSS_TENANT_AI_REPORT', table: 'ai_report_analyses',
      tables: ['ai_report_analyses', 'staff_profiles', 'communities'],
      sql: `SELECT COUNT(*) AS count FROM ai_report_analyses report
        JOIN staff_profiles sp ON sp.id=report.staff_profile_id
        JOIN communities c ON c.id=report.community_id
        WHERE COALESCE(report.tenant_id,'')<>COALESCE(sp.tenant_id,'')
          OR COALESCE(report.tenant_id,'')<>COALESCE(c.tenant_id,'')`,
    },
  ];
  for (const definition of definitions) {
    const found = queryConflict(db, definition);
    if (found) conflicts.push(found);
  }
  return conflicts;
}

function platformTenantConflicts(db) {
  if (!tableExists(db, 'users') || !hasColumn(db, 'users', 'tenant_id')) return [];
  const assigned = count(db, `SELECT COUNT(*) AS count FROM users
    WHERE role='platform_owner' AND COALESCE(tenant_id,'')<>''`);
  return assigned ? [conflict('PLATFORM_ACCOUNT_HAS_TENANT', 'users', assigned)] : [];
}

function tenantUniqueCollisionConflicts(db, targetTenantId) {
  const definitions = [
    ['staff_status', ['name']],
    ['tenant_settings', ['key']],
    ['shift_assignments', ['staff_id', 'work_date']],
    ['attendance_records', ['staff_id', 'work_date']],
    ['workforce_import_batches', ['import_key']],
    ['performance_rule_versions', ['version_no']],
    ['community_memberships', ['community_id', 'staff_profile_id']],
    ['ai_report_analyses', ['report_hash', 'model', 'prompt_version']],
  ];
  const conflicts = [];
  for (const [table, columns] of definitions) {
    if (!hasColumn(db, table, 'tenant_id')
      || !columns.every((column) => hasColumn(db, table, column))) continue;
    const grouped = columns.join(',');
    const nonNull = columns.map((column) => `${column} IS NOT NULL`).join(' AND ');
    const rowCount = count(db, `SELECT COUNT(*) AS count FROM (
      SELECT ${grouped}
      FROM ${table}
      WHERE COALESCE(tenant_id,'') IN ('', ?) AND ${nonNull}
      GROUP BY ${grouped}
      HAVING COUNT(*) > 1
        AND SUM(CASE WHEN COALESCE(tenant_id,'')='' THEN 1 ELSE 0 END) > 0
    )`, [targetTenantId]);
    if (rowCount > 0) conflicts.push(conflict('TENANT_UNIQUE_COLLISION', table, rowCount));
  }
  return conflicts;
}

function inspectTenantMigration(db, rawInput = {}) {
  const input = normalizeInput(rawInput);
  const empty = emptyTenantRows(db);
  const conflicts = [
    ...inputConflicts(input),
    ...invalidStaffLimitConflicts(db),
    ...tenantOwnerConflicts(db),
    ...platformTenantConflicts(db),
    ...tenantReferenceConflicts(db),
    ...tenantUniqueCollisionConflicts(db, input.testTenantId),
  ];

  if (tableExists(db, 'users')) {
    const supervisor = all(db, 'SELECT id,role,status,tenant_id FROM users WHERE phone=?', [
      input.testSupervisorPhone,
    ]);
    const eligible = supervisor.filter((row) => row.role === '主管' && row.status === 'active');
    if (eligible.length !== 1) {
      conflicts.push(conflict('TEST_SUPERVISOR_NOT_UNIQUE', 'users', eligible.length));
    } else if (String(eligible[0].tenant_id || '')
      && String(eligible[0].tenant_id) !== input.testTenantId) {
      conflicts.push(conflict('TEST_SUPERVISOR_WRONG_TENANT', 'users', 1));
    }

    const legacySupervisors = all(db, `SELECT id,phone FROM users
      WHERE role='\u4e3b\u7ba1' AND status='active' AND COALESCE(tenant_id,'')=''`);
    const otherLegacy = legacySupervisors.filter((row) => row.phone !== input.testSupervisorPhone);
    if (otherLegacy.length > 0 || (empty.length > 0 && eligible.length !== 1)) {
      conflicts.push(conflict('LEGACY_SUPERVISOR_COUNT', 'users', legacySupervisors.length));
    }
  }

  if (tableExists(db, 'tenants')) {
    const target = one(db, 'SELECT owner_user_id FROM tenants WHERE id=?', [input.testTenantId]);
    const supervisor = tableExists(db, 'users')
      ? one(db, 'SELECT id FROM users WHERE phone=?', [input.testSupervisorPhone])
      : null;
    if (target?.owner_user_id != null && supervisor
      && Number(target.owner_user_id) !== Number(supervisor.id)) {
      conflicts.push(conflict('TEST_TENANT_OWNER_CONFLICT', 'tenants', 1));
    }
  }

  return {
    ok: conflicts.length === 0,
    emptyTenantRows: empty,
    conflicts,
    summary: {
      emptyTableCount: empty.length,
      emptyRowCount: empty.reduce((total, item) => total + item.count, 0),
      conflictCount: conflicts.length,
    },
  };
}

function assertTenantIntegrity(db) {
  const empty = emptyTenantRows(db);
  const conflicts = [
    ...empty.map((item) => conflict('EMPTY_TENANT_ROWS', item.table, item.count)),
    ...invalidStaffLimitConflicts(db),
    ...tenantOwnerConflicts(db),
    ...platformTenantConflicts(db),
    ...tenantReferenceConflicts(db),
  ];
  return { ok: conflicts.length === 0, emptyTenantRows: empty, conflicts };
}

function migrationError(details) {
  const conflicts = Array.isArray(details) ? details : (details?.conflicts || []);
  const codes = [...new Set(conflicts.map((item) => item.code).filter(Boolean))];
  const error = new Error(`TENANT_MIGRATION_CONFLICT${codes.length ? `: ${codes.join(',')}` : ''}`);
  error.code = 'TENANT_MIGRATION_CONFLICT';
  error.conflicts = conflicts;
  return error;
}

function applyTenantMigration(db, rawInput = {}) {
  const input = normalizeInput(rawInput);
  const preview = inspectTenantMigration(db, input);
  if (!preview.ok) throw migrationError(preview.conflicts);

  db.run('SAVEPOINT apply_tenant_migration');
  try {
    const supervisor = one(db, 'SELECT id FROM users WHERE phone=?', [input.testSupervisorPhone]);
    db.run(`INSERT INTO tenants (
      id,name,status,owner_user_id,staff_limit,created_at,updated_at,disabled_at
    ) SELECT ? ,?,'active',?,?,?,? ,''
      WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id=?)`, [
      input.testTenantId,
      input.testTenantName,
      supervisor.id,
      input.testStaffLimit,
      input.nowIso,
      input.nowIso,
      input.testTenantId,
    ]);
    db.run(`UPDATE tenants SET
      name=?,status='active',owner_user_id=?,staff_limit=?,updated_at=?,disabled_at=''
      WHERE id=?`, [
      input.testTenantName,
      supervisor.id,
      input.testStaffLimit,
      input.nowIso,
      input.testTenantId,
    ]);

    for (const table of TENANT_TABLES) {
      if (!hasColumn(db, table, 'tenant_id')) continue;
      if (table === 'users') {
        db.run(`UPDATE users SET tenant_id=?
          WHERE COALESCE(tenant_id,'')='' AND role<>'platform_owner'`, [input.testTenantId]);
      } else {
        db.run(`UPDATE ${table} SET tenant_id=? WHERE COALESCE(tenant_id,'')=''`, [
          input.testTenantId,
        ]);
      }
    }

    const integrity = assertTenantIntegrity(db);
    if (!integrity.ok) throw migrationError(integrity.conflicts);
    db.run('RELEASE SAVEPOINT apply_tenant_migration');
    return { applied: true, preview, integrity };
  } catch (error) {
    try {
      db.run('ROLLBACK TO SAVEPOINT apply_tenant_migration');
      db.run('RELEASE SAVEPOINT apply_tenant_migration');
    } catch (_) {}
    if (error?.code === 'TENANT_MIGRATION_CONFLICT') throw error;
    throw migrationError([conflict('MIGRATION_WRITE_FAILED', 'database', 1)]);
  }
}

function hasPendingTenantMigration(db) {
  return emptyTenantRows(db).some((item) => item.count > 0);
}

module.exports = {
  DEFAULT_INPUT,
  inspectTenantMigration,
  applyTenantMigration,
  assertTenantIntegrity,
  hasPendingTenantMigration,
};
