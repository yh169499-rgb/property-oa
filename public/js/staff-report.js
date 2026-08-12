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

  function levelLabel(level) {
    return {
      excellent: '优秀', good: '良好', qualified: '合格',
      unqualified: '待提升', insufficient_sample: '样本不足', team_summary: '团队汇总'
    }[level] || '样本不足';
  }

  function component(performance, key, label) {
    var item = performance && performance.components && performance.components[key] || {};
    return {
      label: label,
      score: item.score == null ? null : item.score,
      contribution: item.contribution == null ? null : item.contribution
    };
  }

  function ruleLabel(performance) {
    return (performance.ruleVersions || []).map(function (item) {
      return 'v' + (item.version || item.version_no) + '（' + Number(item.sampleSize || 0) + '单）';
    }).join('、') || '—';
  }

  function scoreLabel(performance) {
    if (performance.status === 'team_summary') {
      return performance.score == null ? '—' : value(performance.score, ' 分（团队均分）');
    }
    return performance.status === 'scored' && performance.score != null
      ? value(performance.score, ' 分') : '样本不足';
  }

  function teamPerformanceText(report) {
    if (!Array.isArray(report.staffReports)) return [];
    return ['人员绩效概览'].concat(report.staffReports.map(function (item) {
      var performance = item.performance || {};
      return (item.staff && item.staff.name || '-') + '：接单 ' + value(item.received && item.received.total, ' 单') +
        '；完成 ' + value(item.completed && item.completed.total, ' 单') +
        '；绩效 ' + scoreLabel(performance);
    }));
  }

  function teamPerformanceHtml(report) {
    if (!Array.isArray(report.staffReports)) return '';
    return '<section class="staff-report-team"><h3>人员绩效概览</h3><div class="staff-report-team-table">' +
      report.staffReports.map(function (item) {
        var performance = item.performance || {};
        return '<div class="staff-report-team-row"><strong>' + escapeHtml(item.staff && item.staff.name || '-') + '</strong>' +
          '<span>接单 ' + escapeHtml(value(item.received && item.received.total)) + ' 单</span>' +
          '<span>完成 ' + escapeHtml(value(item.completed && item.completed.total)) + ' 单</span>' +
          '<span>' + escapeHtml(scoreLabel(performance)) + '</span></div>';
      }).join('') + '</div></section>';
  }

  var AI_SECTIONS = [
    ['highlights', '工作亮点'],
    ['issues', '主要问题'],
    ['trends', '趋势判断'],
    ['risks', '风险提醒'],
    ['recommendations', '后续建议']
  ];

  function analysisText(analysis) {
    if (!analysis || !analysis.summary) return [];
    var lines = ['', 'AI 润色报告', '整体总结：' + analysis.summary];
    AI_SECTIONS.forEach(function (section) {
      var items = Array.isArray(analysis[section[0]]) ? analysis[section[0]] : [];
      lines.push(section[1] + '：' + (items.length ? items.join('；') : '数据不足以判断'));
    });
    lines.push('AI 建议，仅供管理参考');
    return lines;
  }

  function analysisHtml(analysis) {
    if (!analysis || !analysis.summary) return '';
    return '<section class="staff-report-ai"><header><div><span>千问生成</span><h3>AI 润色报告</h3></div><strong>AI 建议，仅供管理参考</strong></header>' +
      '<section class="staff-report-ai-summary"><h4>整体总结</h4><p>' + escapeHtml(analysis.summary) + '</p></section>' +
      '<div class="staff-report-ai-grid">' + AI_SECTIONS.map(function (section) {
        var items = Array.isArray(analysis[section[0]]) ? analysis[section[0]] : [];
        return '<section><h4>' + escapeHtml(section[1]) + '</h4>' +
          (items.length ? '<ul>' + items.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul>' : '<p>数据不足以判断</p>') +
          '</section>';
      }).join('') + '</div></section>';
  }

  function reportText(report, filters, analysis) {
    filters = filters || {};
    var staff = report.staff || {};
    var range = report.range || {};
    var received = report.received || {};
    var completed = report.completed || {};
    var current = report.current || {};
    var performance = report.performance || {};
    var recurrence = report.recurrence || {};
    var feedback = report.feedback || {};
    var categories = report.categories || [];
    return [
      '人员工作报告',
      '报告人员：' + (staff.name || '-') + (staff.position ? '（' + staff.position + '）' : ''),
      '日期：' + (filters.from || range.from || '-') + ' 至 ' + (filters.to || range.to || '-'),
      '小区：' + (filters.community_name || filters.community_id || '全部小区'),
      '绩效评分：' + scoreLabel(performance) + '（' + levelLabel(performance.level) + '）',
      '绩效样本：' + value(performance.sampleSize, ' 单') + '；规则版本：' + ruleLabel(performance),
      '完成率：' + (component(performance, 'completion', '完成率').score == null ? '—' : value(component(performance, 'completion', '完成率').score, ' 分')),
      '准时率：' + (component(performance, 'onTime', '准时率').score == null ? '—' : value(component(performance, 'onTime', '准时率').score, ' 分')),
      '质量分：' + (component(performance, 'quality', '质量分').score == null ? '—' : value(component(performance, 'quality', '质量分').score, ' 分')),
      '接收工单：' + value(received.total, ' 单'),
      '完成工单：' + value(completed.total, ' 单') + '；平均用时 ' + value(completed.averageHours, ' 小时') + '；按时率 ' + value(completed.onTimeRate, '%'),
      '工单状态：处理中 ' + value(current.doing, ' 单') + '；搁置 ' + value(current.pending, ' 单') + '；待派单 ' + value(current.waiting, ' 单') + '；期间退回 ' + value(current.returned, ' 单'),
      '异常关注：复发 ' + value(recurrence.total, ' 单') + '；多人反馈 ' + value(feedback.multiple, ' 单'),
      '分类分布：' + (categories.length ? categories.map(function (item) { return item.category + ' ' + item.total + ' 单'; }).join('；') : '无'),
      '生成时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
    ].concat(teamPerformanceText(report), analysisText(analysis)).join('\n');
  }

  function reportHtml(report, filters, analysis) {
    filters = filters || {};
    var staff = report.staff || {}, received = report.received || {};
    var completed = report.completed || {}, current = report.current || {};
    var performance = report.performance || {}, categories = report.categories || [];
    var recurrence = report.recurrence || {}, feedback = report.feedback || {};
    var components = [
      component(performance, 'completion', '完成率'),
      component(performance, 'onTime', '准时率'),
      component(performance, 'quality', '质量分')
    ];
    return '<article class="staff-report-document">' +
      '<div class="staff-report-head"><div><span>人员工作报告</span><h2>' + escapeHtml(staff.name || '-') + '</h2><p>' +
      escapeHtml((staff.position || '员工') + ' · ' + (filters.from || '-') + ' 至 ' + (filters.to || '-')) +
      '</p></div><strong>' + escapeHtml(filters.community_name || filters.community_id || '全部小区') + '</strong></div>' +
      '<section class="staff-report-performance"><div class="staff-report-performance-score"><span>综合得分</span><strong>' + escapeHtml(scoreLabel(performance)) + '</strong><small>' + escapeHtml(levelLabel(performance.level)) + '</small></div>' +
      '<div class="staff-report-performance-meta"><span>样本 <strong>' + escapeHtml(value(performance.sampleSize, ' 单')) + '</strong></span><span>规则版本 <strong>' + escapeHtml(ruleLabel(performance)) + '</strong></span></div>' +
      '<div class="staff-report-performance-components">' + components.map(function (item) {
        return '<div><span>' + escapeHtml(item.label) + '</span><strong>' + escapeHtml(item.score == null ? '—' : value(item.score, ' 分')) + '</strong><small>' + escapeHtml(item.contribution == null ? '暂无计算结果' : '计入 ' + value(item.contribution, ' 分')) + '</small></div>';
      }).join('') + '</div></section>' + analysisHtml(analysis) +
      '<div class="staff-report-metrics">' +
      [['期间接单', received.total, '单'], ['期间完成', completed.total, '单'],
        ['平均时长', completed.averageHours, '小时'], ['SLA 按时率', completed.onTimeRate, '%'],
        ['处理中', current.doing, '单'], ['搁置中', current.pending, '单'],
        ['期间退回', current.returned, '单'], ['复发 / 多人反馈', value(recurrence.total) + ' / ' + value(feedback.multiple), '单']]
        .map(function (item) { return '<div><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(value(item[1])) + '</strong><small>' + escapeHtml(item[2]) + '</small></div>'; }).join('') +
      '</div>' + teamPerformanceHtml(report) + '<div class="staff-report-sections"><section><h3>分类分布</h3>' +
      (categories.length ? categories.map(function (item) { return '<p><span>' + escapeHtml(item.category) + '</span><strong>' + escapeHtml(item.total) + ' 单</strong></p>'; }).join('') : '<p>暂无接单</p>') +
      '</section></div><div class="staff-report-footer">生成时间：' + escapeHtml(new Date().toLocaleString('zh-CN', { hour12: false })) + '</div></article>';
  }

  function copy(report, filters, analysis) {
    var text = reportText(report, filters, analysis);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    return Promise.resolve();
  }

  function printReport(report, filters, analysis) {
    var popup = window.open('', '_blank', 'noopener,noreferrer');
    if (!popup) throw new Error('浏览器阻止了打印窗口');
    popup.document.write('<!doctype html><meta charset="utf-8"><title>人员工作报告</title><style>body{font-family:sans-serif;padding:32px;line-height:1.7}h2{margin-bottom:24px}</style>' + reportHtml(report, filters, analysis));
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function exportWord(report, filters, analysis) {
    var html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' + reportHtml(report, filters, analysis) + '</body></html>';
    var blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '人员工作报告-' + ((report.staff || {}).name || '员工') + '.doc';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 0);
  }

  function render(container, report, filters, analysis, aiStatus) {
    container.innerHTML = reportHtml(report, filters, analysis);
    var actions = document.createElement('div');
    actions.className = 'staff-report-actions';
    var aiButton = document.createElement('button');
    aiButton.type = 'button';
    aiButton.className = 'btn sm staff-report-ai-action';
    aiButton.textContent = aiStatus && aiStatus.enabled
      ? (analysis ? '重新查看 AI 润色' : 'AI 优化并润色') : 'AI 报告未配置';
    aiButton.disabled = !(aiStatus && aiStatus.enabled);
    aiButton.addEventListener('click', function () {
      aiButton.disabled = true;
      aiButton.textContent = '千问正在整理报告…';
      root.WorkforceAPI.aiStaffReport((report.staff || {}).id, {
        from: filters.from,
        to: filters.to,
        community_id: filters.community_id || ''
      }).then(function (response) {
        if (!response || response.ok === false) throw new Error(response && response.error || 'AI 润色失败');
        var result = response.data || response;
        render(container, report, filters, result.analysis, { enabled: true, model: result.model });
      }).catch(function (error) {
        aiButton.disabled = false;
        aiButton.textContent = analysis ? '重新查看 AI 润色' : 'AI 优化并润色';
        var message = document.createElement('div');
        message.className = 'management-state staff-report-ai-error';
        message.textContent = (error && error.message || 'AI 分析暂不可用') + '，原始报告不受影响';
        actions.appendChild(message);
      });
    });
    actions.appendChild(aiButton);
    [['复制', function () { copy(report, filters, analysis); }], ['打印', function () { printReport(report, filters, analysis); }], ['导出 Word', function () { exportWord(report, filters, analysis); }]].forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn sm';
      button.textContent = item[0];
      button.addEventListener('click', item[1]);
      actions.appendChild(button);
    });
    container.appendChild(actions);
    return { report: report, analysis: analysis || null };
  }

  function load(container, staffId, filters) {
    container.innerHTML = '<div class="management-state">报告生成中…</div>';
    return root.WorkforceAPI.staffReport(staffId, filters || {}).then(function (response) {
      if (!response || response.ok === false) throw new Error(response && response.error || '报告生成失败');
      var report = response.data || response;
      var statusPromise = root.WorkforceAPI.aiReportStatus
        ? root.WorkforceAPI.aiReportStatus()
        : Promise.resolve({ ok: false });
      return statusPromise.catch(function () { return { ok: false }; }).then(function (statusResponse) {
        var status = statusResponse && statusResponse.ok !== false
          ? statusResponse.data || statusResponse : { enabled: false };
        return render(container, report, filters || {}, null, status);
      });
    }).catch(function (error) {
      container.innerHTML = '<div class="management-state">' + escapeHtml(error.message || '报告生成失败') + '</div>';
      throw error;
    });
  }

  var api = { load: load, render: render, reportText: reportText, reportHtml: reportHtml, copy: copy, print: printReport, exportWord: exportWord };
  root.StaffReport = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
