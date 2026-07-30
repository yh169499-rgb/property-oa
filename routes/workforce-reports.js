const express = require('express');
const database = require('../db');
const { requireAuth } = require('../middleware/auth');
const { descendantIds } = require('../services/organization');
const { buildDayCalendar } = require('../services/calendar');
const {
  shanghaiMonthRange,
  getDashboardStats,
  getStaffReport,
  getManagerReport,
} = require('../services/reporting');

const router = express.Router();
const PUBLIC_ERROR_CODES = new Set([
  'INVALID_DATE',
  'INVALID_CALENDAR_REQUEST',
  'PROFILE_NOT_FOUND',
  'CALENDAR_SCOPE_FORBIDDEN',
]);

function all(sql, params = []) {
  const statement = database.getDB().prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function fail(res, error) {
  if (!Number.isInteger(error.status) || !PUBLIC_ERROR_CODES.has(error.code)) {
    return res.status(500).json({
      error: '内部服务器错误',
      code: 'INTERNAL_ERROR',
    });
  }
  return res.status(error.status).json({
    error: error.message || '请求失败',
    code: error.code || 'INVALID_CALENDAR_REQUEST',
  });
}

function ownProfile(profiles, userId) {
  return profiles.find((profile) => Number(profile.user_id) === Number(userId));
}

function assertStaffScope(req, requestedId, options = {}) {
  const profiles = all('SELECT id, user_id, manager_id FROM staff_profiles');
  const own = ownProfile(profiles, req.user.id);
  if (!own) {
    const error = new Error('人员档案不存在');
    error.status = 404;
    error.code = 'PROFILE_NOT_FOUND';
    throw error;
  }
  const target = Number(requestedId);
  const allowed = req.user.role === 'admin'
    || target === Number(own.id)
    || (req.user.role === 'lead'
      && descendantIds(profiles, own.id).map(Number).includes(target));
  if (!allowed || (options.managerOnly && !['admin', 'lead'].includes(req.user.role))) {
    const error = new Error('无权查看该人员或团队');
    error.status = 403;
    error.code = 'REPORT_SCOPE_FORBIDDEN';
    throw error;
  }
  return { own, profiles };
}

router.get('/calendar/day', requireAuth, (req, res) => {
  try {
    const profiles = all('SELECT id, user_id, manager_id FROM staff_profiles');
    const own = profiles.find((profile) => Number(profile.user_id) === Number(req.user.id));
    let staffId = req.query.staff_id;
    let managerId = req.query.manager_id;

    if (!['admin', 'lead'].includes(req.user.role)) {
      if (!own) {
        const error = new Error('人员档案不存在');
        error.status = 404;
        error.code = 'PROFILE_NOT_FOUND';
        throw error;
      }
      staffId = own.id;
      managerId = undefined;
    } else if (req.user.role === 'lead') {
      if (!own) {
        const error = new Error('人员档案不存在');
        error.status = 404;
        error.code = 'PROFILE_NOT_FOUND';
        throw error;
      }
      const scope = new Set([Number(own.id), ...descendantIds(profiles, own.id).map(Number)]);
      const requested = staffId ?? managerId;
      if (requested !== undefined && requested !== '' && !scope.has(Number(requested))) {
        const error = new Error('无权查看该人员或团队');
        error.status = 403;
        error.code = 'CALENDAR_SCOPE_FORBIDDEN';
        throw error;
      }
      if (staffId === undefined && managerId === undefined) managerId = own.id;
    }

    res.json(buildDayCalendar(database.getDB(), {
      date: req.query.date,
      staffId,
      managerId,
      communityId: req.query.community_id,
      viewerUserId: req.user.id,
    }));
  } catch (error) {
    fail(res, error);
  }
});

router.get('/dashboard/stats', requireAuth, (req, res) => {
  try {
    if (!['admin', 'lead'].includes(req.user.role)) {
      const error = new Error('需要主管权限');
      error.status = 403;
      error.code = 'REPORT_SCOPE_FORBIDDEN';
      throw error;
    }
    res.json({ data: getDashboardStats(database.getDB(), {
      communityId: req.query.community_id,
    }) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/reports/staff/:staff_id', requireAuth, (req, res) => {
  try {
    assertStaffScope(req, req.params.staff_id);
    res.json({ data: getStaffReport(database.getDB(), req.params.staff_id, {
      from: req.query.from,
      to: req.query.to,
      communityId: req.query.community_id,
    }) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/reports/manager/:staff_id', requireAuth, (req, res) => {
  try {
    assertStaffScope(req, req.params.staff_id, { managerOnly: true });
    res.json({ data: getManagerReport(database.getDB(), req.params.staff_id, {
      from: req.query.from,
      to: req.query.to,
      communityId: req.query.community_id,
    }) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/me/stats', requireAuth, (req, res) => {
  try {
    const profiles = all('SELECT id, user_id FROM staff_profiles');
    const own = ownProfile(profiles, req.user.id);
    if (!own) {
      const error = new Error('人员档案不存在');
      error.status = 404;
      error.code = 'PROFILE_NOT_FOUND';
      throw error;
    }
    let filters = { communityId: req.query.community_id };
    if (req.query.period === 'day') {
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      filters = { ...filters, from: today, to: today };
    } else if (req.query.period === 'year') {
      const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear();
      filters = { ...filters, from: `${year}-01-01`, to: `${year}-12-31` };
    } else if (req.query.period && req.query.period !== 'month') {
      const error = new Error('period 只支持 day、month 或 year');
      error.status = 400;
      error.code = 'INVALID_REPORT_PERIOD';
      throw error;
    }
    res.json({ data: getStaffReport(database.getDB(), own.id, filters) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/me/attendance', requireAuth, (req, res) => {
  try {
    const profiles = all('SELECT id, user_id FROM staff_profiles');
    const own = ownProfile(profiles, req.user.id);
    if (!own) {
      const error = new Error('人员档案不存在');
      error.status = 404;
      error.code = 'PROFILE_NOT_FOUND';
      throw error;
    }
    const month = req.query.month || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      const error = new Error('month 格式必须为 YYYY-MM');
      error.status = 400;
      error.code = 'INVALID_DATE_RANGE';
      throw error;
    }
    const range = shanghaiMonthRange(`${month}-15T00:00:00+08:00`);
    const records = all(
      `SELECT * FROM attendance_records
        WHERE staff_id = ? AND work_date >= ? AND work_date < ?
        ORDER BY work_date`,
      [
        own.id,
        new Date(Date.parse(range.from) + 8 * 3600000).toISOString().slice(0, 10),
        new Date(Date.parse(range.toExclusive) + 8 * 3600000).toISOString().slice(0, 10),
      ]
    );
    res.json({ data: records, range });
  } catch (error) {
    fail(res, error);
  }
});

module.exports = router;
