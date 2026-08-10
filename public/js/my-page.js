(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MyPage = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var state = { period: 'month', profile: null, stats: {}, calendarDate: '', calendar: null, directory: [], busy: false };

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

  function buildMyPageModel(profile, stats, ignoredAttendance, period, calendar, directory) {
    profile = profile || {};
    stats = stats || {};
    calendar = calendar || {};
    directory = Array.isArray(directory) ? directory : [];
    period = ['day', 'month', 'year'].includes(period) ? period : 'month';
    var manager = isManagerProfile(profile, stats);
    var team = stats.team || stats.teamResults || {};
    var personal = manager ? (stats.personalActions || { total: 0, byAction: {} }) : null;
    var managerResults = manager ? (stats.personalResults || {}) : null;
    var own = manager ? {} : stats;

    var ownCalendar = (calendar.people || []).find(function (person) {
      return Number(person.id) === Number(profile.id);
    }) || (calendar.people || [])[0] || { shift: null, attendance: null };
    var scheduleEvents = (calendar.events || []).filter(function (event) {
      return event.staffId == null || Number(event.staffId) === Number(profile.id);
    });

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
      managerResults: managerResults ? {
        received: number(managerResults.received && managerResults.received.total),
        completed: number(managerResults.completed && managerResults.completed.total),
        averageHours: number(managerResults.completed && managerResults.completed.averageHours),
        onTimeRate: number(managerResults.completed && managerResults.completed.onTimeRate)
      } : null,
      teamResults: manager ? {
        staffCount: Array.isArray(team.staffIds) ? team.staffIds.length : number(team.staffCount),
        received: number(team.received && team.received.total),
        completed: number(team.completed && team.completed.total),
        averageHours: number(team.completed && team.completed.averageHours),
        onTimeRate: number(team.completed && team.completed.onTimeRate)
      } : null,
      results: {
        received: number(own.received && own.received.total),
        completed: number(own.completed && own.completed.total),
        averageHours: number(own.completed && own.completed.averageHours),
        onTimeRate: number(own.completed && own.completed.onTimeRate)
      },
      schedule: {
        date: calendar.date || '',
        shift: ownCalendar.shift || null,
        events: scheduleEvents,
        hasConflict: (calendar.conflicts || []).some(function (conflict) {
          return scheduleEvents.some(function (event) { return (conflict.ticketIds || []).includes(event.ticketId); });
        }),
        emptyShiftLabel: '今天未安排班次',
        emptyEventsLabel: '暂无工单时间块'
      },
      directory: directory
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
      metrics.appendChild(metric('本期处理工单', model.managerResults.received + ' / ' + model.managerResults.completed + ' 张'));
      metrics.appendChild(metric('个人主管动作', number(model.personalActions && model.personalActions.total) + ' 次'));
      metrics.appendChild(metric('团队人数', model.teamResults.staffCount + ' 人'));
      metrics.appendChild(metric('团队接单', model.teamResults.received + ' 张'));
      metrics.appendChild(metric('团队完成', model.teamResults.completed + ' 张'));
      metrics.appendChild(metric('团队按时率', model.teamResults.onTimeRate + '%'));
    } else {
      metrics.appendChild(metric('接单', model.results.received + ' 张'));
      metrics.appendChild(metric('完成', model.results.completed + ' 张'));
      metrics.appendChild(metric('平均处理', model.results.averageHours + ' 小时'));
      metrics.appendChild(metric('按时率', model.results.onTimeRate + '%'));
    }
    summary.appendChild(metrics);
    grid.appendChild(summary);
    rootNode.appendChild(grid);

    var scheduleCard = element('section', 'card my-schedule-card');
    var scheduleHead = element('div', 'my-section-head');
    var scheduleTitle = element('div');
    scheduleTitle.appendChild(element('h3', '', '我的日程'));
    scheduleTitle.appendChild(element('p', '', model.schedule.date || '今日'));
    scheduleHead.appendChild(scheduleTitle);
    var dateControls = element('div', 'schedule-date-controls');
    [['prev', '‹'], ['today', '今天'], ['next', '›']].forEach(function (entry) {
      var control = element('button', 'btn gray sm', entry[1]);
      control.type = 'button';
      control.addEventListener('click', function () {
        if (entry[0] === 'today') return loadCalendarDate(dateKey(new Date()));
        var base = new Date((model.schedule.date || dateKey(new Date())) + 'T00:00:00');
        base.setDate(base.getDate() + (entry[0] === 'next' ? 1 : -1));
        loadCalendarDate(dateKey(base));
      });
      dateControls.appendChild(control);
    });
    scheduleHead.appendChild(dateControls);
    scheduleCard.appendChild(scheduleHead);
    var scheduleBody = element('div', 'schedule-agenda');
    var shift = model.schedule.shift;
    var shiftBlock = element('div', 'schedule-block schedule-shift');
    shiftBlock.appendChild(element('strong', '', shift
      ? (shift.templateName || (shift.assignmentType === 'leave' ? '请假' : shift.assignmentType === 'rest' ? '休息' : '上班'))
      : model.schedule.emptyShiftLabel));
    shiftBlock.appendChild(element('span', '', shift && shift.startAt && shift.endAt
      ? shift.startAt.slice(11, 16) + '—' + shift.endAt.slice(11, 16)
      : (shift && shift.leaveType ? shift.leaveType : '')));
    scheduleBody.appendChild(shiftBlock);
    var eventGroup = element('div', 'schedule-events');
    if (!model.schedule.events.length) eventGroup.appendChild(element('div', 'my-empty', model.schedule.emptyEventsLabel));
    model.schedule.events.forEach(function (event) {
      var item = element('div', 'schedule-block schedule-ticket');
      item.appendChild(element('strong', '', event.ticketId + ' · ' + (event.category || '工单')));
      item.appendChild(element('span', '', (event.startAt || '').slice(11, 16) + '—' + (event.endAt || '').slice(11, 16) + ' · ' + (event.location || event.description || '')));
      eventGroup.appendChild(item);
    });
    scheduleBody.appendChild(eventGroup);
    if (model.schedule.hasConflict) scheduleBody.appendChild(element('div', 'management-warning', '当前日程存在工单时间重叠，请联系主管调整。'));
    scheduleCard.appendChild(scheduleBody);
    rootNode.appendChild(scheduleCard);
    var directoryCard = element('section', 'card my-directory-card');
    directoryCard.appendChild(element('h3', '', '同小区员工通讯录'));
    if (!model.directory.length) directoryCard.appendChild(element('div', 'my-empty', '暂无可见同事或当前小区未配置通讯录。'));
    model.directory.forEach(function (person) {
      var row = element('div', 'my-directory-row');
      row.appendChild(element('strong', '', person.name || '未命名'));
      row.appendChild(element('span', '', (person.position || '员工') + ' · ' + (person.phone || '未登记手机号')));
      directoryCard.appendChild(row);
    });
    rootNode.appendChild(directoryCard);
  }

  async function request(path, options) {
    if (typeof API !== 'undefined' && !options) return API.get(path);
    if (typeof API !== 'undefined' && options && options.method === 'PATCH') return API.patch(path, options.body);
    return { ok: false, error: '服务暂不可用' };
  }

  function dateKey(value) {
    return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0')
      + '-' + String(value.getDate()).padStart(2, '0');
  }

  function calendarPayload(result) {
    if (!result || result.ok === false) return {};
    if (result.data) return result.data;
    if (!result.date) return {};
    var payload = Object.assign({}, result);
    delete payload.ok;
    return payload;
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
      var communityId = state.profile.community_id || localStorage.getItem('juzi_oa_community_v1') || 'default';
      var results = await Promise.all([
        request(statsPath),
        request('/api/calendar/day?date=' + encodeURIComponent(state.calendarDate || dateKey(new Date()))),
        request('/api/staff/directory?community_id=' + encodeURIComponent(communityId))
      ]);
      var stats = results[0].ok ? results[0].data : {};
      state.stats = stats;
      state.calendar = calendarPayload(results[1]);
      state.directory = results[2].ok ? (results[2].data || []) : [];
      state.calendarDate = state.calendar.date || state.calendarDate || dateKey(new Date());
      render(buildMyPageModel(state.profile, stats, [], state.period, state.calendar,
        results[2].ok ? (results[2].data || []) : []));
    } catch (error) {
      if (rootNode) {
        rootNode.replaceChildren(element('div', 'card my-empty',
          '主管个人中心加载异常：' + (error && error.message ? error.message : '请刷新重试')));
      }
    } finally {
      state.busy = false;
      if (rootNode) rootNode.setAttribute('aria-busy', 'false');
    }
  }

  async function loadCalendarDate(date) {
    if (!date || state.busy) return;
    state.calendarDate = date;
    var result = await request('/api/calendar/day?date=' + encodeURIComponent(date));
    if (result.ok) {
      state.calendar = calendarPayload(result);
      render(buildMyPageModel(state.profile, state.stats, [], state.period, state.calendar, state.directory || []));
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

  return { buildMyPageModel: buildMyPageModel, calendarPayload: calendarPayload, init: load, render: render };
}));
