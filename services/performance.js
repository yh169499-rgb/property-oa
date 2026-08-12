const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const COMPONENTS = [
  { key: 'completion', weight: 'completion_weight', label: '完成率' },
  { key: 'onTime', weight: 'on_time_weight', label: '准时率' },
  { key: 'quality', weight: 'quality_weight', label: '质量分' },
];

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function invalidRule(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'INVALID_PERFORMANCE_RULE';
  return error;
}

function invalidDate(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'INVALID_DATE_RANGE';
  return error;
}

function value(input, snake, camel, fallback) {
  if (input && input[snake] !== undefined) return input[snake];
  if (input && input[camel] !== undefined) return input[camel];
  return fallback;
}

function validateRule(input = {}) {
  const rule = {
    name: String(value(input, 'name', 'name', '') || '').trim(),
    completion_weight: Number(value(input, 'completion_weight', 'completionWeight', NaN)),
    on_time_weight: Number(value(input, 'on_time_weight', 'onTimeWeight', NaN)),
    quality_weight: Number(value(input, 'quality_weight', 'qualityWeight', NaN)),
    excellent_threshold: Number(value(input, 'excellent_threshold', 'excellentThreshold', NaN)),
    good_threshold: Number(value(input, 'good_threshold', 'goodThreshold', NaN)),
    qualified_threshold: Number(value(input, 'qualified_threshold', 'qualifiedThreshold', NaN)),
    minimum_sample_size: Number(value(input, 'minimum_sample_size', 'minimumSampleSize', NaN)),
  };
  const weights = [rule.completion_weight, rule.on_time_weight, rule.quality_weight];
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 100)
      || Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 100) > 0.001) {
    throw invalidRule('绩效权重必须在0到100之间且总和为100');
  }
  if (![rule.excellent_threshold, rule.good_threshold, rule.qualified_threshold]
    .every((threshold) => Number.isFinite(threshold) && threshold >= 0 && threshold <= 100)
    || !(rule.excellent_threshold > rule.good_threshold
      && rule.good_threshold > rule.qualified_threshold)) {
    throw invalidRule('绩效阈值必须满足优秀 > 良好 > 合格');
  }
  if (!Number.isInteger(rule.minimum_sample_size) || rule.minimum_sample_size < 0) {
    throw invalidRule('最小样本数必须为不小于0的整数');
  }
  return rule;
}

function normalizeRule(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    version_no: Number(row.version_no),
    version: Number(row.version_no),
    completion_weight: Number(row.completion_weight),
    on_time_weight: Number(row.on_time_weight),
    quality_weight: Number(row.quality_weight),
    excellent_threshold: Number(row.excellent_threshold),
    good_threshold: Number(row.good_threshold),
    qualified_threshold: Number(row.qualified_threshold),
    minimum_sample_size: Number(row.minimum_sample_size),
    is_active: Number(row.is_active || 0),
  };
}

