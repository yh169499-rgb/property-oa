const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { queryAll, queryOne, run, saveDB, getDB } = require('../db');
const {
  descendantIds,
  buildOrganizationTree,
  updateManager,
} = require('../services/organization');
const {
  IMPORT_FIELD_ALIASES,
  importKey,
  normalizedImportPayload,
  previewProfileImport,
} = require('../services/workforce-migration');
const { MANAGER_ROLES, positionForRole } = require('../services/roles');
const {
  assertTeamCapacity,
  normalizedStaffRole,
} = require('../services/team-capacity');
const {
  tenantIdFrom,
  assertNoClientTenant,
  assertTenantWriteTarget,
} = require('../services/tenant-context');

const router = express.Router();
const SELF_FIELDS = new Set(['phone', 'birth_month']);
const ADMIN_FIELDS = new Set([
  'name',
  'birth_month',
  'join_date',
  'phone',
  'position',
  'skill',
  'manager_id',
]);
const CREATE_FIELDS = new Set([...ADMIN_FIELDS, 'employment_status']);
const IMPORT_BLOCKED_FIELDS = new Set(['employmentStatus', 'employment_status']);

function apiError(message, status, code, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function handleError(res, error) {
  return res.status(error.status || 500).json({
    error: error.message,
    code: error.code || 'INTERNAL_ERROR',
    details: error.details || {},
  });
}

function profileById(id, tenantId) {
  return queryOne(
    'SELECT * FROM staff_profiles WHERE id = ? AND tenant_id = ?',
    [id, tenantId]
  );
}

function ownProfile(userId, tenantId) {
  return queryOne(
    'SELECT * FROM staff_profiles WHERE user_id = ? AND tenant_id = ?',
    [userId, tenantId]
  );
}

function ensureOwnProfile(user) {
  const tenantId = String(user.tenant_id || '');
  const existing = ownProfile(user.id, tenantId);
  if (existing) return existing;
  const now = new Date().toISOString();
  run(`INSERT OR IGNORE INTO staff_profiles
    (tenant_id, user_id, name, phone, position, employment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  [tenantId, user.id, user.name || '', user.phone || '', positionForRole(user.role), now, now]);
  saveDB();
  return ownProfile(user.id, tenantId);
}

function validateFields(body, allowed) {
  const fields = Object.keys(body || {});
  const invalid = fields.filter((field) => !allowed.has(field));
  if (invalid.length) {
    throw apiError('包含不允许修改的档案字段', 400, 'INVALID_PROFILE_FIELDS', {
      fields: invalid,
    });
  }
  if (!fields.length) {
    throw apiError('没有可更新的档案字段', 400, 'INVALID_PROFILE_FIELDS');
  }
  return fields;
}

function withTransaction(work) {
  const db = getDB();
  try {
    db.run('BEGIN TRANSACTION');
    const result = work(db);
    db.run('COMMIT');
    return result;
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch (_) {
      // Ignore rollback errors when the transaction never started.
    }
    throw error;
  }
}

function candidateProfile(current, body) {
  return { ...current, ...(body || {}) };
}

function rowFrom(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const row = statement.step() ? statement.getAsObject() : null;
  statement.free();
  return row;
}

function assertActiveProfileAssignment(db, tenantId, current, body, options = {}) {
  const candidate = candidateProfile(current || {}, body);
  const role = normalizedStaffRole(candidate.position);
  if (candidate.employment_status !== 'active') return;
  if (!role) {
    const isSupervisor = MANAGER_ROLES.has(String(candidate.position || '').trim().toLowerCase());
    if (isSupervisor && (candidate.manager_id === null || candidate.manager_id === undefined || candidate.manager_id === '')) return;
    throw apiError('在职直属人员必须使用维修或管家岗位', 400, 'INVALID_STAFF_ROLE', {
      role: candidate.position,
    });
  }
  if (candidate.manager_id === null || candidate.manager_id === undefined || candidate.manager_id === '') {
    throw apiError('在职普通员工必须绑定直属主管', 409, 'ACTIVE_STAFF_MANAGER_REQUIRED');
  }
  assertTenantWriteTarget(db, {
    table: 'staff_profiles', id: candidate.manager_id, tenantId,
    notFoundCode: 'MANAGER_NOT_FOUND', notFoundMessage: '直属上级档案不存在',
  });
  const manager = rowFrom(
    db,
    `SELECT id, position, employment_status FROM staff_profiles
     WHERE id = ? AND tenant_id = ?`,
    [candidate.manager_id, tenantId]
  );
  const managerIsActive = manager && manager.employment_status === 'active';
  const managerIsSupervisor = manager && MANAGER_ROLES.has(
    String(manager.position || '').trim().toLowerCase()
  );
  if (!managerIsActive || !managerIsSupervisor) {
    throw apiError('直属上级必须是在职主管', 409, 'INVALID_ACTIVE_MANAGER', {
      managerId: candidate.manager_id,
    });
  }
  assertTeamCapacity(db, candidate.manager_id, role, {
    excludeProfileId: options.excludeProfileId,
  });
}

function updateProfile(tenantId, id, body, allowed) {
  assertNoClientTenant(body);
  const fields = validateFields(body, allowed);
  const result = withTransaction((db) => {
    const current = profileById(id, tenantId);
    if (fields.some((field) => ['manager_id', 'position', 'employment_status'].includes(field))) {
      assertActiveProfileAssignment(db, tenantId, current, body, { excludeProfileId: id });
    }
    const regularFields = fields.filter((field) => field !== 'manager_id');
    if (fields.includes('manager_id')) {
      updateManager(db, tenantId, id, body.manager_id, { profile: candidateProfile(current, body) });
    }
    if (regularFields.length) {
      const assignments = regularFields.map((field) => `${field} = ?`).join(', ');
      const values = regularFields.map((field) => body[field]);
      db.run(
        `UPDATE staff_profiles SET ${assignments}, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [...values, new Date().toISOString(), id, tenantId]
      );
    }
    return profileById(id, tenantId);
  });
  saveDB();
  return result;
}

