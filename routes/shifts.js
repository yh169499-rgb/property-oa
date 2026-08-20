const express = require('express');
const router = express.Router();
const database = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  resolveShiftWindow,
  validateAssignment,
  createAssignment,
  createBatchAssignments,
  updateAssignment,
  listAssignments,
} = require('../services/shifts');

function sendError(res, error) {
  res.status(error.status || 400).json({
    error: error.message || '请求失败',
    code: error.code || 'INVALID_REQUEST',
    ...(error.details ? { details: error.details } : {}),
  });
}

function one(sql, params) {
  const stmt = database.getDB().prepare(sql);
  stmt.bind(params || []);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params) {
  const stmt = database.getDB().prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function patchValue(body, camelKey, snakeKey, fallback) {
  if (Object.prototype.hasOwnProperty.call(body, camelKey)) return body[camelKey];
  if (Object.prototype.hasOwnProperty.call(body, snakeKey)) return body[snakeKey];
  return fallback;
}

function rejectClientTenant(req, res) {
  const source = { ...(req.query || {}), ...(req.body || {}) };
  if (!Object.hasOwn(source, 'tenant_id') && !Object.hasOwn(source, 'tenantId')) return false;
  res.status(400).json({
    error: '企业身份由服务端确定', code: 'CLIENT_TENANT_FORBIDDEN',
  });
  return true;
}

function templateInput(body, current = {}) {
  const value = {
    name: body.name ?? current.name,
    startTime: body.startTime ?? body.start_time ?? current.start_time,
    endTime: body.endTime ?? body.end_time ?? current.end_time,
    color: body.color ?? current.color ?? '',
    graceMinutes: body.graceMinutes ?? body.grace_minutes ?? current.grace_minutes ?? 5,
  };
  try {
    resolveShiftWindow('2000-01-01', value.startTime, value.endTime);
  } catch {
    value.invalidTime = true;
  }
  if (!value.name || value.invalidTime
      || !Number.isInteger(Number(value.graceMinutes)) || Number(value.graceMinutes) < 0) {
    const error = new Error('班次模板参数无效');
    error.code = 'INVALID_SHIFT_TEMPLATE';
    error.status = 400;
    throw error;
  }
  return value;
}

router.use(requireAuth, (req, res, next) => {
  if (rejectClientTenant(req, res)) return;
  next();
});

router.get('/shift-templates', requireAuth, (req, res) => {
  res.json({ data: all('SELECT * FROM shift_templates WHERE tenant_id = ? ORDER BY id',
    [req.user.tenant_id]) });
});

router.post('/shift-templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const value = templateInput(req.body);
    database.run(
      `INSERT INTO shift_templates
       (tenant_id, name, start_time, end_time, color, grace_minutes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.tenant_id, value.name, value.startTime, value.endTime, value.color,
        Number(value.graceMinutes), req.user.id]
    );
    await database.saveDB();
    res.status(201).json({ data: one(`SELECT * FROM shift_templates
      WHERE id = last_insert_rowid() AND tenant_id = ?`, [req.user.tenant_id]) });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/shift-templates/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const current = one('SELECT * FROM shift_templates WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.user.tenant_id]);
    if (!current) return res.status(404).json({ error: '班次模板不存在', code: 'SHIFT_TEMPLATE_NOT_FOUND' });
    const value = templateInput(req.body, current);
    database.run(
      `UPDATE shift_templates SET name = ?, start_time = ?, end_time = ?,
       color = ?, grace_minutes = ? WHERE id = ? AND tenant_id = ?`,
      [value.name, value.startTime, value.endTime, value.color,
        Number(value.graceMinutes), req.params.id, req.user.tenant_id]
    );
    await database.saveDB();
    res.json({ data: one('SELECT * FROM shift_templates WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.user.tenant_id]) });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/shift-templates/:id', requireAuth, requireAdmin, async (req, res) => {
  const current = one('SELECT id FROM shift_templates WHERE id = ? AND tenant_id = ?',
    [req.params.id, req.user.tenant_id]);
  if (!current) return res.status(404).json({ error: '班次模板不存在', code: 'SHIFT_TEMPLATE_NOT_FOUND' });
  const references = one(
    `SELECT COUNT(*) AS count FROM shift_assignments
      WHERE template_id = ? AND tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  if (Number(references && references.count) > 0) {
    return res.status(409).json({
      error: '该模板正在被排班使用，不能删除',
      code: 'SHIFT_TEMPLATE_IN_USE',
      details: { references: Number(references.count) },
    });
  }
  database.run('DELETE FROM shift_templates WHERE id = ? AND tenant_id = ?',
    [req.params.id, req.user.tenant_id]);
  await database.saveDB();
  return res.json({ success: true });
});

router.get('/shifts', requireAuth, (req, res) => {
  try {
    res.json({ data: listAssignments(database.getDB(), {
      ...req.query, tenantId: req.user.tenant_id,
    }) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/shifts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const row = createAssignment(database.getDB(), req.body, req.user.id, {
      tenantId: req.user.tenant_id,
    });
    await database.saveDB();
    res.status(201).json({ data: row });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/shifts/batch', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = createBatchAssignments(database.getDB(), req.body, req.user.id, {
      tenantId: req.user.tenant_id,
    });
    await database.saveDB();
    res.status(201).json({ data: rows });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/shifts/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const current = one('SELECT * FROM shift_assignments WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.user.tenant_id]);
    if (!current) return res.status(404).json({ error: '排班不存在', code: 'SHIFT_NOT_FOUND' });
    const value = validateAssignment({
      staffId: patchValue(req.body, 'staffId', 'staff_id', current.staff_id),
      workDate: patchValue(req.body, 'workDate', 'work_date', current.work_date),
      assignmentType: patchValue(
        req.body, 'assignmentType', 'assignment_type', current.assignment_type
      ),
      templateId: patchValue(req.body, 'templateId', 'template_id', current.template_id),
      startAt: patchValue(req.body, 'startAt', 'start_at', current.start_at),
      endAt: patchValue(req.body, 'endAt', 'end_at', current.end_at),
      leaveType: patchValue(req.body, 'leaveType', 'leave_type', current.leave_type),
      note: req.body.note ?? current.note,
    });
    const updated = updateAssignment(database.getDB(), current.id, value, req.user.id, {
      tenantId: req.user.tenant_id,
    });
    await database.saveDB();
    res.json({ data: updated });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/shifts/:id', requireAuth, requireAdmin, async (req, res) => {
  const current = one('SELECT id FROM shift_assignments WHERE id = ? AND tenant_id = ?',
    [req.params.id, req.user.tenant_id]);
  if (!current) return res.status(404).json({ error: '排班不存在', code: 'SHIFT_NOT_FOUND' });
  database.run('DELETE FROM shift_assignments WHERE id = ? AND tenant_id = ?',
    [req.params.id, req.user.tenant_id]);
  await database.saveDB();
  res.json({ success: true });
});

module.exports = router;
