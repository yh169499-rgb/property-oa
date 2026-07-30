function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(db, sql, params = []) {
  return queryAll(db, sql, params)[0] || null;
}

function assignmentError(message, code = 'INVALID_SHIFT_ASSIGNMENT', status = 400, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details) error.details = details;
  return error;
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isValidTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '');
}

function shanghaiDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function resolveShiftWindow(workDate, startTime, endTime) {
  if (!isValidDate(workDate) || !isValidTime(startTime) || !isValidTime(endTime)) {
    throw assignmentError('班次日期或时间格式无效');
  }
  const endDate = endTime <= startTime ? nextDate(workDate) : workDate;
  return {
    startAt: `${workDate}T${startTime}:00+08:00`,
    endAt: `${endDate}T${endTime}:00+08:00`,
  };
}

function validateCustomWindow(value) {
  const absoluteIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!absoluteIso.test(value.startAt || '') || !absoluteIso.test(value.endAt || '')) {
    throw assignmentError('自定义起止时间必须是可解析的绝对时间');
  }
  const start = Date.parse(value.startAt);
  const end = Date.parse(value.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw assignmentError('自定义起止时间无效，结束时间必须晚于开始时间');
  }
  const startDate = shanghaiDate(start);
  const endDate = shanghaiDate(end);
  if (startDate !== value.workDate
      || ![value.workDate, nextDate(value.workDate)].includes(endDate)) {
    throw assignmentError('自定义起止时间必须与 workDate 当天或跨夜窗口一致');
  }
}

function normalize(input = {}) {
  return {
    staffId: input.staffId ?? input.staff_id,
    workDate: input.workDate ?? input.work_date,
    assignmentType: input.assignmentType ?? input.assignment_type,
    templateId: input.templateId ?? input.template_id ?? null,
    startAt: input.startAt ?? input.start_at ?? null,
    endAt: input.endAt ?? input.end_at ?? null,
    leaveType: input.leaveType ?? input.leave_type ?? null,
    note: input.note ?? '',
  };
}

function validateAssignment(input) {
  const value = normalize(input);
  if (!Number.isInteger(Number(value.staffId)) || Number(value.staffId) <= 0) {
    throw assignmentError('staffId 无效');
  }
  if (!isValidDate(value.workDate)) {
    throw assignmentError('workDate 无效');
  }
  if (!['work', 'rest', 'leave'].includes(value.assignmentType)) {
    throw assignmentError('assignmentType 必须是 work、rest 或 leave');
  }
  if (value.assignmentType === 'work' && !value.templateId && !(value.startAt && value.endAt)) {
    throw assignmentError('工作安排必须提供 templateId 或起止时间');
  }
  if (value.assignmentType === 'work' && !value.templateId) {
    validateCustomWindow(value);
  }
  if (value.assignmentType !== 'work' && (value.templateId || value.startAt || value.endAt)) {
    throw assignmentError('休息或请假安排不能设置工作班次');
  }
  if (value.assignmentType === 'leave' && !value.leaveType) {
    throw assignmentError('请假安排必须提供 leaveType');
  }
  if (value.assignmentType !== 'leave' && value.leaveType) {
    throw assignmentError('非请假安排不能设置 leaveType');
  }
  return value;
}

function prepareAssignment(db, input) {
  const value = validateAssignment(input);
  if (!queryOne(db, 'SELECT id FROM staff_profiles WHERE id = ?', [value.staffId])) {
    throw assignmentError('人员档案不存在', 'STAFF_NOT_FOUND', 404);
  }
  if (value.assignmentType === 'work' && value.templateId) {
    const template = queryOne(
      db,
      'SELECT id, start_time, end_time FROM shift_templates WHERE id = ?',
      [value.templateId]
    );
    if (!template) throw assignmentError('班次模板不存在', 'SHIFT_TEMPLATE_NOT_FOUND', 404);
    const window = resolveShiftWindow(value.workDate, template.start_time, template.end_time);
    value.startAt = window.startAt;
    value.endAt = window.endAt;
  }
  return value;
}

