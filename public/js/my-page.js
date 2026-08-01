(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MyPage = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var state = { period: 'month', profile: null, attendance: [], busy: false };
  var STATUS_LABELS = {
    normal: '正常', late: '迟到', early: '早退', absent: '缺勤',
    leave: '请假', overtime: '加班', rest: '休息'
  };

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function isManagerProfile(profile, stats) {
    return Boolean(
      stats && (stats.personalActions || stats.team || stats.teamResults)
      || /主管|经理|组长|负责人/.test(String(profile && profile.position || ''))
    );
  }

  function buildMyPageModel(profile, stats, attendance, period) {
    profile = profile || {};
    stats = stats || {};
    attendance = Array.isArray(attendance) ? attendance : [];
    period = ['day', 'month', 'year'].includes(period) ? period : 'month';
    var manager = isManagerProfile(profile, stats);
    var team = stats.team || stats.teamResults || null;
    var personal = manager ? (stats.personalActions || { total: 0, byAction: {} }) : null;
    var own = manager ? {} : stats;
    var attendanceStats = own.attendance || {};

    return {
      period: period,
      periodLabel: { day: '今日', month: '本月', year: '本年' }[period],
      profile: {
        id: profile.id,
        name: profile.name || '未命名用户',
        phone: profile.phone || '',
        birth_month: profile.birth_month || '',
        join_date: profile.join_date || '—',
        position: profile.position || '—',
        manager: profile.manager_name || profile.manager || (profile.manager_id ? '直属主管 #' + profile.manager_id : '—')
      },
      editableFields: ['birth_month', 'phone'],
      readonlyFields: ['join_date', 'position', 'manager'],
      isManager: manager,
      personalActions: personal,
      teamResults: team ? {
        staffCount: Array.isArray(team.staffIds) ? team.staffIds.length : number(team.staffCount),
        received: number(team.received && team.received.total),
        completed: number(team.completed && team.completed.total),
        averageHours: number(team.completed && team.completed.averageHours),
        onTimeRate: number(team.completed && team.completed.onTimeRate),
        actualDays: number(team.attendance && team.attendance.actualDays),
        late: number(team.attendance && team.attendance.late)
      } : null,
      results: {
        received: number(own.received && own.received.total),
        completed: number(own.completed && own.completed.total),
        averageHours: number(own.completed && own.completed.averageHours),
        onTimeRate: number(own.completed && own.completed.onTimeRate)
      },
      attendance: {
        actualDays: attendanceStats.actualDays == null ? attendance.length : number(attendanceStats.actualDays),
        late: attendanceStats.late == null
          ? attendance.filter(function (item) { return item.status === 'late'; }).length
          : number(attendanceStats.late)
      },
      calendar: attendance.map(function (item) {
        return {
          date: item.work_date || '',
          day: String(item.work_date || '').slice(-2),
          status: item.status || 'normal',
          statusLabel: STATUS_LABELS[item.status] || '已记录',
          checkIn: item.check_in_at || item.check_in || '',
          checkOut: item.check_out_at || item.check_out || ''
        };
      })
    };
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function metric(label, value) {
    var node = element('div', 'my-metric');
    node.appendChild(element('span', 'my-metric-label', label));
    node.appendChild(element('strong', 'my-metric-value', value));
    return node;
  }

  function field(label, value, input) {
    var row = element('label', 'my-field');
    row.appendChild(element('span', 'my-field-label', label));
    if (input) row.appendChild(input);
    else row.appendChild(element('span', 'my-field-readonly', value || '—'));
    return row;
  }

  function render(model) {
    var rootNode = document.getElementById('my-page-root');
    if (!rootNode) return;
    rootNode.replaceChildren();

    var hero = element('section', 'my-hero');
    var intro = element('div');
    intro.appendChild(element('span', 'my-eyebrow', model.isManager ? '主管个人中心' : '员工个人中心'));
    intro.appendChild(element('h2', '', model.profile.name));
    intro.appendChild(element('p', '', model.profile.position + ' · ' + model.periodLabel + '工作概览'));
    hero.appendChild(intro);
    var periods = element('div', 'period-switch', '');
    [['day', '日'], ['month', '月'], ['year', '年']].forEach(function (entry) {
      var button = element('button', entry[0] === model.period ? 'active' : '', entry[1]);
      button.type = 'button';
      button.addEventListener('click', function () { load(entry[0]); });
      periods.appendChild(button);
    });
    hero.appendChild(periods);
    rootNode.appendChild(hero);

    var grid = element('div', 'my-page-grid');
    var profileCard = element('section', 'card my-profile-panel');
    profileCard.appendChild(element('h3', '', '基本资料'));
    var fields = element('div', 'my-profile-fields');
    fields.appendChild(field('姓名', model.profile.name));
    fields.appendChild(field('岗位', model.profile.position));
    fields.appendChild(field('入职日期', model.profile.join_date));
    fields.appendChild(field('直属主管', model.profile.manager));
    var phone = element('input'); phone.type = 'tel'; phone.value = model.profile.phone; phone.id = 'my-phone';
    phone.autocomplete = 'tel'; fields.appendChild(field('手机号', '', phone));
    var birth = element('input'); birth.type = 'month';
    birth.value = model.profile.birth_month; birth.id = 'my-birth-month';
    fields.appendChild(field('出生月份', '', birth));
    profileCard.appendChild(fields);
    var save = element('button', 'btn my-save', '保存可编辑资料');
    save.type = 'button'; save.addEventListener('click', saveProfile);
    profileCard.appendChild(save);
    grid.appendChild(profileCard);

    var summary = element('section', 'card my-summary-panel');
    summary.appendChild(element('h3', '', model.isManager ? '工作成果' : model.periodLabel + '个人成果'));
    var metrics = element('div', 'my-metrics');
    if (model.isManager) {
      metrics.appendChild(metric('个人主管动作', number(model.personalActions && model.personalActions.total) + ' 次'));
      metrics.appendChild(metric('团队人数', model.teamResults.staffCount + ' 人'));
      metrics.appendChild(metric('团队接单', model.teamResults.received + ' 张'));
      metrics.appendChild(metric('团队完成', model.teamResults.completed + ' 张'));
      metrics.appendChild(metric('团队按时率', model.teamResults.onTimeRate + '%'));
      metrics.appendChild(metric('团队迟到', model.teamResults.late + ' 次'));
    } else {
      metrics.appendChild(metric('接单', model.results.received + ' 张'));
      metrics.appendChild(metric('完成', model.results.completed + ' 张'));
      metrics.appendChild(metric('平均处理', model.results.averageHours + ' 小时'));
      metrics.appendChild(metric('按时率', model.results.onTimeRate + '%'));
    }
    summary.appendChild(metrics);
    grid.appendChild(summary);
    rootNode.appendChild(grid);

    var attendanceCard = element('section', 'card my-attendance-panel');
    var attendanceHead = element('div', 'my-section-head');
    var title = element('div');
    title.appendChild(element('h3', '', '本月实际考勤'));
    title.appendChild(element('p', '', '今日打卡：本轮暂未启用打卡；下方仍展示系统已有记录。'));
    attendanceHead.appendChild(title);
    attendanceHead.appendChild(element('strong', 'attendance-total',
      model.attendance.actualDays + ' 天 · 迟到 ' + model.attendance.late + ' 次'));
    attendanceCard.appendChild(attendanceHead);
    var calendar = element('div', 'attendance-calendar');
    if (!model.calendar.length) {
      calendar.appendChild(element('div', 'my-empty', '本月暂无考勤记录'));
    } else {
      model.calendar.forEach(function (day) {
        var cell = element('div', 'attendance-day status-' + day.status);
        cell.appendChild(element('span', 'attendance-date', day.date));
        cell.appendChild(element('strong', '', day.statusLabel));
        var times = [day.checkIn && '上班 ' + day.checkIn.slice(11, 16), day.checkOut && '下班 ' + day.checkOut.slice(11, 16)]
          .filter(Boolean).join(' · ');
        cell.appendChild(element('small', '', times || '暂无打卡时间'));
        calendar.appendChild(cell);
      });
    }
    attendanceCard.appendChild(calendar);
    rootNode.appendChild(attendanceCard);
  }

  async function request(path, options) {
    if (typeof API !== 'undefined' && !options) return API.get(path);
    if (typeof API !== 'undefined' && options && options.method === 'PATCH') return API.patch(path, options.body);
    return { ok: false, error: '服务暂不可用' };
  }

  function monthKey() {
    var now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  }

  function managerPeriodQuery(period) {
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth();
    var from;
    var to;
    if (period === 'day') {
      from = to = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    } else if (period === 'year') {
      from = year + '-01-01';
      to = year + '-12-31';
    } else {
      from = year + '-' + String(month + 1).padStart(2, '0') + '-01';
      to = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(new Date(year, month + 1, 0).getDate()).padStart(2, '0');
    }
    return '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
  }

  async function load(period) {
    if (state.busy) return;
    state.busy = true;
    state.period = period || state.period;
    var rootNode = document.getElementById('my-page-root');
    if (rootNode) rootNode.setAttribute('aria-busy', 'true');
    try {
      var profileResult = await request('/api/me');
      if (!profileResult.ok || !profileResult.data) {
        if (rootNode) rootNode.replaceChildren(element('div', 'card my-empty', '个人资料暂时无法加载，请稍后重试。'));
        return;
      }
      state.profile = profileResult.data;
      var manager = isManagerProfile(state.profile);
      var statsPath = manager
        ? '/api/reports/manager/' + encodeURIComponent(state.profile.id) + managerPeriodQuery(state.period)
        : '/api/me/stats?period=' + encodeURIComponent(state.period);
      var results = await Promise.all([
        request(statsPath),
        request('/api/me/attendance?month=' + encodeURIComponent(monthKey()))
      ]);
      var stats = results[0].ok ? results[0].data : {};
      state.attendance = results[1].ok && Array.isArray(results[1].data) ? results[1].data : [];
      render(buildMyPageModel(state.profile, stats, state.attendance, state.period));
    } finally {
      state.busy = false;
      if (rootNode) rootNode.setAttribute('aria-busy', 'false');
    }
  }

  async function saveProfile() {
    var phone = document.getElementById('my-phone');
    var birth = document.getElementById('my-birth-month');
    var result = await request('/api/me', {
      method: 'PATCH',
      body: { phone: phone ? phone.value.trim() : '', birth_month: birth && birth.value ? birth.value : '' }
    });
    if (result.ok) {
      if (typeof toast === 'function') toast('个人资料已保存');
      load(state.period);
    }
  }

  return { buildMyPageModel: buildMyPageModel, init: load, render: render };
}));
