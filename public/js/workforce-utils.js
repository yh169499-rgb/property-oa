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

  function pad2(value) { return String(value).padStart(2, '0'); }
  function localDateKey(date) {
    var value = date instanceof Date ? date : new Date(date);
    return value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate());
  }
  function sameDay(first, second) {
    return first.getFullYear() === second.getFullYear()
      && first.getMonth() === second.getMonth()
      && first.getDate() === second.getDate();
  }
  function shanghaiTime(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '--:--';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date).replace(/^24:/, '00:');
  }

  return {
    isNarrowViewport: function (width) {
      return Number(width) <= 767;
    },
    periodLabel: function (period) {
      return PERIOD_LABELS[period] || period || '';
    },
    selectCalendarView: function (width) {
      return Number(width) <= 767 ? 'agenda' : 'day-grid';
    },
    localDateKey: localDateKey,
    sameDay: sameDay,
    shanghaiTime: shanghaiTime,
    fmtHM: function (date) {
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    },
    withQuery: withQuery,
    requiredPathSegment: requiredPathSegment
  };
}));
