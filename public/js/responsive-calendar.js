(function () {
  'use strict';
  var utils = window.WorkforceUtils;
  function el(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function minutes(value) {
    var time = utils.shanghaiTime(value).split(':').map(Number);
    return time[0] * 60 + time[1];
  }
  function shiftLabel(shift) {
    if (!shift) return '未排班';
    if (shift.assignmentType === 'rest') return '休息';
    if (shift.assignmentType === 'leave') return '请假' + (shift.leaveType ? ' · ' + shift.leaveType : '');
    return (shift.templateName || shift.template_name || '上班') + (shift.startAt
      ? ' ' + utils.shanghaiTime(shift.startAt) + '–' + utils.shanghaiTime(shift.endAt) : '');
  }
  function personShifts(person) {
    return person.shifts && person.shifts.length ? person.shifts : (person.shift ? [person.shift] : []);
  }
  function personShiftLabel(person) {
    var shifts = personShifts(person);
    return shifts.length ? shifts.map(shiftLabel).join(' / ') : '未排班';
  }
  function attendanceStatusLabel(attendance, shift) {
    if (shift && shift.assignmentType === 'leave') return '请假' + (shift.leaveType ? ' · ' + shift.leaveType : '');
    if (shift && shift.assignmentType === 'rest') return '休息';
    return shift && shift.assignmentType === 'work' ? '班次内可派单' : '未排班';
  }
  function personEvents(data, person) {
    return (data.events || []).filter(function (event) {
      return Number(event.staffId) === Number(person.id);
    }).sort(function (a, b) { return new Date(a.startAt) - new Date(b.startAt); });
  }
  function conflictIds(data, person) {
    var ids = {};
    (data.conflicts || []).filter(function (item) {
      return Number(item.staffId) === Number(person.id);
    }).forEach(function (item) {
      (item.ticketIds || []).forEach(function (id) { ids[String(id)] = true; });
    });
    return ids;
  }
  function openTicket(event) {
    if (typeof window.openDrawer === 'function') window.openDrawer(event.ticketId);
  }
  function renderAgenda(root, data, options) {
    var agenda = el('div', 'calendar-agenda');
    (data.people || []).slice().sort(function (a, b) {
      var aConflict = conflictIds(data, a), bConflict = conflictIds(data, b);
      return Object.keys(bConflict).length - Object.keys(aConflict).length
        || String(a.name).localeCompare(String(b.name), 'zh-CN');
    }).forEach(function (person) {
      var card = el('section', 'calendar-agenda-person');
      var head = el('div', 'calendar-agenda-head');
      head.appendChild(el('strong', '', person.name || ('人员 #' + person.id)));
      head.appendChild(el('span', '', personShiftLabel(person)));
      card.appendChild(head);
      var status = attendanceStatusLabel(person.attendance, person.shift);
      var events = personEvents(data, person);
      var total = events.reduce(function (sum, event) {
        return sum + Math.max(0, new Date(event.endAt) - new Date(event.startAt));
      }, 0) / 3600000;
      var meta = el('div', 'calendar-agenda-meta',
        '当天状态：' + status + ' · 已排工时 ' + total.toFixed(1) + 'h');
      if (person.attendance && typeof options.onDeleteAttendance === 'function') {
        var remove = el('button', 'calendar-attendance-delete', '删除考勤记录');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          remove.disabled = true;
          Promise.resolve(options.onDeleteAttendance(person.attendance, person)).catch(function (error) {
            remove.disabled = false;
            if (typeof options.onError === 'function') options.onError(error);
          });
        });
        meta.appendChild(remove);
      }
      card.appendChild(meta);
      var conflicts = conflictIds(data, person);
      if (Object.keys(conflicts).length) card.appendChild(el('div', 'calendar-conflict-label',
        '工单 ' + Object.keys(conflicts).join(' 与 ') + ' 时间重叠，请调整工单时间'));
      events.forEach(function (event) {
        var row = el('button', 'calendar-agenda-event' + (conflicts[event.ticketId] ? ' conflict' : ''));
        row.type = 'button';
        row.appendChild(el('time', '', utils.shanghaiTime(event.startAt) + '–' + utils.shanghaiTime(event.endAt)));
        row.appendChild(el('span', '', event.ticketId + ' · ' + (event.title || event.category || event.location || '工单')));
        row.addEventListener('click', function () { openTicket(event); });
        card.appendChild(row);
      });
      if (!events.length) card.appendChild(el('div', 'calendar-available', person.shift && person.shift.assignmentType === 'work'
        ? '班次内当前均为可派时段' : '暂无可派时段'));
      agenda.appendChild(card);
    });
    root.appendChild(agenda);
  }
  function renderGrid(root, data, options) {
    var chart = el('div', 'calendar-day-grid');
    chart.style.setProperty('--calendar-people', Math.max(1, (data.people || []).length));
    var ruler = el('div', 'calendar-time-ruler');
    ruler.appendChild(el('div', 'calendar-sticky-head', '时间'));
    for (var hour = 0; hour < 24; hour++) {
      var tick = el('span', '', String(hour).padStart(2, '0') + ':00');
      tick.style.top = (hour / 24 * 100) + '%';
      ruler.appendChild(tick);
    }
    chart.appendChild(ruler);
    (data.people || []).forEach(function (person) {
      var column = el('section', 'calendar-person-column');
      var header = el('header', 'calendar-sticky-head');
      header.appendChild(el('strong', '', person.name + ' · ' + personShiftLabel(person)));
      header.appendChild(el('span', 'calendar-person-status', attendanceStatusLabel(person.attendance, person.shift)));
      var headerConflicts = conflictIds(data, person);
      if (Object.keys(headerConflicts).length) header.appendChild(el('span', 'calendar-person-conflict', '有冲突'));
      if (person.attendance && typeof options.onDeleteAttendance === 'function') {
        var remove = el('button', 'calendar-attendance-delete', '删除考勤记录');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          remove.disabled = true;
          Promise.resolve(options.onDeleteAttendance(person.attendance, person)).catch(function (error) {
            remove.disabled = false;
            if (typeof options.onError === 'function') options.onError(error);
          });
        });
        header.appendChild(remove);
      }
      column.appendChild(header);
      var track = el('div', 'calendar-person-track');
      var workWindows = personShifts(person).filter(function (shift) { return shift.assignmentType === 'work'; })
        .map(function (shift) {
          var start = minutes(shift.startAt), end = minutes(shift.endAt);
          if (end <= start) end += 1440;
          return [Math.max(0, start), Math.min(1440, end)];
        }).sort(function (left, right) { return left[0] - right[0]; });
      if (!workWindows.length) track.classList.add('off-duty');
      else {
        var cursor = 0;
        workWindows.forEach(function (window) {
          if (window[0] > cursor) {
            var gap = el('div', 'calendar-off-duty');
            gap.style.cssText = 'top:' + (cursor / 1440 * 100) + '%;height:' + ((window[0] - cursor) / 1440 * 100) + '%';
            track.appendChild(gap);
          }
          cursor = Math.max(cursor, window[1]);
        });
        if (cursor < 1440) {
          var tail = el('div', 'calendar-off-duty');
          tail.style.cssText = 'top:' + (cursor / 1440 * 100) + '%;height:' + ((1440 - cursor) / 1440 * 100) + '%';
          track.appendChild(tail);
        }
      }
      var events = personEvents(data, person);
      var conflicts = conflictIds(data, person);
      events.forEach(function (event, index) {
        var start = minutes(event.startAt);
        var end = minutes(event.endAt);
        if (end <= start) end = 1440;
        var overlaps = events.filter(function (other) {
          return new Date(other.startAt) < new Date(event.endAt)
            && new Date(other.endAt) > new Date(event.startAt);
        });
        var lane = overlaps.indexOf(event);
        var card = el('button', 'calendar-ticket' + (conflicts[event.ticketId] ? ' conflict' : ''));
        card.type = 'button';
        card.style.top = (start / 1440 * 100) + '%';
        card.style.height = (Math.max(30, end - start) / 1440 * 100) + '%';
        card.style.width = (100 / overlaps.length) + '%';
        card.style.left = ((lane < 0 ? index : lane) * 100 / overlaps.length) + '%';
        card.textContent = event.ticketId + ' ' + utils.shanghaiTime(event.startAt) + '–' + utils.shanghaiTime(event.endAt);
        card.addEventListener('click', function () { openTicket(event); });
        track.appendChild(card);
      });
      var now = new Date();
      if (utils.localDateKey(now) === data.date) {
        var line = el('div', 'calendar-now-line');
        line.style.top = ((now.getHours() * 60 + now.getMinutes()) / 1440 * 100) + '%';
        track.appendChild(line);
      }
      column.appendChild(track);
      chart.appendChild(column);
    });
    root.appendChild(chart);
  }
  function render(root, data, options) {
    if (!root) return;
    root.innerHTML = '';
    var view = utils.selectCalendarView(options && options.width !== undefined
      ? options.width : window.innerWidth);
    root.dataset.calendarView = view;
    var renderOptions = options || {};
    if (view === 'agenda') renderAgenda(root, data || {}, renderOptions);
    else renderGrid(root, data || {}, renderOptions);
    if (!options || options.live !== false) {
      root._responsiveCalendarData = data || {};
      root._responsiveCalendarOptions = Object.assign({}, renderOptions);
      if (!root._responsiveCalendarBound && typeof window.addEventListener === 'function') {
        root._responsiveCalendarBound = true;
        window.addEventListener('resize', function () {
          window.clearTimeout(root._responsiveCalendarResizeTimer);
          root._responsiveCalendarResizeTimer = window.setTimeout(function () {
            render(root, root._responsiveCalendarData || {}, Object.assign({}, root._responsiveCalendarOptions || {}, { live: false }));
          }, 100);
        });
      }
    }
  }
  window.ResponsiveCalendar = { render: render };
}());