function tableExists(db, table) {
  return rows(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length > 0;
}

function listRuleVersions(db) {
  const versions = rows(db, 'SELECT * FROM performance_rule_versions ORDER BY version_no ASC')
    .map(normalizeRule);
  if (!tableExists(db, 'tickets')) {
    return versions.map((rule) => ({ ...rule, sample_size: 0, sampleSize: 0 }));
  }
  return versions.map((rule) => ({
    ...rule,
    sample_size: Number(one(db,
      'SELECT COUNT(DISTINCT id) count FROM tickets WHERE performance_rule_version_id = ?',
      [rule.id])?.count || 0),
    sampleSize: Number(one(db,
      'SELECT COUNT(DISTINCT id) count FROM tickets WHERE performance_rule_version_id = ?',
      [rule.id])?.count || 0),
  }));
}

function getActiveRule(db) {
  const active = one(db, `
    SELECT * FROM performance_rule_versions
    WHERE is_active = 1 ORDER BY version_no DESC LIMIT 1
  `);
  return normalizeRule(active) || normalizeRule(one(db,
    'SELECT * FROM performance_rule_versions ORDER BY version_no DESC LIMIT 1'));
}

function createRuleVersion(db, input, actorId) {
  const rule = validateRule(input);
  const existing = one(db, 'SELECT COALESCE(MAX(version_no), 0) max_version FROM performance_rule_versions');
  const versionNo = Number(existing?.max_version || 0) + 1;
  const now = new Date().toISOString();
  db.run('BEGIN');
  try {
    db.run('UPDATE performance_rule_versions SET is_active = 0 WHERE is_active = 1');
    db.run(`
      INSERT INTO performance_rule_versions (
        version_no, name, completion_weight, on_time_weight, quality_weight,
        excellent_threshold, good_threshold, qualified_threshold,
        minimum_sample_size, effective_at, created_by_user_id, created_at, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      versionNo, rule.name || `规则 v${versionNo}`,
      rule.completion_weight, rule.on_time_weight, rule.quality_weight,
      rule.excellent_threshold, rule.good_threshold, rule.qualified_threshold,
      rule.minimum_sample_size, now, actorId == null ? null : Number(actorId), now,
    ]);
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
    throw error;
  }
  return getActiveRule(db);
}

function ticketColumns(db) {
  const result = db.exec('PRAGMA table_info(tickets)');
  return new Set(result[0] ? result[0].values.map((row) => row[1]) : []);
}

function dateRange(filters = {}) {
  const now = new Date(filters.now || Date.now());
  const hasFrom = filters.from !== undefined && filters.from !== '';
  const hasTo = filters.to !== undefined && filters.to !== '';
  if (hasFrom !== hasTo) throw invalidDate('开始日期和结束日期必须同时提供');
  const hasExplicitRange = hasFrom && hasTo;
  let from = filters.from;
  let to = filters.to;
  if (!from || !to) {
    const local = new Date(now.getTime() + 8 * 3600000);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    from = `${year}-${String(month).padStart(2, '0')}-01`;
    const next = new Date(Date.UTC(year, month, 1));
    to = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  const parse = (date, label) => {
    const match = DATE_RE.exec(String(date));
    if (!match) throw invalidDate(`${label}格式必须为 YYYY-MM-DD`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
        || check.getUTCDate() !== day) throw invalidDate(`${label}不是有效日期`);
    const valueAt = new Date(`${date}T00:00:00+08:00`);
    if (!Number.isFinite(valueAt.getTime())) throw invalidDate(`${label}不是有效日期`);
    return valueAt.toISOString();
  };
  const fromIso = parse(from, '开始日期');
  const toIso = parse(to, '结束日期');
  if (hasExplicitRange) {
    // Report filters use an inclusive end date; convert it to an exclusive bound.
    if (Date.parse(fromIso) > Date.parse(toIso)) throw invalidDate('开始日期不能晚于结束日期');
    const end = new Date(`${to}T00:00:00+08:00`);
    end.setUTCDate(end.getUTCDate() + 1);
    return { from: fromIso, toExclusive: end.toISOString() };
  }
  return { from: fromIso, toExclusive: toIso };
}

function completionTime(ticket, columns) {
  for (const key of ['finished', 'completed_at', 'finished_at']) {
    if (columns.has(key) && ticket[key]) return ticket[key];
  }
  return '';
}

function metricValues(ticketRows, columns, range) {
  const uniqueRows = [...new Map(ticketRows.map((ticket) => [String(ticket.id), ticket])).values()];
  const completed = uniqueRows.filter((ticket) => {
    if (ticket.status !== 'done') return false;
    const start = Date.parse(ticket.assigned_at || ticket.created);
    const end = Date.parse(completionTime(ticket, columns));
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      && (!range || (end >= Date.parse(range.from) && end < Date.parse(range.toExclusive)));
  });
  const sla = completed.filter((ticket) => Number(ticket.estimated_hours) > 0);
  const onTime = sla.filter((ticket) => {
    const start = Date.parse(ticket.assigned_at || ticket.created);
    const end = Date.parse(completionTime(ticket, columns));
    return (end - start) / 3600000 <= Number(ticket.estimated_hours);
  });
  const returned = uniqueRows.filter((ticket) => String(ticket.reject_reason || '').trim() !== '')
    .length;
  const multipleFeedback = uniqueRows.filter((ticket) => Number(ticket.feedback_count || 1) > 1)
    .length;
  const recurring = columns.has('is_recurring')
    ? uniqueRows.filter((ticket) => Number(ticket.is_recurring || 0) === 1).length : 0;
  const quality = uniqueRows.length
    ? Math.max(0, 100 - ((returned + multipleFeedback + recurring) / uniqueRows.length) * 100)
    : null;
  return {
    completion: uniqueRows.length ? (completed.length / uniqueRows.length) * 100 : null,
    onTime: sla.length ? (onTime.length / sla.length) * 100 : null,
    quality,
    sampleSize: uniqueRows.length,
  };
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function calculateScore(metrics = {}, rule = {}, sampleSize = metrics.sampleSize || 0) {
  const sample = Number(sampleSize || 0);
  const minimum = Number(rule.minimum_sample_size || 0);
  const components = {};
  const available = [];
  for (const definition of COMPONENTS) {
    const metric = metrics[definition.key];
    const hasMetric = metric !== null && metric !== undefined && metric !== ''
      && Number.isFinite(Number(metric));
    const score = hasMetric ? Math.max(0, Math.min(100, Number(metric))) : null;
    const weight = Number(rule[definition.weight] || 0);
    if (score == null) {
      components[definition.key] = { score: null, weight, contribution: 0, status: 'no_sample' };
    } else {
      available.push({ ...definition, score, weight });
      components[definition.key] = { score: round(score), weight, contribution: 0, status: 'scored' };
    }
  }
  if (sample < minimum || available.length === 0) {
    return {
      status: 'insufficient_sample', score: null, level: 'insufficient_sample',
      sampleSize: sample, components,
    };
  }
  const totalWeight = available.reduce((sum, item) => sum + item.weight, 0);
  let score = 0;
  for (const item of available) {
    const contribution = item.score * item.weight / totalWeight;
    score += contribution;
    components[item.key].contribution = round(contribution);
    components[item.key].normalizedWeight = round(item.weight / totalWeight * 100);
  }
  score = round(score);
  const level = score >= Number(rule.excellent_threshold) ? 'excellent'
    : score >= Number(rule.good_threshold) ? 'good'
      : score >= Number(rule.qualified_threshold) ? 'qualified' : 'unqualified';
  return { status: 'scored', score, level, sampleSize: sample, components };
}

function scoreStaff(db, staffId, filters = {}) {
  const id = Number(staffId);
  if (!Number.isInteger(id)) throw invalidRule('人员 ID 无效');
  const profile = one(db, 'SELECT * FROM staff_profiles WHERE id = ?', [id]);
  if (!profile) {
    const error = new Error('人员档案不存在');
    error.status = 404;
    error.code = 'PROFILE_NOT_FOUND';
    throw error;
  }
  const active = getActiveRule(db);
  const allRules = listRuleVersions(db);
  const ruleById = new Map(allRules.map((rule) => [Number(rule.id), rule]));
  const columns = ticketColumns(db);
  const range = dateRange(filters);
  const assignedExpr = columns.has('assigned_at') ? "COALESCE(NULLIF(t.assigned_at, ''), t.created)" : 't.created';
  const identity = [];
  const identityParams = [];
  if (columns.has('assignee_user_id') && profile.user_id != null) {
    identity.push('t.assignee_user_id = ?');
    identityParams.push(profile.user_id);
  }
  if (columns.has('assignee_staff_profile_id')) {
    identity.push('t.assignee_staff_profile_id = ?');
    identityParams.push(id);
  }
  identity.push('(NULLIF(t.worker, \'\') IS NOT NULL AND t.worker = ?)');
  identityParams.push(profile.name);
  const staffPredicate = `(${identity.join(' OR ')})`;
  const communityId = filters.communityId || filters.community_id;
  const communityPredicate = communityId && columns.has('community_id') ? ' AND t.community_id = ?' : '';
  const params = [...identityParams, ...(communityPredicate ? [communityId] : []), range.from, range.toExclusive];
  const tickets = rows(db, `
    SELECT t.* FROM tickets t
    WHERE ${staffPredicate}${communityPredicate} AND ${assignedExpr} >= ? AND ${assignedExpr} < ?
  `, params);
  const groups = new Map();
  for (const ticket of tickets) {
    const ruleId = Number(ticket.performance_rule_version_id || active?.id);
    const rule = ruleById.get(ruleId) || active;
    if (!rule) continue;
    if (!groups.has(rule.id)) groups.set(rule.id, { rule, rows: [] });
    groups.get(rule.id).rows.push(ticket);
  }
  const groupResults = [...groups.values()].map(({ rule, rows: ticketRows }) => {
    const uniqueTickets = [...new Map(ticketRows.map((ticket) => [String(ticket.id), ticket])).values()];
    const metrics = metricValues(uniqueTickets, columns, range);
    return { rule, result: calculateScore(metrics, rule, uniqueTickets.length) };
  });
  const uniqueTickets = [...new Map(tickets.map((ticket) => [String(ticket.id), ticket])).values()];
  const sampleSize = uniqueTickets.length;
  const weighted = groupResults.filter((group) => group.result.status === 'scored' && group.result.score != null);
  let performance;
  if (!weighted.length || sampleSize < Number(active?.minimum_sample_size || 0)) {
    performance = {
      status: 'insufficient_sample', score: null, level: 'insufficient_sample', sampleSize,
      components: calculateScore({}, active || {}, sampleSize).components,
    };
  } else {
    const total = weighted.reduce((sum, group) => sum + group.result.sampleSize, 0);
    const score = round(weighted.reduce((sum, group) => sum + group.result.score * group.result.sampleSize, 0) / total);
    const components = {};
    for (const definition of COMPONENTS) {
      const groupsWithComponent = weighted.filter((group) => group.result.components[definition.key]?.status === 'scored');
      if (!groupsWithComponent.length) {
        components[definition.key] = {
          score: null, contribution: 0, weight: Number(active?.[definition.weight] || 0), status: 'no_sample',
        };
      } else {
        const componentScore = round(groupsWithComponent.reduce((sum, group) => (
          sum + Number(group.result.components[definition.key].score) * group.result.sampleSize
        ), 0) / groupsWithComponent.reduce((sum, group) => sum + group.result.sampleSize, 0));
        const componentContribution = groupsWithComponent.reduce((sum, group) => (
          sum + Number(group.result.components[definition.key].contribution || 0) * group.result.sampleSize
        ), 0) / groupsWithComponent.reduce((sum, group) => sum + group.result.sampleSize, 0);
        components[definition.key] = {
          score: componentScore,
          weight: null,
          contribution: round(componentContribution),
          status: 'scored',
        };
      }
    }
    const thresholds = ['excellent_threshold', 'good_threshold', 'qualified_threshold']
      .map((key) => weighted.reduce((sum, group) => (
        sum + Number(group.rule[key]) * group.result.sampleSize
      ), 0) / total);
    const level = score >= thresholds[0] ? 'excellent'
      : score >= thresholds[1] ? 'good'
        : score >= thresholds[2] ? 'qualified' : 'unqualified';
    performance = { status: 'scored', score, level, sampleSize, components };
  }
  const usedRules = groupResults.length ? groupResults : (active ? [{
    rule: active,
    result: calculateScore({}, active, 0),
  }] : []);
  return {
    ...performance,
    ruleVersions: usedRules.map(({ rule, result }) => ({
      id: rule.id, version: rule.version_no, version_no: rule.version_no,
      name: rule.name, effective_at: rule.effective_at,
      sampleSize: result.sampleSize,
      status: result.status,
      score: result.score,
      level: result.level,
      components: result.components,
      weights: {
        completion: rule.completion_weight,
        onTime: rule.on_time_weight,
        quality: rule.quality_weight,
      },
      thresholds: {
        excellent: rule.excellent_threshold,
        good: rule.good_threshold,
        qualified: rule.qualified_threshold,
      },
    })),
    range,
  };
}

module.exports = {
  validateRule,
  getActiveRule,
  listRuleVersions,
  createRuleVersion,
  calculateScore,
  scoreStaff,
};
