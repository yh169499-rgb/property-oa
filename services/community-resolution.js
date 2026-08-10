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

function error(message, code, status = 400) {
  const result = new Error(message);
  result.code = code;
  result.status = status;
  return result;
}

function resolveCommunity(db, body = {}) {
  const id = body.community_id == null ? '' : String(body.community_id).trim();
  const alias = body.communityId == null ? '' : String(body.communityId).trim();
  if (id && alias && id !== alias) throw error('community_id 与 communityId 不一致', 'COMMUNITY_CONFLICT');
  const requestedId = id || alias;
  if (requestedId) {
    const community = one(db, 'SELECT id, name FROM communities WHERE id = ?', [requestedId]);
    if (!community) throw error('指定小区不存在', 'COMMUNITY_NOT_FOUND');
    return { id: community.id, name: community.name, resolution: 'explicit_id' };
  }

  const name = String(body.community_name || body.communityName || '').trim();
  if (name) {
    const matches = rows(db, 'SELECT id, name FROM communities WHERE TRIM(name) = TRIM(?) ORDER BY created', [name]);
    if (!matches.length) throw error('指定小区不存在', 'COMMUNITY_NOT_FOUND');
    if (matches.length > 1) throw error('小区名称不唯一，请改用小区 ID', 'COMMUNITY_AMBIGUOUS');
    return { id: matches[0].id, name: matches[0].name, resolution: 'explicit_name' };
  }

  const communities = rows(db, 'SELECT id, name FROM communities ORDER BY created');
  if (communities.length !== 1) throw error('多小区场景必须指定小区', 'COMMUNITY_REQUIRED');
  return { id: communities[0].id, name: communities[0].name, resolution: 'single_community' };
}

module.exports = { resolveCommunity };