function updateOwnProfile(profile, userId, tenantId, body) {
  assertNoClientTenant(body);
  const fields = validateFields(body, SELF_FIELDS);
  if (fields.includes('phone')) {
    if (typeof body.phone !== 'string' || !body.phone.trim()) {
      throw apiError('手机号不能为空', 400, 'INVALID_PHONE');
    }
    const existing = queryOne(
      'SELECT id FROM users WHERE phone = ? AND id <> ?',
      [body.phone, userId]
    );
    if (existing) {
      throw apiError('手机号已被其他账号使用', 409, 'PHONE_CONFLICT', {
        phone: body.phone,
      });
    }
  }

  const db = getDB();
  try {
    db.run('BEGIN TRANSACTION');
    if (fields.includes('phone')) {
      db.run(
        'UPDATE users SET phone = ? WHERE id = ? AND tenant_id = ?',
        [body.phone, userId, tenantId]
      );
    }
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    db.run(
      `UPDATE staff_profiles SET ${assignments}, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [...fields.map((field) => body[field]), new Date().toISOString(), profile.id, tenantId]
    );
    db.run('COMMIT');
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch (_) {
      // Ignore rollback errors when the transaction never started.
    }
    if (/UNIQUE constraint failed: users\.phone/.test(error.message)) {
      throw apiError('手机号已被其他账号使用', 409, 'PHONE_CONFLICT', {
        phone: body.phone,
      });
    }
    throw error;
  }
  saveDB();
  return profileById(profile.id, tenantId);
}

function importProfiles(body) {
  if (!body || !Array.isArray(body.profiles) || !body.profiles.length) {
    throw apiError('profiles 必须是非空数组', 400, 'INVALID_IMPORT_PAYLOAD');
  }
  return body.profiles.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw apiError('档案项格式无效', 400, 'INVALID_IMPORT_PAYLOAD');
    }
    return normalizedImportPayload(item);
  });
}

router.post('/staff/profiles/import-preview', requireAuth, requireAdmin, (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    const profiles = importProfiles(req.body);
    res.json({
      data: {
        ...previewProfileImport(getDB(), profiles, tenantId),
        import_key: importKey({ tenantId, profiles }),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/staff/profiles/import-confirm', requireAuth, requireAdmin, async (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    const profiles = importProfiles(req.body);
    if (!Array.isArray(req.body.selections)) {
      throw apiError('selections 必须是数组', 400, 'INVALID_IMPORT_SELECTIONS');
    }
    const normalized = normalizedImportPayload({ tenantId, profiles, selections: req.body.selections });
    const key = importKey(normalized);
    const existingBatch = queryOne(
      `SELECT * FROM workforce_import_batches
       WHERE tenant_id = ? AND import_key = ?`,
      [tenantId, key]
    );
    if (existingBatch) {
      return res.json({ data: { already_imported: true, import_key: key, summary: JSON.parse(existingBatch.summary_json || '{}') } });
    }
    const preview = previewProfileImport(getDB(), profiles, tenantId);
    const matched = new Map(preview.matches.map((item) => [item.index, item]));
    const summary = withTransaction((db) => {
      let updated = 0;
      const fieldsUpdated = {};
      req.body.selections.forEach((selection) => {
        const index = Number(selection && selection.index);
        const match = matched.get(index);
        if (!match) throw apiError('勾选项未匹配到唯一档案', 409, 'IMPORT_MATCH_CONFLICT', { index });
        const fields = Array.isArray(selection.fields) ? [...new Set(selection.fields)] : [];
        const blocked = fields.find((field) => IMPORT_BLOCKED_FIELDS.has(field));
        if (blocked) {
          throw apiError('该字段必须通过人员生命周期接口修改', 400, 'INVALID_IMPORT_FIELD', {
            index,
            field: blocked,
          });
        }
        const assignments = [];
        const values = [];
        fields.forEach((requested) => {
          const column = IMPORT_FIELD_ALIASES[requested];
          if (!column || !Object.prototype.hasOwnProperty.call(profiles[index], requested)) {
            throw apiError('包含不可导入或缺失的字段', 400, 'INVALID_IMPORT_FIELD', { index, field: requested });
          }
          assignments.push(`${column} = ?`);
          values.push(profiles[index][requested]);
          fieldsUpdated[column] = (fieldsUpdated[column] || 0) + 1;
        });
        if (!assignments.length) return;
        const body = fields.reduce((result, requested) => {
          const column = IMPORT_FIELD_ALIASES[requested];
          result[column] = profiles[index][requested];
          return result;
        }, {});
        if (Object.keys(body).some((field) => ['position', 'employment_status'].includes(field))) {
          assertActiveProfileAssignment(db, tenantId, match.profile, body, {
            excludeProfileId: match.profile.id,
          });
        }
        db.run(`UPDATE staff_profiles SET ${assignments.join(', ')}, updated_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [...values, new Date().toISOString(), match.profile.id, tenantId]);
        updated += 1;
      });
      const result = { updated, selected: req.body.selections.length, fields: fieldsUpdated };
      db.run(`INSERT INTO workforce_import_batches
        (tenant_id, import_key, imported_by, imported_at, summary_json)
        VALUES (?, ?, ?, ?, ?)`,
      [tenantId, key, req.user.id, new Date().toISOString(), JSON.stringify(result)]);
      return result;
    });
    await saveDB();
    res.json({ data: { already_imported: false, import_key: key, summary } });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/me', requireAuth, (req, res) => {
  try {
    tenantIdFrom(req);
    const profile = ensureOwnProfile(req.user);
    if (!profile) throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    res.json({ data: profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/me', requireAuth, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    const profile = ensureOwnProfile(req.user);
    if (!profile) throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    res.json({ data: updateOwnProfile(profile, req.user.id, tenantId, req.body) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/staff/profiles', requireAuth, requireAdmin, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    res.json({
      data: queryAll(
        'SELECT * FROM staff_profiles WHERE tenant_id = ? ORDER BY id',
        [tenantId]
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/staff/profiles/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    const profile = profileById(req.params.id, tenantId);
    if (!profile) throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    res.json({ data: profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/staff/profiles', requireAuth, requireAdmin, async (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    const fields = validateFields(req.body, CREATE_FIELDS);
    if (fields.includes('employment_status') && req.body.employment_status !== 'active') {
      throw apiError('新建档案只允许 active 状态', 400, 'INVALID_EMPLOYMENT_STATUS');
    }
    const now = new Date().toISOString();
    const columns = ['tenant_id', ...fields, 'created_at', 'updated_at'];
    const placeholders = columns.map(() => '?').join(', ');
    const created = withTransaction((db) => {
      const candidate = {
        position: req.body.position || '',
        manager_id: req.body.manager_id ?? null,
        employment_status: req.body.employment_status || 'active',
      };
      db.run(
        `INSERT INTO staff_profiles (${columns.join(', ')}) VALUES (${placeholders})`,
        [tenantId, ...fields.map((field) => field === 'manager_id' ? null : req.body[field]), now, now]
      );
      const inserted = queryOne(
        'SELECT * FROM staff_profiles WHERE id = last_insert_rowid() AND tenant_id = ?',
        [tenantId]
      );
      if (fields.includes('manager_id')) {
        updateManager(db, tenantId, inserted.id, req.body.manager_id, { profile: candidate });
      } else {
        assertActiveProfileAssignment(db, tenantId, inserted, candidate, {
          excludeProfileId: inserted.id,
        });
      }
      return profileById(inserted.id, tenantId);
    });
    await saveDB();
    res.status(201).json({ data: created });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/staff/profiles/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    assertTenantWriteTarget(getDB(), {
      table: 'staff_profiles', id: req.params.id, tenantId,
      notFoundCode: 'PROFILE_NOT_FOUND', notFoundMessage: '人员档案不存在',
    });
    res.json({ data: updateProfile(tenantId, req.params.id, req.body, ADMIN_FIELDS) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/organization/tree', requireAuth, requireAdmin, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    const profiles = queryAll(
      'SELECT * FROM staff_profiles WHERE tenant_id = ? ORDER BY id',
      [tenantId]
    );
    res.json({ data: buildOrganizationTree(profiles) });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/staff/profiles/:id/manager', requireAuth, requireAdmin, async (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'manager_id')) {
      throw apiError('缺少 manager_id', 400, 'INVALID_MANAGER');
    }
    const profile = updateManager(
      getDB(), tenantId, req.params.id, req.body.manager_id
    );
    await saveDB();
    res.json({ data: profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/staff/profiles/:id/team', requireAuth, requireAdmin, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    const profiles = queryAll(
      'SELECT * FROM staff_profiles WHERE tenant_id = ? ORDER BY id',
      [tenantId]
    );
    if (!profiles.some((profile) => Number(profile.id) === Number(req.params.id))) {
      throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    }
    const ids = descendantIds(profiles, req.params.id);
    const byId = new Map(profiles.map((profile) => [Number(profile.id), profile]));
    res.json({ data: ids.map((id) => byId.get(Number(id))).filter(Boolean) });
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
