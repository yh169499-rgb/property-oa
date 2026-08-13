/**
 * 工单路由
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { queryAll, queryOne, run, saveDB, getDB } = require('../db');
const config = require('../config');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  detectTicketAction,
  resolveAssignee,
  recordTicketActivity
} = require('../services/ticket-activity');
const { resolveCommunity } = require('../services/community-resolution');
const { getActiveRule } = require('../services/performance');
const { isSupervisorUser } = require('../services/roles');
const {
  STAFF_TICKET_TYPES,
  ticketReadScope,
  canReadTicket,
  assertTicketMutation,
} = require('../services/ticket-access');

// 上传配置
if (!fs.existsSync(config.UPLOAD_DIR)) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ticketId = safeTicketId(req.params.id);
    if (!ticketId) return cb(new Error('工单编号不合法'));
    const ticketDir = path.join(config.UPLOAD_DIR, ticketId);
    if (!fs.existsSync(ticketDir)) fs.mkdirSync(ticketDir, { recursive: true });
    cb(null, ticketDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']);
    if (!allowed.has(ext)) return cb(new Error('仅支持图片或 PDF 文件'));
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const ALLOWED_UPLOAD_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
]);
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_UPLOAD_MIMES.has(String(file.mimetype || '').toLowerCase())),
});

function rowToTicket(row) {
  var meta = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch(e) {}
  return {
    id: row.id, type: row.type, cat: row.cat, desc: row.desc, loc: row.loc,
    priority: row.priority, status: row.status, worker: row.worker || null,
    message: row.message || '', created: row.created, finished: row.finished || null,
    rejectReason: row.reject_reason || '', estimated_hours: row.estimated_hours || 0,
    sessionId: row.session_id || '', community_id: row.community_id || 'default',
    repeatOf: row.repeat_of || '', repeatCount: Number(row.repeat_count) || 1,
    isRecurring: Boolean(Number(row.is_recurring)), recurrenceNote: row.recurrence_note || '',
    feedbackCount: Number(row.feedback_count) || 1,
    performanceRuleVersionId: row.performance_rule_version_id == null ? null : Number(row.performance_rule_version_id),
    notes: meta.notes || [], urged: meta.urged || [],
    suspendReason: meta.suspendReason || '', suspendEstimate: meta.suspendEstimate || '',
    steps: meta.steps || []
  };
}

function tableExists(name) {
  return Boolean(queryOne("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

function tableHasColumn(table, column) {
  return queryAll(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function safeTicketId(value) {
  const id = String(value || '');
  if (!id || id === '.' || id === '..' || id.includes('\0') || id.includes('/') || id.includes('\\')) return null;
  return id;
}

function accessibleCommunityIds(req) {
  if (isSupervisorUser(req.user)) return null;
  const ids = [];
  if (tableExists('community_memberships') && tableExists('staff_profiles')) {
    queryAll(`SELECT DISTINCT community_id FROM community_memberships cm
      JOIN staff_profiles sp ON sp.id = cm.staff_profile_id
      WHERE sp.user_id = ? AND COALESCE(sp.employment_status, 'active') = 'active'`, [req.user.id])
      .forEach(row => ids.push(String(row.community_id)));
  }
  if (tableExists('community_permissions')) {
    queryAll('SELECT DISTINCT community_id FROM community_permissions WHERE staff_name = ?', [req.user.name])
      .forEach(row => ids.push(String(row.community_id)));
  }
  return [...new Set(ids.length ? ids : ['default'])];
}

function assertCommunityAccess(req, communityId) {
  const ids = accessibleCommunityIds(req);
  if (ids !== null && !ids.includes(String(communityId))) {
    const error = new Error('无权访问该小区');
    error.status = 403;
    error.code = 'COMMUNITY_SCOPE_FORBIDDEN';
    throw error;
  }
}

function canAccessTicket(req, ticketId) {
  // Legacy installations may not have the stable assignee columns until the
  // startup migration completes. SELECT * keeps this guard non-throwing; the
  // missing identity is then rejected by canReadTicket for ordinary staff.
  const row = queryOne('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  return canReadTicket(req, row);
}

// ============ 重复/复发识别工具 ============
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const RECURRENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeLoc(loc) { return (loc || '').replace(/\s+/g, '').replace(/[—–-]/g, '-').toLowerCase(); }
function buildRepeatKey(type, cat, loc) { return [type, cat, normalizeLoc(loc)].join('|'); }
function identifyIssueSignature(cat, desc, message) {
  const text = [cat, desc, message].join(' ').toLowerCase();
  const keywords = ['漏水','水压低','停水','堵塞','跳闸','断电','短路','噪音','松动','脱轨','损坏','不热','漏风','失灵','不亮'];
  const matched = keywords.filter(k => text.includes(k));
  return matched.length ? matched.sort().join(',') : cat;
}
function getRepeatMatches(communityId, repeatKey, issueSignature) {
  const candidates = queryAll('SELECT * FROM tickets WHERE community_id = ? AND repeat_key = ? ORDER BY created DESC', [communityId, repeatKey]);
  return candidates.filter(row => {
    const rSig = identifyIssueSignature(row.cat, row.desc, row.message);
    return rSig === issueSignature;
  });
}
function raiseRecurringPriority(p) {
  const order = ['low','normal','high','urgent'];
  const idx = order.indexOf(p);
  return idx < order.length - 1 ? order[idx + 1] : p;
}

// GET /api/tickets
router.get('/', requireAuth, (req, res) => {
  const communityId = req.query.community_id || req.query.communityId || req.query.community;
  const filters = [];
  const params = [];
  for (const [column, value] of [
    ['type', req.query.type],
    ['worker', req.query.worker],
    ['community_id', communityId],
  ]) {
    if (value !== undefined && value !== '') {
      filters.push(`${column} = ?`);
      params.push(value);
    }
  }
  // A pre-migration ticket table can lack `type`; preserve its historical
  // repair-like list behavior while current schemas enforce the type scope.
  const scope = ticketReadScope(req, '', { hasTypeColumn: tableHasColumn('tickets', 'type') });
  const where = filters.length ? filters.join(' AND ') : '1 = 1';
  const rows = queryAll(
    `SELECT * FROM tickets WHERE ${where}${scope.sql} ORDER BY created DESC`,
    [...params, ...scope.params]
  );
  res.json({ data: rows.map(rowToTicket) });
});

// GET /api/tickets/:id
router.get('/:id', requireAuth, (req, res) => {
  const row = req.query.community_id
    ? queryOne('SELECT * FROM tickets WHERE id = ? AND community_id = ?', [req.params.id, req.query.community_id])
    : queryOne('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  if (!row || !canReadTicket(req, row)) return res.status(404).json({ error: '工单不存在' });
  res.json({ data: rowToTicket(row) });
});

// POST /api/tickets
router.post('/', requireAuth, async (req, res) => {
  const t = req.body || {};
  const supervisor = isSupervisorUser(req.user);
  const type = String(t.type || 'repair').trim().toLowerCase();
  if (!STAFF_TICKET_TYPES.has(type)) {
    return res.status(400).json({ error: '工单类型不合法', code: 'INVALID_TICKET_TYPE' });
  }
  let community;
  try { community = resolveCommunity(getDB(), t); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message, code: error.code || 'COMMUNITY_INVALID' }); }
  try { assertCommunityAccess(req, community.id); }
  catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
  const rawId = supervisor && t.id ? String(t.id).trim() : '';
  const invalidIds = ['测试', 'test', ''];
  let id;
  if (rawId && !invalidIds.includes(rawId.toLowerCase())) { id = rawId; }
  else {
    const maxRow = queryOne("SELECT id FROM tickets WHERE id LIKE 'WX%' ORDER BY CAST(SUBSTR(id, 3) AS INTEGER) DESC LIMIT 1");
    const maxNum = maxRow ? parseInt(maxRow.id.replace('WX', '')) || 0 : 0;
    id = 'WX' + String(maxNum + 1).padStart(4, '0');
  }
  const now = supervisor && t.created ? t.created : new Date().toISOString();
  const communityId = community.id;
  const cat = t.cat || '其他';
  const loc = t.loc || '';
  const requestedStatus = supervisor ? String(t.status || 'wait') : 'wait';
  if (!['wait', 'doing'].includes(requestedStatus)) {
    return res.status(400).json({ error: '工单初始状态不合法', code: 'INVALID_TICKET_INITIAL_STATE' });
  }
  const requestedPriority = supervisor ? String(t.priority || 'normal') : 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(requestedPriority)) {
    return res.status(400).json({ error: '工单优先级不合法', code: 'INVALID_TICKET_PRIORITY' });
  }
  let assignee = null;
  const requestedWorker = supervisor ? String(t.worker || '').trim() : '';
  if (requestedWorker) {
    try { assignee = resolveAssignee(getDB(), requestedWorker, req.user.id); }
    catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
  }
  if (requestedStatus === 'doing' && !assignee) {
    return res.status(400).json({ error: '处理中工单必须指定处理人', code: 'INVALID_TICKET_INITIAL_STATE' });
  }
  const repeatKey = buildRepeatKey(type, cat, loc);
  const issueSignature = identifyIssueSignature(cat, t.desc, t.message);
  const matches = getRepeatMatches(communityId, repeatKey, issueSignature);
  const createdMs = Date.parse(now) || Date.now();

  // 15分钟内同类未完成 → 合并
  const recentOpen = matches.find(row => {
    const delta = createdMs - Date.parse(row.created);
    return row.status !== 'done' && Number.isFinite(delta) && delta >= 0 && delta <= DUPLICATE_WINDOW_MS;
  });
  if (recentOpen) {
    const feedbackCount = (Number(recentOpen.feedback_count) || 1) + 1;
    run('UPDATE tickets SET feedback_count = ?, repeat_key = ? WHERE id = ?', [feedbackCount, repeatKey, recentOpen.id]);
    await saveDB();
    const mergedTicket = rowToTicket(queryOne('SELECT * FROM tickets WHERE id = ?', [recentOpen.id]));
    return res.json({ success: true, action: 'merged', merged: true, mergedInto: recentOpen.id, record: mergedTicket });
  }

  // 30天内同类已完成 → 复发
  const completedMatches = matches.filter(row => {
    const delta = createdMs - Date.parse(row.created);
    return row.status === 'done' && Number.isFinite(delta) && delta >= 0 && delta <= RECURRENCE_WINDOW_MS;
  });
  const repeatOf = completedMatches.length ? completedMatches[0].id : '';
  const repeatCount = completedMatches.length + 1;
  const isRecurring = Boolean(repeatOf);
  const recurrenceNote = isRecurring ? `近30天同类问题复发${repeatCount}次，关联历史工单${repeatOf}` : '';
  const priority = isRecurring ? raiseRecurringPriority(requestedPriority) : requestedPriority;

  try {
    run(
      `INSERT INTO tickets (id, type, cat, desc, loc, priority, status, worker, message,
        created, estimated_hours, session_id, community_id, repeat_key, repeat_of,
        repeat_count, is_recurring, recurrence_note, feedback_count,
        performance_rule_version_id, assignee_user_id, assignee_staff_profile_id, assigned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, type, cat, t.desc || '', loc, priority, requestedStatus,
        assignee ? assignee.displayName : '', t.message || '', now,
        supervisor ? (t.estimated_hours || 0) : 0,
        supervisor ? (t.sessionId || '') : '', communityId, repeatKey, repeatOf,
        repeatCount, isRecurring ? 1 : 0, recurrenceNote, 1,
        getActiveRule(getDB())?.id || null,
        assignee ? assignee.assigneeUserId : null,
        assignee ? assignee.assigneeStaffProfileId : null,
        assignee ? now : '']
    );
    await saveDB();
    const row = queryOne('SELECT * FROM tickets WHERE id = ?', [id]);
    const ticket = rowToTicket(row);
    res.json({ success: true, action: isRecurring ? 'created_recurring' : 'created', community_resolution: community, record: ticket });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tickets/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const updates = req.body;
  if (updates._action !== undefined && updates._action !== 'urge') {
    return res.status(400).json({ error: '不支持的工单动作' });
  }
  const db = getDB();
  const before = queryOne('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  if (!before) return res.status(404).json({ error: '工单不存在' });
  try { assertTicketMutation(req, before, updates); }
  catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
  const action = detectTicketAction(before, updates);
  const allowed = { status: 'status', worker: 'worker', priority: 'priority', finished: 'finished', reject_reason: 'reject_reason', rejectReason: 'reject_reason', estimated_hours: 'estimated_hours', cat: 'cat', loc: 'loc', desc: 'desc', message: 'message', sessionId: 'session_id', metadata: 'metadata', performance_rule_version_id: 'performance_rule_version_id' };
  const sets = [], values = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (updates[key] !== undefined) { sets.push(`${col} = ?`); values.push(updates[key]); }
  }
  if (updates.worker !== undefined &&
      (updates.worker !== before.worker || before.assignee_user_id == null || before.assignee_staff_profile_id == null)) {
    const workerName = String(updates.worker || '').trim();
    let assignee = null;
    if (workerName) {
      try { assignee = resolveAssignee(db, workerName, req.user.id); }
      catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
    }
    sets.push('assignee_user_id = ?', 'assignee_staff_profile_id = ?', 'assigned_at = ?');
    values.push(
      assignee ? assignee.assigneeUserId : null,
      assignee ? assignee.assigneeStaffProfileId : null,
      assignee ? new Date().toISOString() : null
    );
    if (assignee && updates.worker !== assignee.displayName) {
      const workerSetIndex = sets.indexOf('worker = ?');
      if (workerSetIndex >= 0) values[workerSetIndex] = assignee.displayName;
    }
    if (workerName && before.performance_rule_version_id == null) {
      sets.push('performance_rule_version_id = ?');
      values.push(getActiveRule(db)?.id || null);
    }
  }
  let community = null;
  if (Object.prototype.hasOwnProperty.call(updates, 'community_id')
      || Object.prototype.hasOwnProperty.call(updates, 'communityId')
      || Object.prototype.hasOwnProperty.call(updates, 'community_name')
      || Object.prototype.hasOwnProperty.call(updates, 'communityName')) {
    try { community = resolveCommunity(db, updates); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message, code: error.code || 'COMMUNITY_INVALID' }); }
    try { assertCommunityAccess(req, community.id); }
    catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
    sets.push('community_id = ?');
    values.push(community.id);
  }
  if (!sets.length) return res.status(400).json({ error: '无更新字段' });
  values.push(req.params.id);
  let transactionStarted = false;
  try {
    db.run('BEGIN');
    transactionStarted = true;
    run(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, values);
    if (req.user && action) {
      const actorProfile = queryOne(
        'SELECT id FROM staff_profiles WHERE user_id = ?',
        [req.user.id]
      );
      recordTicketActivity(db, {
        ticketId: req.params.id,
        actorUserId: req.user.id,
        actorStaffId: actorProfile ? actorProfile.id : null,
        action,
        metadata: updates,
        createdAt: new Date().toISOString()
      });
    }
    db.run('COMMIT');
    transactionStarted = false;
    await saveDB();
    const row = queryOne('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '工单不存在' });
    res.json({ success: true, community_resolution: community, record: rowToTicket(row) });
  } catch (e) {
    if (transactionStarted) {
      try { db.run('ROLLBACK'); } catch (rollbackError) {}
    }
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tickets/:id (admin only)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  run('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  await saveDB();
  res.json({ success: true });
});

// POST /api/tickets/:id/photos
router.post('/:id/photos', requireAuth, (req, res, next) => {
  const ticketId = req.params.id;
  if (!safeTicketId(ticketId)) return res.status(400).json({ error: '工单编号不合法', code: 'INVALID_TICKET_ID' });
  const row = queryOne('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!row || !canReadTicket(req, row)) return res.status(404).json({ error: '工单不存在' });
  req.ticketRow = row;
  next();
}, upload.array('photos', 10), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: '没有上传文件' });
  const ticketId = req.params.id;
  const photos = req.files.map(f => ({
    filename: f.filename, originalName: f.originalname,
    url: `/uploads/${ticketId}/${f.filename}`, size: f.size, uploadedAt: new Date().toISOString()
  }));
  const photoFile = path.join(config.UPLOAD_DIR, `${ticketId}.json`);
  let savedPhotos = [];
  if (fs.existsSync(photoFile)) { try { savedPhotos = JSON.parse(fs.readFileSync(photoFile, 'utf-8')); } catch(e) {} }
  savedPhotos.push(...photos);
  fs.writeFileSync(photoFile, JSON.stringify(savedPhotos, null, 2));
  res.json({ success: true, ticketId, uploaded: photos.length, totalPhotos: savedPhotos.length, photos: savedPhotos });
});

// GET /api/tickets/:id/photos
router.get('/:id/photos', requireAuth, (req, res) => {
  if (!safeTicketId(req.params.id)) return res.status(400).json({ error: '工单编号不合法', code: 'INVALID_TICKET_ID' });
  const ticket = queryOne('SELECT community_id, assignee_user_id FROM tickets WHERE id = ?', [req.params.id]);
  if (!ticket || !canReadTicket(req, ticket)) return res.status(404).json({ error: '工单不存在' });
  const photoFile = path.join(config.UPLOAD_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(photoFile)) return res.json({ data: [] });
  try { res.json({ data: JSON.parse(fs.readFileSync(photoFile, 'utf-8')) }); }
  catch(e) { res.json({ data: [] }); }
});

module.exports = router;
module.exports.canAccessTicket = canAccessTicket;