function createAssignment(db, input, operatorUserId, options = {}) {
  const value = prepareAssignment(db, input);
  const existing = queryOne(
    db,
    'SELECT id FROM shift_assignments WHERE staff_id = ? AND work_date = ?',
    [value.staffId, value.workDate]
  );
  if (existing && !options.overwrite) {
    throw assignmentError('该人员当天已有排班', 'SHIFT_ALREADY_EXISTS', 409, {
      conflicts: [{ staffId: Number(value.staffId), workDate: value.workDate }],
    });
  }
  const now = new Date().toISOString();
  if (existing) {
    db.run(
      `UPDATE shift_assignments SET assignment_type = ?, template_id = ?, start_at = ?,
       end_at = ?, leave_type = ?, note = ?, created_by = ?, updated_at = ? WHERE id = ?`,
      [value.assignmentType, value.templateId, value.startAt, value.endAt,
        value.leaveType, value.note, operatorUserId, now, existing.id]
    );
    return queryOne(db, 'SELECT * FROM shift_assignments WHERE id = ?', [existing.id]);
  }
  db.run(
    `INSERT INTO shift_assignments
     (staff_id, work_date, assignment_type, template_id, start_at, end_at,
      leave_type, note, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [value.staffId, value.workDate, value.assignmentType, value.templateId,
      value.startAt, value.endAt, value.leaveType, value.note, operatorUserId, now]
  );
  return queryOne(db, 'SELECT * FROM shift_assignments WHERE id = last_insert_rowid()');
}

function createBatchAssignments(db, input, operatorUserId) {
  const staffIds = input.staffIds ?? input.staff_ids;
  const dates = input.dates;
  if (!Array.isArray(staffIds) || !staffIds.length || !Array.isArray(dates) || !dates.length) {
    throw assignmentError('staffIds 和 dates 必须是非空数组');
  }
  const pairs = staffIds.flatMap((staffId) => dates.map((workDate) => ({ staffId, workDate })));
  const seen = new Set();
  const duplicateConflicts = [];
  const prepared = pairs.map(({ staffId, workDate }) => {
    const key = `${staffId}\u0000${workDate}`;
    if (seen.has(key)) duplicateConflicts.push({ staffId: Number(staffId), workDate });
    seen.add(key);
    return prepareAssignment(db, { ...input, staffId, workDate });
  });
  const existingConflicts = pairs.filter(({ staffId, workDate }) =>
    queryOne(db, 'SELECT id FROM shift_assignments WHERE staff_id = ? AND work_date = ?', [staffId, workDate])
  ).map(({ staffId, workDate }) => ({ staffId: Number(staffId), workDate }));
  const conflicts = [
    ...duplicateConflicts,
    ...(!input.overwrite ? existingConflicts : []),
  ];
  if (conflicts.length) {
    throw assignmentError('部分人员日期已有排班', 'SHIFT_ALREADY_EXISTS', 409, {
      conflicts,
    });
  }
  db.run('BEGIN');
  try {
    const rows = prepared.map((value) =>
      createAssignment(db, value, operatorUserId, { overwrite: Boolean(input.overwrite) })
    );
    db.run('COMMIT');
    return rows;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function updateAssignment(db, id, input, operatorUserId) {
  const current = queryOne(db, 'SELECT * FROM shift_assignments WHERE id = ?', [id]);
  if (!current) throw assignmentError('排班不存在', 'SHIFT_NOT_FOUND', 404);
  const value = prepareAssignment(db, input);
  const conflict = queryOne(
    db,
    'SELECT id FROM shift_assignments WHERE staff_id = ? AND work_date = ? AND id <> ?',
    [value.staffId, value.workDate, id]
  );
  if (conflict) {
    throw assignmentError('该人员当天已有排班', 'SHIFT_ALREADY_EXISTS', 409, {
      conflicts: [{ staffId: Number(value.staffId), workDate: value.workDate }],
    });
  }
  db.run(
    `UPDATE shift_assignments SET staff_id = ?, work_date = ?, assignment_type = ?,
     template_id = ?, start_at = ?, end_at = ?, leave_type = ?, note = ?,
     created_by = ?, updated_at = ? WHERE id = ?`,
    [value.staffId, value.workDate, value.assignmentType, value.templateId,
      value.startAt, value.endAt, value.leaveType, value.note, operatorUserId,
      new Date().toISOString(), id]
  );
  return queryOne(db, 'SELECT * FROM shift_assignments WHERE id = ?', [id]);
}

function listAssignments(db, filters = {}) {
  const where = [];
  const params = [];
  for (const [key, column] of [
    ['staffId', 'a.staff_id'], ['workDate', 'a.work_date'],
    ['dateFrom', 'a.work_date >='], ['dateTo', 'a.work_date <='],
    ['assignmentType', 'a.assignment_type'],
  ]) {
    const value = filters[key] ?? filters[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
    if (value !== undefined && value !== '') {
      if (column.includes(' ')) where.push(`${column} ?`);
      else where.push(`${column} = ?`);
      params.push(value);
    }
  }
  return queryAll(
    db,
    `SELECT a.*, t.name AS template_name, s.name AS staff_name
     FROM shift_assignments a
     LEFT JOIN shift_templates t ON t.id = a.template_id
     LEFT JOIN staff_profiles s ON s.id = a.staff_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.work_date, a.staff_id`,
    params
  );
}

module.exports = {
  resolveShiftWindow,
  validateAssignment,
  createAssignment,
  createBatchAssignments,
  updateAssignment,
  listAssignments,
};
