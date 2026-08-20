const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function httpError(status, code, message, details = {}) {
  const error = new Error(message || code);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function tenantIdFrom(req) {
  const tenantId = String(req?.user?.tenant_id || '').trim();
  if (!tenantId) {
    throw httpError(403, 'TENANT_CONTEXT_REQUIRED', '缺少企业上下文');
  }
  return tenantId;
}

function assertNoClientTenant(value) {
  const seen = new Set();
  function visit(current) {
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (
      Object.prototype.hasOwnProperty.call(current, 'tenant_id')
      || Object.prototype.hasOwnProperty.call(current, 'tenantId')
    ) {
      throw httpError(400, 'CLIENT_TENANT_FORBIDDEN', '不允许由客户端指定企业');
    }
    for (const child of Object.values(current)) visit(child);
  }
  visit(value);
}

function assertSafeIdentifier(value) {
  const identifier = String(value || '');
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw httpError(500, 'UNSAFE_SQL_IDENTIFIER', '拒绝不安全的 SQL 标识符');
  }
  return identifier;
}

function one(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function findTenantRow(db, table, idColumn, id, tenantId) {
  const safeTable = assertSafeIdentifier(table);
  const safeIdColumn = assertSafeIdentifier(idColumn);
  return one(
    db,
    `SELECT * FROM ${safeTable} WHERE ${safeIdColumn} = ? AND tenant_id = ?`,
    [id, tenantId]
  );
}

function assertTenantWriteTarget(db, options) {
  const {
    table,
    idColumn = 'id',
    id,
    tenantId,
    notFoundCode = 'RESOURCE_NOT_FOUND',
    notFoundMessage = '目标不存在',
  } = options || {};
  const safeTable = assertSafeIdentifier(table);
  const safeIdColumn = assertSafeIdentifier(idColumn);
  const target = one(
    db,
    `SELECT * FROM ${safeTable} WHERE ${safeIdColumn} = ?`,
    [id]
  );
  if (!target) throw httpError(404, notFoundCode, notFoundMessage);
  if (String(target.tenant_id || '') !== String(tenantId || '')) {
    throw httpError(
      403,
      'CROSS_TENANT_WRITE_FORBIDDEN',
      '禁止修改其他企业的数据'
    );
  }
  return target;
}

module.exports = {
  httpError,
  tenantIdFrom,
  assertNoClientTenant,
  assertSafeIdentifier,
  findTenantRow,
  assertTenantWriteTarget,
};
