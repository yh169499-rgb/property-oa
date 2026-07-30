const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { queryAll, queryOne, run, saveDB, getDB } = require('../db');
const {
  descendantIds,
  buildOrganizationTree,
  updateManager,
} = require('../services/organization');

const router = express.Router();
const SELF_FIELDS = new Set(['phone', 'birth_month']);
const ADMIN_FIELDS = new Set([
  'user_id',
  'name',
  'birth_month',
  'join_date',
  'phone',
  'position',
  'skill',
  'manager_id',
  'employment_status',
]);

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

function profileById(id) {
  return queryOne('SELECT * FROM staff_profiles WHERE id = ?', [id]);
}

function ownProfile(userId) {
  return queryOne('SELECT * FROM staff_profiles WHERE user_id = ?', [userId]);
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

function updateProfile(id, body, allowed) {
  const fields = validateFields(body, allowed);
  const result = withTransaction((db) => {
    const regularFields = fields.filter((field) => field !== 'manager_id');
    if (fields.includes('manager_id')) {
      updateManager(db, id, body.manager_id);
    }
    if (regularFields.length) {
      const assignments = regularFields.map((field) => `${field} = ?`).join(', ');
      const values = regularFields.map((field) => body[field]);
      db.run(
        `UPDATE staff_profiles SET ${assignments}, updated_at = ? WHERE id = ?`,
        [...values, new Date().toISOString(), id]
      );
    }
    return profileById(id);
  });
  saveDB();
  return result;
}

function updateOwnProfile(profile, userId, body) {
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
      db.run('UPDATE users SET phone = ? WHERE id = ?', [body.phone, userId]);
    }
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    db.run(
      `UPDATE staff_profiles SET ${assignments}, updated_at = ? WHERE id = ?`,
      [...fields.map((field) => body[field]), new Date().toISOString(), profile.id]
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
  return profileById(profile.id);
}

router.get('/me', requireAuth, (req, res) => {
  try {
    const profile = ownProfile(req.user.id);
    if (!profile) throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    res.json({ data: profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/me', requireAuth, (req, res) => {
  try {
    const profile = ownProfile(req.user.id);
    if (!profile) throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    res.json({ data: updateOwnProfile(profile, req.user.id, req.body) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/staff/profiles', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json({ data: queryAll('SELECT * FROM staff_profiles ORDER BY id') });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/staff/profiles/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const profile = profileById(req.params.id);
    if (!profile) throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    res.json({ data: profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/staff/profiles', requireAuth, requireAdmin, (req, res) => {
  try {
    const fields = validateFields(req.body, ADMIN_FIELDS);
    const now = new Date().toISOString();
    const columns = [...fields, 'created_at', 'updated_at'];
    const placeholders = columns.map(() => '?').join(', ');
    const created = withTransaction((db) => {
      db.run(
        `INSERT INTO staff_profiles (${columns.join(', ')}) VALUES (${placeholders})`,
        [...fields.map((field) => field === 'manager_id' ? null : req.body[field]), now, now]
      );
      const inserted = queryOne('SELECT * FROM staff_profiles WHERE id = last_insert_rowid()');
      if (fields.includes('manager_id')) {
        updateManager(db, inserted.id, req.body.manager_id);
      }
      return profileById(inserted.id);
    });
    saveDB();
    res.status(201).json({ data: created });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/staff/profiles/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    if (!profileById(req.params.id)) {
      throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    }
    res.json({ data: updateProfile(req.params.id, req.body, ADMIN_FIELDS) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/organization/tree', requireAuth, requireAdmin, (req, res) => {
  try {
    const profiles = queryAll('SELECT * FROM staff_profiles ORDER BY id');
    res.json({ data: buildOrganizationTree(profiles) });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/staff/profiles/:id/manager', requireAuth, requireAdmin, (req, res) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'manager_id')) {
      throw apiError('缺少 manager_id', 400, 'INVALID_MANAGER');
    }
    if (!profileById(req.params.id)) {
      throw apiError('人员档案不存在', 404, 'PROFILE_NOT_FOUND');
    }
    const profile = updateManager(getDB(), req.params.id, req.body.manager_id);
    saveDB();
    res.json({ data: profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/staff/profiles/:id/team', requireAuth, requireAdmin, (req, res) => {
  try {
    const profiles = queryAll('SELECT * FROM staff_profiles ORDER BY id');
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
