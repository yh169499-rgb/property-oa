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
  recordTicketActivity,
  buildTicketTimeline,
} = require('../services/ticket-activity');
const { resolveCommunity } = require('../services/community-resolution');
const { getActiveRule } = require('../services/performance');
const { isSupervisorUser } = require('../services/roles');
const { sendTicketAlert, saveTenantAlertConfig } = require('../services/jzm-messaging');
const { resetTicketReminderState } = require('../services/ticket-reminders');
const { requireIntegrationToken, alertConfigFromBody } = require('../services/external-ingest');
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
    id: row.id, tenant_id: row.tenant_id || '', type: row.type, cat: row.cat, desc: row.desc, loc: row.loc,
    priority: row.priority, status: row.status, worker: row.worker || null,
    message: row.message || '', created: row.created, finished: row.finished || null,
    assignedAt: row.assigned_at || null,
    rejectReason: row.reject_reason || '', estimated_hours: row.estimated_hours || 0,
    sessionId: row.session_id || '', community_id: row.community_id || 'default',
    repeatOf: row.repeat_of || '', repeatCount: Number(row.repeat_count) || 1,
    isRecurring: Boolean(Number(row.is_recurring)), recurrenceNote: row.recurrence_note || '',
    feedbackCount: Number(row.feedback_count) || 1,
    performanceRuleVersionId: row.performance_rule_version_id == null ? null : Number(row.performance_rule_version_id),
    notes: meta.notes || [], urged: meta.urged || [],
    suspendReason: meta.suspendReason || '', suspendEstimate: meta.suspendEstimate || '',
    steps: buildTicketTimeline(getDB(), row),
    feedbackPerson: meta.feedbackPerson || meta.feedback_person || '',
    feedbackGroup: meta.feedbackGroup || meta.feedback_group || '',
    originalMessage: meta.originalMessage || meta.original_message || ''
  };
}

function notificationMetadata(input = {}) {
  const source = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const value = {
    ...source,
    feedbackPerson: input.feedback_person || input.feedbackPerson || source.feedbackPerson || source.feedback_person || '',
    feedbackGroup: input.feedback_group || input.feedbackGroup || input.group_name || input.groupName || source.feedbackGroup || source.feedback_group || '',
    originalMessage: input.original_message || input.originalMessage || source.originalMessage || source.original_message || '',
  };
  return JSON.stringify(value);
}

function safeMessagingIdentifier(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : '';
}

