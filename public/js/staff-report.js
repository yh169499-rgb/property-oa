(function (root) {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function value(number, suffix) {
    return (number == null ? 0 : number) + (suffix || '');
  }

  function reportText(report, filters) {
    filters = filters || {};
    var staff = report.staff || {};
    var range = report.range || {};
    var received = report.received || {};
    var completed = report.completed || {};
    var current = report.current || {};
    var attendance = report.attendance || {};
    return [
      '人员工作报告',
      '人员：' + (staff.name || '-') + (staff.position ? '（' + staff.position + '）' : ''),
      '日期：' + (filters.from || range.from || '-') + ' 至 ' + (filters.to || range.to || '-'),
      '小区：' + (filters.community_name || filters.community_id || '全部小区'),
      '工单口径：接单按 assigned_at（缺失时使用 created）；完工按完成时间统计',
      '接收工单：' + value(received.total, ' 单'),
      '完成工单：' + value(completed.total, ' 单') + '；平均用时 ' + value(completed.averageHours, ' 小时') + '；按时率 ' + value(completed.onTimeRate, '%'),
      '当前工单：处理中 ' + value(current.doing, ' 单') + '；待处理 ' + value(current.pending, ' 单'),
      '考勤：实际 ' + value(attendance.actualDays, ' 天') + '；正常 ' + value(attendance.normal, ' 天') + '；迟到 ' + value(attendance.late, ' 天') + '；早退 ' + value(attendance.early, ' 天') + '；请假 ' + value(attendance.leave, ' 天') + '；缺勤 ' + value(attendance.absent, ' 天') + '；缺卡 ' + value(attendance.missing, ' 天'),
      '生成时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
    ].join('\n');
  }

  function reportHtml(report, filters) {
    var lines = reportText(report, filters).split('\n');
    return '<article class="staff-report-document">' +
      '<h2>' + escapeHtml(lines.shift()) + '</h2>' +
      lines.map(function (line) { return '<p>' + escapeHtml(line) + '</p>'; }).join('') +
      '</article>';
  }

  function copy(report, filters) {
    var text = reportText(report, filters);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    return Promise.resolve();
  }

  function printReport(report, filters) {
    var popup = window.open('', '_blank', 'noopener,noreferrer');
    if (!popup) throw new Error('浏览器阻止了打印窗口');
    popup.document.write('<!doctype html><meta charset="utf-8"><title>人员工作报告</title><style>body{font-family:sans-serif;padding:32px;line-height:1.7}h2{margin-bottom:24px}</style>' + reportHtml(report, filters));
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function exportWord(report, filters) {
    var html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' + reportHtml(report, filters) + '</body></html>';
    var blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '人员工作报告-' + ((report.staff || {}).name || '员工') + '.doc';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 0);
  }

  function render(container, report, filters) {
    container.innerHTML = reportHtml(report, filters);
    var actions = document.createElement('div');
    actions.className = 'staff-report-actions';
    [['复制', function () { copy(report, filters); }], ['打印', function () { printReport(report, filters); }], ['导出 Word', function () { exportWord(report, filters); }]].forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn sm';
      button.textContent = item[0];
      button.addEventListener('click', item[1]);
      actions.appendChild(button);
    });
    container.appendChild(actions);
    return report;
  }

  function load(container, staffId, filters) {
    container.innerHTML = '<div class="management-state">报告生成中…</div>';
    return root.WorkforceAPI.staffReport(staffId, filters || {}).then(function (response) {
      return render(container, response.data || response, filters || {});
    }).catch(function (error) {
      container.innerHTML = '<div class="management-state">' + escapeHtml(error.message || '报告生成失败') + '</div>';
      throw error;
    });
  }

  root.StaffReport = { load: load, render: render, reportText: reportText, copy: copy, print: printReport, exportWord: exportWord };
}(window));
