(function (root, factory) {
  var utils = factory();
  if (typeof module === 'object' && module.exports) module.exports = utils;
  else root.WorkforceUtils = utils;
}(typeof self !== 'undefined' ? self : this, function () {
  var PERIOD_LABELS = {
    day: '今日',
    week: '本周',
    month: '本月',
    quarter: '本季度',
    year: '本年'
  };

  function withQuery(path, query) {
    var params = new URLSearchParams();
    Object.keys(query || {}).forEach(function (key) {
      var value = query[key];
      if (value !== undefined && value !== null && value !== '') params.append(key, value);
    });
    var queryString = params.toString();
    return queryString ? path + '?' + queryString : path;
  }

  function requiredPathSegment(value, name) {
    var normalized = value === undefined || value === null ? '' : String(value).trim();
    if (!normalized) throw new TypeError((name || 'value') + ' is required');
    return encodeURIComponent(normalized);
  }

  return {
    isNarrowViewport: function (width) {
      return Number(width) <= 767;
    },
    periodLabel: function (period) {
      return PERIOD_LABELS[period] || period || '';
    },
    withQuery: withQuery,
    requiredPathSegment: requiredPathSegment
  };
}));
