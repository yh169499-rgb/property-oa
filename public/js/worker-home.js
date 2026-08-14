(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkerHome = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var busy = false;

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function buildWorkerHomeModel(profile, stats, calendar, directory) {
    profile = profile || {};
    stats = stats || {};
    calendar = calendar || {};
    directory = Array.isArray(directory) ? directory : [];
    var person = (calendar.people || []).find(function (item) {
      return Number(item.id) === Number(profile.id);
    }) || (calendar.people || [])[0] || { shift: null };
    var events = (calendar.events || []).filter(function (event) {
      return event.staffId == null || Number(event.staffId) === Number(profile.id);
    });
    var eventIds = new Set(events.map(function (event) { return event.ticketId; }));
    var conflictTicketIds = [];
    (calendar.conflicts || []).forEach(function (conflict) {
      if ((conflict.ticketIds || []).some(function (ticketId) { return eventIds.has(ticketId); })) {
        (conflict.ticketIds || []).forEach(function (ticketId) {
          if (!conflictTicketIds.includes(ticketId)) conflictTicketIds.push(ticketId);
        });
      }
    });

    return {
      name: profile.name || '未命名员工',
      position: profile.position || '维修师傅',
      date: calendar.date || '',
      metrics: {
        received: number(stats.received && stats.received.total),
        completed: number(stats.completed && stats.completed.total),
        doing: number(stats.current && stats.current.doing),
        pending: number(stats.current && stats.current.pending),
        returned: number(stats.current && stats.current.returned),
        onTimeRate: number(stats.completed && stats.completed.onTimeRate),
      },
      schedule: {
        shift: person.shift || null,
        shifts: person.shifts || (person.shift ? [person.shift] : []),
        events: events,
        hasConflict: conflictTicketIds.length > 0,
        conflictTicketIds: conflictTicketIds,
      },
      directory: directory,
    };
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function metric(label, value, detail) {
    var card = element('div', 'worker-kpi');
    card.appendChild(element('span', 'worker-kpi-label', label));
    card.appendChild(element('strong', 'worker-kpi-value', value));
    card.appendChild(element('small', '', detail));
    return card;
  }

  function shiftText(shift) {
    if (!shift) return { title: '今天未安排班次', time: '如需排班，请联系主管' };
    var title = shift.templateName || (shift.assignmentType === 'leave'
      ? (shift.leaveType || '请假')
      : shift.assignmentType === 'rest' ? '休息' : '上班');
    var time = shift.startAt && shift.endAt
      ? shanghaiTime(shift.startAt) + '—' + shanghaiTime(shift.endAt)
        + (shift.assignmentType === 'work' ? ' · 该时段内可派单' : '')
      : (shift.leaveType || '');
    return { title: title, time: time };
  }

  function shanghaiTime(value) {
    return typeof WorkforceUtils !== 'undefined' && WorkforceUtils.shanghaiTime
      ? WorkforceUtils.shanghaiTime(value) : String(value || '').slice(11, 16);
  }

  function render(model) {
    var rootNode = document.getElementById('worker-home-root');
    if (!rootNode) return;
    rootNode.replaceChildren();

    var hero = element('section', 'worker-hero');
    var intro = element('div');
    intro.appendChild(element('span', 'worker-eyebrow', '师傅工作台'));
    intro.appendChild(element('h2', '', model.name));
    intro.appendChild(element('p', '', model.position + ' · 今日任务与日程'));
    hero.appendChild(intro);
    var myButton = element('button', 'btn worker-profile-link', '查看个人资料');
    myButton.type = 'button';
    myButton.addEventListener('click', function () {
      if (typeof navTo === 'function') navTo('my');
    });
    hero.appendChild(myButton);
    rootNode.appendChild(hero);

    var ticketLinks = element('section', 'card worker-ticket-links');
    ticketLinks.appendChild(element('h3', '', '我的工单'));
    var ticketLinkGrid = element('div', 'worker-ticket-link-grid');
    [
      { page: 'repair', title: '报修工单', detail: '查看分配给我的报修任务' },
      { page: 'complaint', title: '投诉工单', detail: '查看分配给我的投诉任务' },
      { page: 'help', title: '帮助工单', detail: '查看分配给我的帮助任务' },
    ].forEach(function (entry) {
      var button = element('button', 'worker-ticket-link');
      button.type = 'button';
      button.appendChild(element('strong', '', entry.title));
      button.appendChild(element('span', '', entry.detail));
      button.addEventListener('click', function () {
        if (typeof navTo === 'function') navTo(entry.page);
      });
      ticketLinkGrid.appendChild(button);
    });
    ticketLinks.appendChild(ticketLinkGrid);
    rootNode.appendChild(ticketLinks);

    var metrics = element('div', 'worker-kpi-grid');
    metrics.appendChild(metric('本月接单', model.metrics.received + ' 张', '本人负责工单'));
    metrics.appendChild(metric('本月完成', model.metrics.completed + ' 张', '已完成并归档'));
    metrics.appendChild(metric('当前处理中', model.metrics.doing + ' 张', '需要继续处理'));
    metrics.appendChild(metric('搁置 / 退回', model.metrics.pending + ' / ' + model.metrics.returned + ' 张', '请及时查看原因'));
    metrics.appendChild(metric('按时完成率', model.metrics.onTimeRate + '%', '按工单 SLA 计算'));
    rootNode.appendChild(metrics);

    var content = element('div', 'worker-home-grid');
    var schedule = element('section', 'card worker-schedule-panel');
    var heading = element('div', 'worker-section-head');
    var headingText = element('div');
    headingText.appendChild(element('h3', '', '今日日程'));
    headingText.appendChild(element('p', '', model.date || '今日'));
    heading.appendChild(headingText);
    var mySchedule = element('button', 'btn gray sm', '完整日程');
    mySchedule.type = 'button';
    mySchedule.addEventListener('click', function () {
      if (typeof navTo === 'function') navTo('my');
    });
    heading.appendChild(mySchedule);
    schedule.appendChild(heading);

    var shifts = model.schedule.shifts.length ? model.schedule.shifts : [null];
    shifts.forEach(function (item) {
      var shift = shiftText(item);
      var shiftBlock = element('div', 'worker-shift-block');
      shiftBlock.appendChild(element('strong', '', shift.title));
      shiftBlock.appendChild(element('span', '', shift.time));
      schedule.appendChild(shiftBlock);
    });
    if (model.schedule.hasConflict) {
      schedule.appendChild(element('div', 'management-warning',
        '工单 ' + model.schedule.conflictTicketIds.join(' 与 ') + ' 时间重叠，请尽快联系主管调整。'));
    }
    content.appendChild(schedule);

    var tickets = element('section', 'card worker-task-panel');
    tickets.appendChild(element('h3', '', '今日工单时间块'));
    if (!model.schedule.events.length) {
      tickets.appendChild(element('div', 'my-empty', '今天暂无工单时间块'));
    }
    model.schedule.events.forEach(function (event) {
      var item = element('button', 'worker-task-item');
      item.type = 'button';
      var title = element('strong', '', event.ticketId + ' · ' + (event.category || '工单'));
      var time = shanghaiTime(event.startAt) + '—' + shanghaiTime(event.endAt);
      item.appendChild(title);
      item.appendChild(element('span', '', time + ' · ' + (event.location || event.description || '')));
      item.addEventListener('click', function () {
        if (typeof openDrawer === 'function') openDrawer(event.ticketId);
      });
      tickets.appendChild(item);
    });
    content.appendChild(tickets);
    rootNode.appendChild(content);
    var directoryCard = element('section', 'card worker-directory-panel');
    directoryCard.appendChild(element('h3', '', '同小区员工通讯录'));
    if (!model.directory.length) directoryCard.appendChild(element('div', 'my-empty', '暂无可见同事或当前小区未配置通讯录。'));
    model.directory.forEach(function (person) {
      var row = element('div', 'worker-directory-row');
      row.appendChild(element('strong', '', person.name || '未命名'));
      row.appendChild(element('span', '', (person.position || '员工') + ' · ' + (person.phone || '未登记手机号')));
      directoryCard.appendChild(row);
    });
    rootNode.appendChild(directoryCard);
  }

  async function request(path) {
    if (typeof API !== 'undefined') return API.get(path);
    return { ok: false, error: '服务暂不可用' };
  }

  function dateKey(value) {
    return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0')
      + '-' + String(value.getDate()).padStart(2, '0');
  }

  function payload(result) {
    if (!result || result.ok === false) return {};
    return result.data || result;
  }

  async function init() {
    if (busy) return;
    busy = true;
    var rootNode = document.getElementById('worker-home-root');
    if (rootNode) rootNode.setAttribute('aria-busy', 'true');
    try {
      var profileResult = await request('/api/me');
      if (!profileResult.ok || !profileResult.data) throw new Error(profileResult.error || '个人资料加载失败');
      var results = await Promise.all([
        request('/api/me/stats?period=month'),
        request('/api/calendar/day?date=' + encodeURIComponent(dateKey(new Date()))),
        request('/api/staff/directory?community_id=' + encodeURIComponent(
          profileResult.data.community_id || localStorage.getItem('juzi_oa_community_v1') || 'default')),
      ]);
      render(buildWorkerHomeModel(
        profileResult.data,
        results[0].ok ? results[0].data : {},
        payload(results[1]),
        results[2].ok ? (results[2].data || []) : [],
      ));
    } catch (error) {
      if (rootNode) rootNode.replaceChildren(element('div', 'card my-empty',
        '师傅工作台加载失败：' + (error && error.message ? error.message : '请刷新重试')));
    } finally {
      busy = false;
      if (rootNode) rootNode.setAttribute('aria-busy', 'false');
    }
  }

  return { buildWorkerHomeModel: buildWorkerHomeModel, init: init, render: render };
}));
