const express = require('express');
const database = require('../db');
const { requireAuth } = require('../middleware/auth');
const { descendantIds } = require('../services/organization');
const { buildDayCalendar } = require('../services/calendar');

const router = express.Router();

function all(sql, params = []) {
  const statement = database.getDB().prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function fail(res, error) {
  res.status(error.status || 400).json({
    error: error.message || '请求失败',
    code: error.code || 'INVALID_CALENDAR_REQUEST',
  });
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

module.exports = router;
