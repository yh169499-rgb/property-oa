const { assertPlatformOwner } = require('./enterprise-applications');
const { assertTicketMutation } = require('./ticket-access');
const { recordTicketActivity } = require('./ticket-activity');
const { tableExists } = require('./tenant-schema');

function serviceError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function all(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function one(db, sql, params = []) {
  return all(db, sql, params)[0] || null;
}

function tableColumns(db, table) {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return new Set(result[0] ? result[0].values.map((row) => String(row[1])) : []);
}

const FIELD = (key, label, type = 'text', editable = false) => ({ key, label, type, editable });

// This is intentionally a code-owned allow-list. Never build a SQL identifier from a request value.
const TABLE_DESCRIPTORS = Object.freeze({
  users: {
    label: '账号', idColumn: 'id', sortColumns: ['id', 'name', 'phone', 'status'],
    fields: [FIELD('id', '账号 ID', 'number'), FIELD('phone', '手机号'), FIELD('name', '姓名', 'text', true), FIELD('role', '角色'), FIELD('status', '账号状态', 'status', true), FIELD('last_login_at', '最近登录')],
  },
  staff_profiles: {
    label: '人员档案', idColumn: 'id', sortColumns: ['id', 'name', 'position', 'employment_status'],
    fields: [FIELD('id', '档案 ID', 'number'), FIELD('user_id', '账号 ID', 'number'), FIELD('name', '姓名', 'text', true), FIELD('phone', '手机号', 'text', true), FIELD('position', '职位', 'text', true), FIELD('skill', '技能'), FIELD('manager_id', '主管档案 ID', 'number'), FIELD('employment_status', '在职状态', 'status', true), FIELD('join_date', '入职日期', 'date', true), FIELD('birth_month', '出生年月', 'month', true), FIELD('created_at', '创建时间'), FIELD('updated_at', '更新时间')],
  },
  communities: {
    label: '小区', idColumn: 'id', sortColumns: ['id', 'name', 'created'],
    fields: [FIELD('id', '小区 ID'), FIELD('name', '名称', 'text', true), FIELD('address', '地址', 'text', true), FIELD('created', '创建时间')],
  },
  community_permissions: {
    label: '小区授权', idColumn: null, sortColumns: ['community_id', 'staff_name'],
    fields: [FIELD('community_id', '小区 ID'), FIELD('staff_name', '人员')],
  },
  community_memberships: {
    label: '小区成员', idColumn: null, sortColumns: ['community_id', 'staff_profile_id'],
    fields: [FIELD('community_id', '小区 ID'), FIELD('staff_profile_id', '人员档案 ID', 'number'), FIELD('created_at', '创建时间'), FIELD('created_by_user_id', '创建人账号 ID', 'number')],
  },
  invite_codes: {
    label: '邀请码', idColumn: 'code', sortColumns: ['code', 'created'],
    fields: [FIELD('code', '邀请码'), FIELD('community_id', '小区 ID'), FIELD('created', '创建时间')],
  },
  pending_registrations: {
    label: '注册申请', idColumn: 'id', sortColumns: ['id', 'created', 'status'],
    fields: [FIELD('id', '申请 ID', 'number'), FIELD('phone', '手机号'), FIELD('name', '姓名'), FIELD('role', '岗位'), FIELD('skill', '技能'), FIELD('community_id', '小区 ID'), FIELD('status', '状态'), FIELD('created', '申请时间')],
  },
  tickets: {
    label: '工单', idColumn: 'id', sortColumns: ['created', 'status', 'priority', 'id'],
    fields: [
      FIELD('id', '工单号'), FIELD('type', '类型'), FIELD('cat', '分类', 'text', true), FIELD('desc', '描述', 'text', true), FIELD('loc', '位置', 'text', true),
      FIELD('priority', '优先级', 'text', true), FIELD('status', '状态', 'status', true), FIELD('worker', '处理人'), FIELD('assignee_user_id', '处理人账号 ID', 'number'), FIELD('assignee_staff_profile_id', '处理人档案 ID', 'number'), FIELD('assigned_at', '派单时间'), FIELD('message', '留言', 'text', true), FIELD('created', '创建时间'), FIELD('finished', '完成时间'), FIELD('reject_reason', '退回原因'), FIELD('estimated_hours', '预计工时', 'number', true), FIELD('session_id', '会话 ID'), FIELD('community_id', '小区 ID'), FIELD('repeat_key', '重复键'), FIELD('repeat_of', '重复工单'), FIELD('repeat_count', '重复次数', 'number'), FIELD('is_recurring', '是否周期', 'boolean'), FIELD('recurrence_note', '周期说明'), FIELD('feedback_count', '反馈次数', 'number'), FIELD('metadata', '元数据', 'json'), FIELD('performance_rule_version_id', '绩效规则 ID', 'number')],
  },
  staff_status: {
    label: '人员状态', idColumn: null, sortColumns: ['name', 'updated'],
    fields: [FIELD('name', '姓名'), FIELD('status', '状态'), FIELD('updated', '更新时间')],
  },
  shift_templates: {
    label: '班次模板', idColumn: 'id', sortColumns: ['id', 'name'],
    fields: [FIELD('id', '模板 ID', 'number'), FIELD('name', '名称', 'text', true), FIELD('start_time', '开始时间', 'time', true), FIELD('end_time', '结束时间', 'time', true), FIELD('color', '颜色', 'text', true), FIELD('grace_minutes', '宽限分钟', 'number', true), FIELD('created_by', '创建人账号 ID', 'number')],
  },
  shift_assignments: {
    label: '排班', idColumn: 'id', sortColumns: ['work_date', 'id'],
    fields: [FIELD('id', '排班 ID', 'number'), FIELD('staff_id', '人员档案 ID', 'number'), FIELD('work_date', '日期', 'date'), FIELD('assignment_type', '类型', 'text', true), FIELD('template_id', '模板 ID', 'number', true), FIELD('start_at', '开始时间', 'datetime', true), FIELD('end_at', '结束时间', 'datetime', true), FIELD('leave_type', '请假类型', 'text', true), FIELD('note', '备注', 'text', true), FIELD('created_by', '创建人账号 ID', 'number'), FIELD('updated_at', '更新时间')],
  },
  attendance_records: {
    label: '考勤记录', idColumn: 'id', sortColumns: ['work_date', 'id'],
    fields: [FIELD('id', '记录 ID', 'number'), FIELD('staff_id', '人员档案 ID', 'number'), FIELD('shift_assignment_id', '排班 ID', 'number'), FIELD('work_date', '日期', 'date'), FIELD('check_in_at', '签到时间'), FIELD('check_out_at', '签退时间'), FIELD('status', '状态'), FIELD('is_corrected', '已修正', 'boolean'), FIELD('updated_at', '更新时间')],
  },
  attendance_change_logs: {
    label: '考勤变更日志', idColumn: 'id', sortColumns: ['created_at', 'id'],
    fields: [FIELD('id', '日志 ID', 'number'), FIELD('attendance_id', '考勤记录 ID', 'number'), FIELD('operator_user_id', '操作人账号 ID', 'number'), FIELD('before_json', '修改前', 'json'), FIELD('after_json', '修改后', 'json'), FIELD('reason', '原因'), FIELD('created_at', '创建时间')],
  },
  ticket_activity_logs: {
    label: '工单流转记录', idColumn: 'id', sortColumns: ['created_at', 'id'],
    fields: [FIELD('id', '日志 ID', 'number'), FIELD('ticket_id', '工单号'), FIELD('actor_user_id', '操作人账号 ID', 'number'), FIELD('actor_staff_id', '操作人档案 ID', 'number'), FIELD('action', '动作'), FIELD('metadata', '元数据', 'json'), FIELD('created_at', '创建时间')],
  },
  workforce_import_batches: {
    label: '人员导入批次', idColumn: 'id', sortColumns: ['imported_at', 'id'],
    fields: [FIELD('id', '批次 ID', 'number'), FIELD('import_key', '导入键'), FIELD('imported_by', '导入人账号 ID', 'number'), FIELD('imported_at', '导入时间'), FIELD('summary_json', '汇总', 'json')],
  },
  performance_rule_versions: {
    label: '绩效规则版本', idColumn: 'id', sortColumns: ['effective_at', 'version_no', 'id'],
    fields: [FIELD('id', '规则 ID', 'number'), FIELD('version_no', '版本号', 'number'), FIELD('name', '名称'), FIELD('completion_weight', '完成权重', 'number'), FIELD('on_time_weight', '按时权重', 'number'), FIELD('quality_weight', '质量权重', 'number'), FIELD('excellent_threshold', '优秀阈值', 'number'), FIELD('good_threshold', '良好阈值', 'number'), FIELD('qualified_threshold', '合格阈值', 'number'), FIELD('minimum_sample_size', '最小样本数', 'number'), FIELD('effective_at', '生效时间'), FIELD('created_by_user_id', '创建人账号 ID', 'number'), FIELD('created_at', '创建时间'), FIELD('is_active', '启用', 'boolean')],
  },
  ai_report_analyses: {
    label: 'AI 报告分析', idColumn: 'id', sortColumns: ['created_at', 'id'],
    fields: [FIELD('id', '分析 ID', 'number'), FIELD('staff_profile_id', '人员档案 ID', 'number'), FIELD('community_id', '小区 ID'), FIELD('range_from', '开始日期', 'date'), FIELD('range_to', '结束日期', 'date'), FIELD('report_hash', '报告哈希'), FIELD('model', '模型'), FIELD('prompt_version', '提示词版本'), FIELD('analysis_json', '分析内容', 'json'), FIELD('created_by_user_id', '创建人账号 ID', 'number'), FIELD('created_at', '创建时间')],
  },
  staff_lifecycle_audit: {
    label: '人员生命周期日志', idColumn: 'id', sortColumns: ['created_at', 'id'],
    fields: [FIELD('id', '日志 ID', 'number'), FIELD('actor_user_id', '操作人账号 ID', 'number'), FIELD('target_user_id', '目标账号 ID', 'number'), FIELD('target_staff_profile_id', '目标档案 ID', 'number'), FIELD('action', '动作'), FIELD('created_at', '创建时间'), FIELD('metadata', '元数据', 'json')],
  },
});

const EDITABLE = new Set(['users', 'staff_profiles', 'communities', 'tickets', 'shift_templates', 'shift_assignments']);
const READ_ONLY = new Set(Object.keys(TABLE_DESCRIPTORS).filter((table) => !EDITABLE.has(table)));

function descriptorFor(db, table) {
  const descriptor = TABLE_DESCRIPTORS[table];
  if (!descriptor || !tableExists(db, table) || table === 'tenant_settings') {
    throw serviceError('数据表不存在或不开放查看', 'PLATFORM_DATA_TABLE_NOT_FOUND', 404);
  }
  const available = tableColumns(db, table);
  const fields = descriptor.fields.filter((field) => available.has(field.key));
  return { ...descriptor, fields, columnNames: new Set(fields.map((field) => field.key)) };
}

function tenantOrThrow(db, tenantId) {
  const tenant = one(db, 'SELECT id,name,status,staff_limit,created_at,updated_at FROM tenants WHERE id=?', [tenantId]);
  if (!tenant) throw serviceError('企业不存在', 'TENANT_NOT_FOUND', 404);
  return tenant;
}

function assertAccess(db, actor, tenantId) {
  assertPlatformOwner(actor);
  return tenantOrThrow(db, tenantId);
}

function safeValue(value) {
  if (value === undefined) return null;
  return value;
}

function normalizeOptions(query, descriptor) {
  const page = Math.max(1, Number.parseInt(query?.page || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(query?.pageSize || '50', 10) || 50));
  const sort = descriptor.sortColumns.includes(query?.sort) ? query.sort : descriptor.sortColumns[0] || descriptor.fields[0]?.key;
  const order = String(query?.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const search = String(query?.search || '').trim().slice(0, 120);
  return { page, pageSize, sort, order, search };
}

function listDataTables(db, actor, tenantId) {
  assertAccess(db, actor, tenantId);
  return Object.entries(TABLE_DESCRIPTORS)
    .filter(([key]) => tableExists(db, key))
    .map(([key]) => {
      const descriptor = descriptorFor(db, key);
      const count = Number(one(db, `SELECT COUNT(*) AS count FROM ${key} WHERE tenant_id=?`, [tenantId])?.count || 0);
      return {
        key,
        label: descriptor.label,
        count,
        editable: EDITABLE.has(key),
        deletable: false,
        columns: descriptor.fields,
      };
    });
}

function listDataRows(db, actor, tenantId, table, query = {}) {
  assertAccess(db, actor, tenantId);
  const descriptor = descriptorFor(db, table);
  const options = normalizeOptions(query, descriptor);
  const columns = descriptor.fields.map((field) => field.key);
  if (!columns.length) return { table, label: descriptor.label, columns: [], rows: [], page: options.page, pageSize: options.pageSize, total: 0 };
  const where = ['tenant_id=?'];
  const params = [tenantId];
  if (options.search) {
    const searchColumns = columns.filter((column) => ['id', 'name', 'phone', 'title', 'type', 'cat', 'desc', 'loc', 'status', 'worker', 'message', 'code'].includes(column));
    if (searchColumns.length) {
      where.push(`(${searchColumns.map((column) => `CAST(${column} AS TEXT) LIKE ?`).join(' OR ')})`);
      searchColumns.forEach(() => params.push(`%${options.search}%`));
    }
  }
  const whereSql = where.join(' AND ');
  const total = Number(one(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${whereSql}`, params)?.count || 0);
  const offset = (options.page - 1) * options.pageSize;
  const rows = all(db, `SELECT ${columns.join(', ')} FROM ${table} WHERE ${whereSql} ORDER BY ${options.sort} ${options.order} LIMIT ? OFFSET ?`, [...params, options.pageSize, offset]);
  return { table, label: descriptor.label, columns: descriptor.fields, rows, page: options.page, pageSize: options.pageSize, total };
}

function normalizePatch(table, patch, descriptor) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw serviceError('修改内容格式不正确', 'INVALID_PATCH');
  const keys = Object.keys(patch);
  const allowed = new Set(descriptor.fields.filter((field) => field.editable).map((field) => field.key));
  const forbidden = keys.filter((key) => !allowed.has(key));
  if (forbidden.length) throw serviceError(`不允许修改字段：${forbidden.join(', ')}`, 'PLATFORM_DATA_FIELD_FORBIDDEN');
  if (!keys.length) throw serviceError('至少提交一个可修改字段', 'INVALID_PATCH');
  const normalized = {};
  for (const key of keys) {
    let value = patch[key];
    if (typeof value === 'string') value = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (key === 'phone' && value && !/^1[3-9]\d{9}$/.test(String(value))) throw serviceError('手机号格式不正确', 'INVALID_PHONE');
    if (key === 'position' && /主管|经理|平台|platform_owner/i.test(String(value || ''))) throw serviceError('平台数据中心不能提升账号权限', 'PLATFORM_DATA_PRIVILEGE_ESCALATION');
    if (key === 'status' && table === 'users' && !['active', 'disabled'].includes(String(value))) throw serviceError('账号状态不合法', 'INVALID_STATUS');
    if (key === 'employment_status' && !['active', 'inactive', 'departed'].includes(String(value))) throw serviceError('人员状态不合法', 'INVALID_STATUS');
    if (['estimated_hours', 'grace_minutes'].includes(key)) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) throw serviceError(`${key}必须是非负数字`, 'INVALID_NUMBER');
      value = key === 'grace_minutes' ? Math.floor(numeric) : numeric;
    }
    if (key === 'template_id' && (value === '' || value == null)) value = null;
    if (['name', 'position', 'start_time', 'end_time', 'assignment_type', 'leave_type'].includes(key) && String(value || '').length > 120) throw serviceError(`${key}长度过长`, 'INVALID_PATCH');
    normalized[key] = safeValue(value);
  }
  return normalized;
}

function currentRow(db, table, descriptor, tenantId, id) {
  if (!descriptor.idColumn) throw serviceError('该数据表仅支持查看', 'PLATFORM_DATA_READ_ONLY', 405);
  return one(db, `SELECT ${descriptor.fields.map((field) => field.key).join(', ')} FROM ${table} WHERE tenant_id=? AND ${descriptor.idColumn}=?`, [tenantId, id]);
}

function audit(db, actor, tenantId, table, id, before, after, nowIso) {
  db.run(`INSERT INTO platform_audit_logs
    (actor_user_id,action,target_type,target_id,before_json,after_json,created_at)
    VALUES(?,?,?,?,?,?,?)`, [
    actor.id, 'data.update', 'tenant_table_row', `${tenantId}/${table}/${id}`,
    JSON.stringify(before || {}), JSON.stringify(after || {}), nowIso,
  ]);
}

function updateUserAndProfile(db, actor, tenantId, id, patch, nowIso) {
  const user = one(db, 'SELECT * FROM users WHERE tenant_id=? AND id=?', [tenantId, id]);
  if (!user) throw serviceError('账号不存在', 'PLATFORM_DATA_ROW_NOT_FOUND', 404);
  const profile = one(db, 'SELECT * FROM staff_profiles WHERE tenant_id=? AND user_id=?', [tenantId, id]);
  const before = { user: { id: user.id, phone: user.phone, name: user.name, role: user.role, status: user.status }, profile: profile ? { id: profile.id, name: profile.name, phone: profile.phone, position: profile.position, employment_status: profile.employment_status } : null };
  const userPatch = {};
  if (patch.name !== undefined) userPatch.name = patch.name;
  if (patch.phone !== undefined) userPatch.phone = patch.phone;
  if (patch.status !== undefined) userPatch.status = patch.status;
  const columns = Object.keys(userPatch);
  if (columns.length) {
    const values = columns.map((column) => userPatch[column]);
    if (columns.includes('status')) {
      columns.push('session_version');
      values.push(Number(user.session_version || 0) + 1);
    }
    try {
      db.run(`UPDATE users SET ${columns.map((column) => `${column}=?`).join(', ')} WHERE tenant_id=? AND id=?`, [...values, tenantId, id]);
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE')) throw serviceError('手机号已被其他账号使用', 'PHONE_CONFLICT', 409);
      throw error;
    }
  }
  if (profile) {
    const profilePatch = {};
    if (patch.name !== undefined) profilePatch.name = patch.name;
    if (patch.phone !== undefined) profilePatch.phone = patch.phone;
    if (patch.position !== undefined) profilePatch.position = patch.position;
    if (patch.employment_status !== undefined) profilePatch.employment_status = patch.employment_status;
    if (patch.status !== undefined) profilePatch.employment_status = patch.status === 'active' ? 'active' : 'inactive';
    if (Object.keys(profilePatch).length) {
      const columns2 = Object.keys(profilePatch);
      db.run(`UPDATE staff_profiles SET ${columns2.map((column) => `${column}=?`).join(', ')}, updated_at=? WHERE tenant_id=? AND user_id=?`, [...columns2.map((column) => profilePatch[column]), nowIso, tenantId, id]);
    }
  }
  const afterUser = one(db, 'SELECT id,phone,name,role,status FROM users WHERE tenant_id=? AND id=?', [tenantId, id]);
  const afterProfile = profile ? one(db, 'SELECT id,name,phone,position,employment_status FROM staff_profiles WHERE tenant_id=? AND user_id=?', [tenantId, id]) : null;
  audit(db, actor, tenantId, 'users', id, before, { user: afterUser, profile: afterProfile }, nowIso);
  return { user: afterUser, profile: afterProfile };
}

function updateStaffProfile(db, actor, tenantId, id, patch, nowIso) {
  const profile = one(db, 'SELECT * FROM staff_profiles WHERE tenant_id=? AND id=?', [tenantId, id]);
  if (!profile) throw serviceError('人员档案不存在', 'PLATFORM_DATA_ROW_NOT_FOUND', 404);
  const before = { id: profile.id, user_id: profile.user_id, name: profile.name, phone: profile.phone, position: profile.position, employment_status: profile.employment_status, join_date: profile.join_date, birth_month: profile.birth_month };
  const values = Object.keys(patch).map((column) => patch[column]);
  const columns = Object.keys(patch);
  if (columns.length) {
    try {
      db.run(`UPDATE staff_profiles SET ${columns.map((column) => `${column}=?`).join(', ')}, updated_at=? WHERE tenant_id=? AND id=?`, [...values, nowIso, tenantId, id]);
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE')) throw serviceError('手机号已被其他账号使用', 'PHONE_CONFLICT', 409);
      throw error;
    }
  }
  if (profile.user_id != null) {
    const userPatch = {};
    if (patch.name !== undefined) userPatch.name = patch.name;
    if (patch.phone !== undefined) userPatch.phone = patch.phone;
    if (patch.employment_status !== undefined) userPatch.status = patch.employment_status === 'active' ? 'active' : 'disabled';
    if (Object.keys(userPatch).length) {
      try {
        const userColumns = Object.keys(userPatch);
        const userValues = userColumns.map((column) => userPatch[column]);
        if (userColumns.includes('status')) {
          userColumns.push('session_version');
          userValues.push(Number(one(db, 'SELECT session_version FROM users WHERE tenant_id=? AND id=?', [tenantId, profile.user_id])?.session_version || 0) + 1);
        }
        db.run(`UPDATE users SET ${userColumns.map((column) => `${column}=?`).join(', ')} WHERE tenant_id=? AND id=?`, [...userValues, tenantId, profile.user_id]);
      } catch (error) {
        if (String(error.message || '').includes('UNIQUE')) throw serviceError('手机号已被其他账号使用', 'PHONE_CONFLICT', 409);
        throw error;
      }
    }
  }
  const after = one(db, 'SELECT id,user_id,name,phone,position,employment_status,join_date,birth_month FROM staff_profiles WHERE tenant_id=? AND id=?', [tenantId, id]);
  audit(db, actor, tenantId, 'staff_profiles', id, before, after, nowIso);
  return after;
}

function updateGeneric(db, actor, tenantId, table, id, patch, descriptor, nowIso) {
  const before = currentRow(db, table, descriptor, tenantId, id);
  if (!before) throw serviceError('数据记录不存在', 'PLATFORM_DATA_ROW_NOT_FOUND', 404);
  if (table === 'tickets' && patch.status !== undefined) {
    assertTicketMutation({ user: { ...actor, role: '主管', tenant_id: tenantId } }, before, patch);
  }
  const columns = Object.keys(patch);
  try {
    db.run(`UPDATE ${table} SET ${columns.map((column) => `${column}=?`).join(', ')} WHERE tenant_id=? AND ${descriptor.idColumn}=?`, [...columns.map((column) => patch[column]), tenantId, id]);
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) throw serviceError('数据存在唯一性冲突', 'PLATFORM_DATA_CONFLICT', 409);
    throw error;
  }
  const after = currentRow(db, table, descriptor, tenantId, id);
  if (table === 'tickets' && patch.status !== undefined && patch.status !== before.status) {
    recordTicketActivity(db, { tenantId, ticketId: id, actorUserId: actor.id, actorStaffId: null, action: 'platform_update', metadata: { status_from: before.status, status_to: patch.status }, createdAt: nowIso });
  }
  audit(db, actor, tenantId, table, id, before, after, nowIso);
  return after;
}

function updateDataRow(db, actor, tenantId, table, id, rawPatch) {
  assertAccess(db, actor, tenantId);
  const descriptor = descriptorFor(db, table);
  const patch = normalizePatch(table, rawPatch, descriptor);
  const nowIso = new Date().toISOString();
  if (table === 'users') {
    const result = updateUserAndProfile(db, actor, tenantId, id, patch, nowIso);
    return { table, id, row: result.user, synced_profile: result.profile };
  }
  if (table === 'staff_profiles') {
    return { table, id, row: updateStaffProfile(db, actor, tenantId, id, patch, nowIso) };
  }
  return { table, id, row: updateGeneric(db, actor, tenantId, table, id, patch, descriptor, nowIso) };
}

function deleteDataRow() {
  throw serviceError('管理平台数据中心不允许删除数据', 'PLATFORM_DATA_DELETE_FORBIDDEN', 405);
}

module.exports = {
  TABLE_DESCRIPTORS,
  EDITABLE,
  READ_ONLY,
  listDataTables,
  listDataRows,
  updateDataRow,
  deleteDataRow,
  serviceError,
};
