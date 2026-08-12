(function (root) {
  var utils = root.WorkforceUtils;

  root.WorkforceAPI = {
    me: function () { return API.get('/api/me'); },
    updateMe: function (body) { return API.patch('/api/me', body); },
    organizationTree: function () { return API.get('/api/organization/tree'); },
    profiles: function () { return API.get('/api/staff/profiles'); },
    importProfilesPreview: function (profiles) {
      return API.post('/api/staff/profiles/import-preview', { profiles: profiles });
    },
    importProfilesConfirm: function (profiles, selections) {
      return API.post('/api/staff/profiles/import-confirm', { profiles: profiles, selections: selections });
    },
    dayCalendar: function (query) {
      return API.get(utils.withQuery('/api/calendar/day', query));
    },
    checkIn: function () { return API.post('/api/attendance/check-in', {}); },
    checkOut: function () { return API.post('/api/attendance/check-out', {}); },
    dashboardStats: function (communityId, range) {
      return API.get(utils.withQuery('/api/dashboard/stats', {
        community_id: communityId, range: range || 'all'
      }));
    },
    staffReport: function (staffId, query) {
      var path = '/api/reports/staff/' + utils.requiredPathSegment(staffId, 'staffId');
      return API.get(utils.withQuery(path, query));
    },
    aiReportStatus: function () {
      return API.get('/api/reports/ai/status');
    },
    aiStaffReport: function (staffId, body) {
      var path = String(staffId) === 'all'
        ? '/api/reports/staff/all/ai-analysis'
        : '/api/reports/staff/' + utils.requiredPathSegment(staffId, 'staffId') + '/ai-analysis';
      return API.post(path, body || {});
    }
  };
}(window));