function safeMessagingError(error, fallbackCode) {
  const source = error && typeof error === 'object' ? error : {};
  const code = safeMessagingIdentifier(source.code) || fallbackCode;
  const safe = { code };
  if (Number.isInteger(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599) {
    safe.httpStatus = source.httpStatus;
  }
  if (Number.isFinite(source.errcode)) {
    safe.errcode = source.errcode;
  } else {
    const errcode = safeMessagingIdentifier(source.errcode);
    if (errcode) safe.errcode = errcode;
  }
  const requestId = safeMessagingIdentifier(source.requestId);
  if (requestId) safe.requestId = requestId;
  return safe;
}

function notifyTicketAlert(args) {
  sendTicketAlert(args).then((result) => {
    if (!result || result.success) return;
    console.warn('[秒回预警] 工单提醒未发送:', JSON.stringify(
      safeMessagingError(result.error, 'JZM_MESSAGE_SEND_FAILED')
    ));
  }).catch(() => {
    console.warn('[秒回预警] 工单提醒失败:', JSON.stringify({
      code: 'JZM_MESSAGE_UNEXPECTED_ERROR',
    }));
  });
}

function tableExists(name) {
  return Boolean(queryOne("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

function tableHasColumn(table, column) {
  return queryAll(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function clientTenantProvided(body) {
  return body && (
    Object.prototype.hasOwnProperty.call(body, 'tenant_id')
    || Object.prototype.hasOwnProperty.call(body, 'tenantId')
  );
}

function clientTenantError(res) {
  return res.status(400).json({
    error: '租户归属由服务端确定，客户端不得传入',
    code: 'CLIENT_TENANT_FORBIDDEN',
  });
}

// 秒回/外部模型有时使用 complain；系统内部统一使用 complaint，
// 这样报表、权限范围和提醒逻辑都只需要处理一个规范值。
function normalizeTicketType(value) {
  const type = String(value || 'repair').trim().toLowerCase();
  return type === 'complain' ? 'complaint' : type;
}

function ticketForTenant(req, ticketId) {
  if (!tableHasColumn('tickets', 'tenant_id')) {
    return queryOne('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  }
  return queryOne('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?', [ticketId, req.user.tenant_id]);
}

function ticketExists(ticketId) {
  return Boolean(queryOne('SELECT id FROM tickets WHERE id = ?', [ticketId]));
}

function writeTarget(req, res, ticketId) {
  const row = ticketForTenant(req, ticketId);
  if (row) return row;
  if (tableHasColumn('tickets', 'tenant_id') && ticketExists(ticketId)) {
    res.status(403).json({ error: '无权操作该工单', code: 'TICKET_SCOPE_FORBIDDEN' });
  } else {
    res.status(404).json({ error: '工单不存在' });
  }
  return null;
}

function communityError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function resolveTicketCommunity(db, body, tenantId) {
  if (!tableHasColumn('communities', 'tenant_id')) return resolveCommunity(db, body);
  const id = body.community_id == null ? '' : String(body.community_id).trim();
  const alias = body.communityId == null ? '' : String(body.communityId).trim();
  if (id && alias && id !== alias) {
    throw communityError('community_id 与 communityId 不一致', 'COMMUNITY_CONFLICT');
  }
  const requestedId = id || alias;
  if (requestedId) {
    const community = queryOne(
      'SELECT id, name FROM communities WHERE id = ? AND tenant_id = ?',
      [requestedId, tenantId]
    );
    if (!community) throw communityError('指定小区不存在', 'COMMUNITY_NOT_FOUND');
    return { id: community.id, name: community.name, resolution: 'explicit_id' };
  }
  const name = String(body.community_name || body.communityName || '').trim();
  if (name) {
    const matches = queryAll(
      'SELECT id, name FROM communities WHERE TRIM(name) = TRIM(?) AND tenant_id = ? ORDER BY created',
      [name, tenantId]
    );
    if (!matches.length) throw communityError('指定小区不存在', 'COMMUNITY_NOT_FOUND');
    if (matches.length > 1) throw communityError('小区名称不唯一，请改用小区 ID', 'COMMUNITY_AMBIGUOUS');
    return { id: matches[0].id, name: matches[0].name, resolution: 'explicit_name' };
  }
  const communities = queryAll(
    'SELECT id, name FROM communities WHERE tenant_id = ? ORDER BY created',
    [tenantId]
  );
  if (communities.length !== 1) throw communityError('多小区场景必须指定小区', 'COMMUNITY_REQUIRED');
  return { id: communities[0].id, name: communities[0].name, resolution: 'single_community' };
}

function activePerformanceRuleId(db, tenantId) {
  if (!tableExists('performance_rule_versions')) return null;
  if (!tableHasColumn('performance_rule_versions', 'tenant_id')) {
    return getActiveRule(db)?.id || null;
  }
  const active = queryOne(`SELECT id FROM performance_rule_versions
    WHERE tenant_id = ? AND is_active = 1 ORDER BY version_no DESC LIMIT 1`, [tenantId]);
  if (active) return Number(active.id);
  const latest = queryOne(`SELECT id FROM performance_rule_versions
    WHERE tenant_id = ? ORDER BY version_no DESC LIMIT 1`, [tenantId]);
  return latest ? Number(latest.id) : null;
}

function performanceRuleBelongsToTenant(ruleId, tenantId) {
  if (ruleId == null || ruleId === '') return true;
  if (!tableExists('performance_rule_versions')) return false;
  if (!tableHasColumn('performance_rule_versions', 'tenant_id')) {
    return Boolean(queryOne('SELECT id FROM performance_rule_versions WHERE id = ?', [ruleId]));
  }
  return Boolean(queryOne(
    'SELECT id FROM performance_rule_versions WHERE id = ? AND tenant_id = ?',
    [ruleId, tenantId]
  ));
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
    const tenantScope = tableHasColumn('community_memberships', 'tenant_id')
      && tableHasColumn('staff_profiles', 'tenant_id')
      ? ` AND COALESCE(cm.tenant_id, '') IN ('', ?)
          AND COALESCE(sp.tenant_id, '') IN ('', ?)`
      : '';
    const params = [req.user.id];
    if (tenantScope) params.push(req.user.tenant_id, req.user.tenant_id);
    queryAll(`SELECT DISTINCT community_id FROM community_memberships cm
      JOIN staff_profiles sp ON sp.id = cm.staff_profile_id
      WHERE sp.user_id = ? AND COALESCE(sp.employment_status, 'active') = 'active'${tenantScope}`, params)
      .forEach(row => ids.push(String(row.community_id)));
  }
  if (tableExists('community_permissions')) {
    const tenantScope = tableHasColumn('community_permissions', 'tenant_id') ? ' AND tenant_id = ?' : '';
    const params = tenantScope ? [req.user.name, req.user.tenant_id] : [req.user.name];
    queryAll(`SELECT DISTINCT community_id FROM community_permissions WHERE staff_name = ?${tenantScope}`, params)
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
  const row = ticketForTenant(req, ticketId);
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
function getRepeatMatches(tenantId, communityId, repeatKey, issueSignature) {
  const tenantAware = tableHasColumn('tickets', 'tenant_id');
  const candidates = tenantAware
    ? queryAll('SELECT * FROM tickets WHERE tenant_id = ? AND community_id = ? AND repeat_key = ? ORDER BY created DESC', [tenantId, communityId, repeatKey])
    : queryAll('SELECT * FROM tickets WHERE community_id = ? AND repeat_key = ? ORDER BY created DESC', [communityId, repeatKey]);
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

router.use((req, res, next) => {
  if (clientTenantProvided(req.query) || clientTenantProvided(req.body)) {
    return clientTenantError(res);
  }
  next();
});

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
  const scope = ticketReadScope(req, '', {
    hasTypeColumn: tableHasColumn('tickets', 'type'),
    hasTenantColumn: tableHasColumn('tickets', 'tenant_id'),
    // A pre-migration legacy table has no `type` column. Keep its historical
    // rows readable during the one-time migration; all current schemas carry
    // `type` and therefore require an exact tenant match.
    allowLegacyEmptyTenant: true,
  });
  const where = filters.length ? filters.join(' AND ') : '1 = 1';
  const rows = queryAll(
    `SELECT * FROM tickets WHERE ${where}${scope.sql} ORDER BY created DESC`,
    [...params, ...scope.params]
  );
  res.json({ data: rows.map(rowToTicket) });
});

// GET /api/tickets/:id
router.get('/:id', requireAuth, (req, res) => {
  const base = ticketForTenant(req, req.params.id);
  const row = base && req.query.community_id && String(base.community_id) !== String(req.query.community_id)
    ? null
    : base;
  if (!row || !canReadTicket(req, row)) return res.status(404).json({ error: '工单不存在' });
  res.json({ data: rowToTicket(row) });
});

// POST /api/tickets（外部接入路由必须在 /:id 之前声明）
router.post('/external', requireIntegrationToken, createTicket);
router.post('/', requireAuth, createTicket);

async function createTicket(req, res) {
  const t = req.body || {};
  if (clientTenantProvided(t)) return clientTenantError(res);
  const supervisor = isSupervisorUser(req.user);
  const external = Boolean(req.externalIntegration);
  let externalAlertConfig = null;
  if (external) {
    try { externalAlertConfig = alertConfigFromBody(t); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message, code: error.code || 'JZM_ALERT_CONFIG_INVALID' }); }
  }
  const type = normalizeTicketType(t.type);
  if (!STAFF_TICKET_TYPES.has(type)) {
    return res.status(400).json({ error: '工单类型不合法', code: 'INVALID_TICKET_TYPE' });
  }
  let community;
  try { community = resolveTicketCommunity(getDB(), t, req.user.tenant_id); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message, code: error.code || 'COMMUNITY_INVALID' }); }
  try { assertCommunityAccess(req, community.id); }
  catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
  if (externalAlertConfig) {
    try {
      saveTenantAlertConfig(getDB(), req.user.tenant_id, externalAlertConfig);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message, code: error.code || 'JZM_ALERT_CONFIG_INVALID' });
    }
  }
  // 外部系统不能覆盖内部编号、状态、优先级、处理人或创建时间，避免伪造历史数据。
  const rawId = supervisor && !external && t.id ? String(t.id).trim() : '';
  const invalidIds = ['测试', 'test', ''];
  let id;
  if (rawId && !invalidIds.includes(rawId.toLowerCase())) { id = rawId; }
  else {
    const maxRow = queryOne("SELECT id FROM tickets WHERE id LIKE 'WX%' ORDER BY CAST(SUBSTR(id, 3) AS INTEGER) DESC LIMIT 1");
    const maxNum = maxRow ? parseInt(maxRow.id.replace('WX', '')) || 0 : 0;
    id = 'WX' + String(maxNum + 1).padStart(4, '0');
  }
  const now = supervisor && !external && t.created ? t.created : new Date().toISOString();
  const communityId = community.id;
  const cat = t.cat || '其他';
  const loc = t.loc || '';
  const requestedStatus = supervisor && !external ? String(t.status || 'wait') : 'wait';
  if (!['wait', 'doing'].includes(requestedStatus)) {
    return res.status(400).json({ error: '工单初始状态不合法', code: 'INVALID_TICKET_INITIAL_STATE' });
  }
  const requestedPriority = supervisor && !external ? String(t.priority || 'normal') : 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(requestedPriority)) {
    return res.status(400).json({ error: '工单优先级不合法', code: 'INVALID_TICKET_PRIORITY' });
  }
  let assignee = null;
  const requestedWorker = supervisor && !external ? String(t.worker || '').trim() : '';
  if (requestedWorker) {
    try { assignee = resolveAssignee(getDB(), requestedWorker, req.user.id, req.user.tenant_id); }
    catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
  }
  if (requestedStatus === 'doing' && !assignee) {
    return res.status(400).json({ error: '处理中工单必须指定处理人', code: 'INVALID_TICKET_INITIAL_STATE' });
  }
  const repeatKey = buildRepeatKey(type, cat, loc);
  const issueSignature = identifyIssueSignature(cat, t.desc, t.message);
  const matches = getRepeatMatches(req.user.tenant_id, communityId, repeatKey, issueSignature);
  const createdMs = Date.parse(now) || Date.now();

  // 15分钟内同类未完成 → 合并
  const recentOpen = matches.find(row => {
    const delta = createdMs - Date.parse(row.created);
    return row.status !== 'done' && Number.isFinite(delta) && delta >= 0 && delta <= DUPLICATE_WINDOW_MS;
  });
  if (recentOpen) {
    const feedbackCount = (Number(recentOpen.feedback_count) || 1) + 1;
    const tenantSql = tableHasColumn('tickets', 'tenant_id') ? ' AND tenant_id = ?' : '';
    const tenantParams = tenantSql ? [req.user.tenant_id] : [];
    run(`UPDATE tickets SET feedback_count = ?, repeat_key = ? WHERE id = ?${tenantSql}`,
      [feedbackCount, repeatKey, recentOpen.id, ...tenantParams]);
    await saveDB();
    const mergedTicket = rowToTicket(ticketForTenant(req, recentOpen.id));
    if (external) return res.json({ success: true });
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
  const metadata = notificationMetadata(t);

  let transactionStarted = false;
  try {
    const db = getDB();
    db.run('BEGIN');
    transactionStarted = true;
    const tenantAware = tableHasColumn('tickets', 'tenant_id');
    const tenantColumn = tenantAware ? 'tenant_id, ' : '';
    const tenantPlaceholder = tenantAware ? '?, ' : '';
    const values = [id, type, cat, t.desc || '', loc, priority, requestedStatus,
      assignee ? assignee.displayName : '', t.message || '', now,
      supervisor && !external ? (t.estimated_hours || 0) : 0,
      supervisor && !external ? (t.sessionId || '') : '', communityId, repeatKey, repeatOf,
      repeatCount, isRecurring ? 1 : 0, recurrenceNote, 1,
      activePerformanceRuleId(getDB(), req.user.tenant_id),
      assignee ? assignee.assigneeUserId : null,
      assignee ? assignee.assigneeStaffProfileId : null,
      assignee ? now : '',
      metadata];
    if (tenantAware) values.unshift(req.user.tenant_id);
    run(
      `INSERT INTO tickets (${tenantColumn}id, type, cat, desc, loc, priority, status, worker, message,
        created, estimated_hours, session_id, community_id, repeat_key, repeat_of,
        repeat_count, is_recurring, recurrence_note, feedback_count,
        performance_rule_version_id, assignee_user_id, assignee_staff_profile_id, assigned_at, metadata)
       VALUES (${tenantPlaceholder}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values);
    if (tableExists('ticket_activity_logs')) {
      recordTicketActivity(db, {
        tenantId: req.user.tenant_id,
        ticketId: id,
        actorUserId: req.user.id,
        actorStaffId: null,
        action: 'create',
        metadata: { type, cat, community_id: communityId },
        createdAt: now,
      });
    }
    db.run('COMMIT');
    transactionStarted = false;
    await saveDB();
    const row = ticketForTenant(req, id);
    const ticket = rowToTicket(row);
    notifyTicketAlert({
      db: getDB(), tenantId: req.user.tenant_id, kind: 'created', ticket, actor: req.user, assignee,
    });
    if (external) return res.json({ success: true });
    res.json({ success: true, action: isRecurring ? 'created_recurring' : 'created', community_resolution: community, record: ticket });
  } catch (e) {
    if (transactionStarted) {
      try { getDB().run('ROLLBACK'); } catch (_) {}
    }
    res.status(500).json({ error: e.message });
  }
}

// PATCH /api/tickets/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const updates = { ...(req.body || {}) };
  if (updates.worker !== undefined) updates.worker = String(updates.worker || '').trim();
  if (clientTenantProvided(updates)) return clientTenantError(res);
  if (updates._action !== undefined && updates._action !== 'urge') {
    return res.status(400).json({ error: '不支持的工单动作' });
  }
  const db = getDB();
  const before = writeTarget(req, res, req.params.id);
  if (!before) return;
  try { assertTicketMutation(req, before, updates); }
  catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
  if (updates.performance_rule_version_id !== undefined
      && !performanceRuleBelongsToTenant(updates.performance_rule_version_id, req.user.tenant_id)) {
    return res.status(400).json({
      error: '绩效规则版本不存在',
      code: 'PERFORMANCE_RULE_NOT_FOUND',
    });
  }
  const action = detectTicketAction(before, updates);
  let assignee = null;
  const allowed = { status: 'status', worker: 'worker', priority: 'priority', finished: 'finished', reject_reason: 'reject_reason', rejectReason: 'reject_reason', estimated_hours: 'estimated_hours', cat: 'cat', loc: 'loc', desc: 'desc', message: 'message', sessionId: 'session_id', metadata: 'metadata', performance_rule_version_id: 'performance_rule_version_id' };
  const sets = [], values = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (updates[key] !== undefined) { sets.push(`${col} = ?`); values.push(updates[key]); }
  }
  if (updates.worker !== undefined &&
      (updates.worker !== before.worker || before.assignee_user_id == null || before.assignee_staff_profile_id == null)) {
    const workerName = String(updates.worker || '').trim();
    if (workerName) {
      try { assignee = resolveAssignee(db, workerName, req.user.id, req.user.tenant_id); }
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
      values.push(activePerformanceRuleId(db, req.user.tenant_id));
    }
  }
  let community = null;
  if (Object.prototype.hasOwnProperty.call(updates, 'community_id')
      || Object.prototype.hasOwnProperty.call(updates, 'communityId')
      || Object.prototype.hasOwnProperty.call(updates, 'community_name')
      || Object.prototype.hasOwnProperty.call(updates, 'communityName')) {
    try { community = resolveTicketCommunity(db, updates, req.user.tenant_id); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message, code: error.code || 'COMMUNITY_INVALID' }); }
    try { assertCommunityAccess(req, community.id); }
    catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
    sets.push('community_id = ?');
    values.push(community.id);
  }
  if (!sets.length) return res.status(400).json({ error: '无更新字段' });
  values.push(req.params.id);
  const tenantAware = tableHasColumn('tickets', 'tenant_id');
  if (tenantAware) values.push(req.user.tenant_id);
  let transactionStarted = false;
  try {
    db.run('BEGIN');
    transactionStarted = true;
    run(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?${tenantAware ? ' AND tenant_id = ?' : ''}`, values);
    if (req.user && action) {
      const profileTenantAware = tableHasColumn('staff_profiles', 'tenant_id');
      const actorProfile = queryOne(
        `SELECT id FROM staff_profiles WHERE user_id = ?${profileTenantAware ? " AND COALESCE(tenant_id, '') IN ('', ?)" : ''}`,
        profileTenantAware ? [req.user.id, req.user.tenant_id] : [req.user.id]
      );
      recordTicketActivity(db, {
        tenantId: req.user.tenant_id,
        ticketId: req.params.id,
        actorUserId: req.user.id,
        actorStaffId: actorProfile ? actorProfile.id : null,
        action,
        metadata: updates,
        createdAt: new Date().toISOString()
      });
    }
    if (updates.status !== undefined && updates.status !== before.status
        && tableExists('ticket_reminder_state')) {
      resetTicketReminderState(db, req.user.tenant_id, req.params.id);
    }
    db.run('COMMIT');
    transactionStarted = false;
    await saveDB();
    const row = ticketForTenant(req, req.params.id);
    if (!row) return res.status(404).json({ error: '工单不存在' });
    const ticket = rowToTicket(row);
    if (assignee && (action === 'assign' || before.worker !== ticket.worker)) {
      notifyTicketAlert({
        db: getDB(), tenantId: req.user.tenant_id, kind: 'assigned', ticket, actor: req.user, assignee,
      });
    }
    if (updates.status === 'done' && before.status !== 'done') {
      notifyTicketAlert({
        db: getDB(), tenantId: req.user.tenant_id, kind: 'completed', ticket, actor: req.user,
        assignee: assignee || { displayName: ticket.worker, name: ticket.worker },
      });
    }
    const managerAlertKind = {
      submit: 'submitted',
      return: 'returned',
      suspend: 'suspended',
    }[action];
    if (managerAlertKind) {
      notifyTicketAlert({
        db: getDB(), tenantId: req.user.tenant_id, kind: managerAlertKind,
        ticket, actor: req.user,
        assignee: { displayName: ticket.worker, name: ticket.worker },
      });
    }
    res.json({ success: true, community_resolution: community, record: ticket });
  } catch (e) {
    if (transactionStarted) {
      try { db.run('ROLLBACK'); } catch (rollbackError) {}
    }
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tickets/:id (admin only)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const ticket = writeTarget(req, res, req.params.id);
  if (!ticket) return;
  const tenantAware = tableHasColumn('tickets', 'tenant_id');
  run(`DELETE FROM tickets WHERE id = ?${tenantAware ? ' AND tenant_id = ?' : ''}`,
    tenantAware ? [req.params.id, req.user.tenant_id] : [req.params.id]);
  await saveDB();
  res.json({ success: true });
});

// POST /api/tickets/:id/photos
router.post('/:id/photos', requireAuth, (req, res, next) => {
  const ticketId = req.params.id;
  if (!safeTicketId(ticketId)) return res.status(400).json({ error: '工单编号不合法', code: 'INVALID_TICKET_ID' });
  const row = ticketForTenant(req, ticketId);
  if (!row) {
    if (tableHasColumn('tickets', 'tenant_id') && ticketExists(ticketId)) {
      return res.status(403).json({ error: '无权操作该工单', code: 'TICKET_SCOPE_FORBIDDEN' });
    }
    return res.status(404).json({ error: '工单不存在' });
  }
  if (!canReadTicket(req, row)) return res.status(404).json({ error: '工单不存在' });
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
  const ticket = ticketForTenant(req, req.params.id);
  if (!ticket || !canReadTicket(req, ticket)) return res.status(404).json({ error: '工单不存在' });
  const photoFile = path.join(config.UPLOAD_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(photoFile)) return res.json({ data: [] });
  try { res.json({ data: JSON.parse(fs.readFileSync(photoFile, 'utf-8')) }); }
  catch(e) { res.json({ data: [] }); }
});

module.exports = router;
module.exports.canAccessTicket = canAccessTicket;
