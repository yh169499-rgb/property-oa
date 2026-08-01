(function () {
  'use strict';

  var MANAGEMENT_TABS = [
    'organization', 'schedule', 'attendance', 'registrations', 'reports', 'settings'
  ];
  var TAB_LABELS = {
    organization: '组织架构', schedule: '排班', attendance: '考勤',
    registrations: '注册审核', reports: '报告', settings: '设置'
  };
  var loaded = {};
  var profiles = [];
  var organization = { tree: [], unassigned: [] };
  var expanded = {};
  var activeTab = 'organization';

  function root() { return document.getElementById('management-workspace'); }
  function token() { return localStorage.getItem('auth_token'); }
  function headers(json) {
    var value = {};
    if (json) value['Content-Type'] = 'application/json';
    if (token()) value.Authorization = 'Bearer ' + token();
    return value;
  }
  async function request(path, options) {
    var response = await fetch((window.API_BASE || '') + path, Object.assign({}, options, {
      headers: Object.assign(headers(options && options.body), options && options.headers)
    }));
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(body.error || '请求失败');
      error.code = body.code;
      error.details = body.details || {};
      throw error;
    }
    return Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
  }
  function empty(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function node(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function field(label, control) {
    var wrap = node('label', 'management-field');
    wrap.appendChild(node('span', '', label));
    wrap.appendChild(control);
    return wrap;
  }
  function select(options, value) {
    var el = node('select');
    options.forEach(function (option) {
      var item = node('option', '', option.label);
      item.value = option.value == null ? '' : String(option.value);
      el.appendChild(item);
    });
    el.value = value == null ? '' : String(value);
    return el;
  }
  function statusLabel(value) {
    return value === 'active' ? '在岗' : value === 'inactive' ? '已停用' : (value || '在岗');
  }
  function showMessage(container, text, error) {
    var old = container.querySelector('.management-inline-message');
    if (old) old.remove();
    var message = node('div', 'management-inline-message' + (error ? ' error' : ''), text);
    container.appendChild(message);
    return message;
  }
  function profileMap() {
    var result = {};
    profiles.forEach(function (profile) { result[profile.id] = profile; });
    return result;
  }
  function pathFor(profileId, overrideManagerId) {
    var byId = profileMap();
    var current = byId[profileId];
    var parts = [];
    var seen = {};
    while (current && !seen[current.id]) {
      seen[current.id] = true;
      parts.unshift(current.name || ('人员 #' + current.id));
      var managerId = current.id === profileId && overrideManagerId !== undefined
        ? overrideManagerId : current.manager_id;
      current = managerId ? byId[managerId] : null;
    }
    return parts.join(' / ') || '未分配';
  }

  function init() {
    var container = root();
    if (!container || container.dataset.ready) return;
    container.dataset.ready = 'true';
    var tabs = node('div', 'management-tabs');
    MANAGEMENT_TABS.forEach(function (tab) {
      var button = node('button', 'management-tab' + (tab === activeTab ? ' active' : ''), TAB_LABELS[tab]);
      button.type = 'button';
      button.dataset.tab = tab;
      button.addEventListener('click', function () { activate(tab); });
      tabs.appendChild(button);
    });
    container.appendChild(tabs);
    MANAGEMENT_TABS.forEach(function (tab) {
      var panel = node('section', 'management-panel');
      panel.dataset.panel = tab;
      panel.hidden = tab !== activeTab;
      container.appendChild(panel);
    });
    activate(activeTab);
  }

  function activate(tab) {
    if (MANAGEMENT_TABS.indexOf(tab) < 0) return;
    activeTab = tab;
    root().querySelectorAll('.management-tab').forEach(function (button) {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    root().querySelectorAll('.management-panel').forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== tab;
    });
    if (!loaded[tab]) {
      loaded[tab] = true;
      loadTab(tab).catch(function (error) {
        loaded[tab] = false;
        renderFailure(tab, error);
      });
    }
  }
  function panel(tab) { return root().querySelector('[data-panel="' + tab + '"]'); }
  function renderFailure(tab, error) {
    var target = panel(tab);
    empty(target);
    target.appendChild(node('div', 'management-state error', error.message || '加载失败'));
    var retry = node('button', 'btn sm', '重试');
    retry.addEventListener('click', function () { loaded[tab] = false; activate(tab); });
    target.appendChild(retry);
  }
  async function loadTab(tab) {
    panel(tab).appendChild(node('div', 'management-state', '加载中…'));
    if (tab === 'organization') return loadOrganization();
    if (tab === 'schedule') return loadSchedule();
    if (tab === 'attendance') return renderAttendance();
    if (tab === 'registrations') return renderRegistrations();
    if (tab === 'reports') return renderReports();
    return renderSettings();
  }

  async function loadOrganization() {
    var results = await Promise.all([
      request('/api/organization/tree'),
      request('/api/staff/profiles')
    ]);
    organization = results[0] || { tree: [], unassigned: [] };
    profiles = results[1] || [];
    organization.tree.forEach(function (profile) { expanded[profile.id] = true; });
    renderOrganization();
  }
  function renderOrganization() {
    var target = panel('organization');
    empty(target);
    var toolbar = node('div', 'management-toolbar');
    var search = node('input');
    search.type = 'search';
    search.placeholder = '搜索姓名、职位或技能';
    toolbar.appendChild(search);
    var refresh = node('button', 'btn gray sm', '刷新');
    refresh.addEventListener('click', function () { loaded.organization = false; activate('organization'); });
    toolbar.appendChild(refresh);
    target.appendChild(toolbar);
    var layout = node('div', 'organization-layout');
    var tree = node('div', 'organization-tree card');
    var detail = node('aside', 'organization-detail card');
    detail.appendChild(node('div', 'management-state', '选择人员查看档案'));
    layout.appendChild(tree);
    layout.appendChild(detail);
    target.appendChild(layout);

    function draw(query) {
      empty(tree);
      var normalized = (query || '').trim().toLowerCase();
      var matches = function (profile) {
        return [profile.name, profile.position, profile.skill].some(function (value) {
          return String(value || '').toLowerCase().indexOf(normalized) >= 0;
        });
      };
      tree.appendChild(node('h3', '', '组织层级'));
      organization.tree.forEach(function (profile) {
        renderTreeNode(tree, profile, normalized, matches, detail);
      });
      var unassigned = node('div', 'unassigned-group');
      unassigned.appendChild(node('h3', '', '未分配人员'));
      (organization.unassigned || []).filter(function (profile) {
        return !normalized || matches(profile);
      }).forEach(function (profile) {
        renderTreeNode(unassigned, profile, normalized, matches, detail);
      });
      if (!unassigned.querySelector('.organization-person')) {
        unassigned.appendChild(node('div', 'management-state', normalized ? '没有匹配人员' : '暂无未分配人员'));
      }
      tree.appendChild(unassigned);
    }
    search.addEventListener('input', function () { draw(search.value); });
    draw('');
  }
  function treeMatches(profile, query, matches) {
    return !query || matches(profile) || (profile.children || []).some(function (child) {
      return treeMatches(child, query, matches);
    });
  }
  function renderTreeNode(parent, profile, query, matches, detail) {
    if (!treeMatches(profile, query, matches)) return;
    var wrap = node('div', 'organization-node');
    var row = node('div', 'organization-person' + (query && matches(profile) ? ' search-hit' : ''));
    var children = profile.children || [];
    var toggle = node('button', 'organization-toggle', children.length ? (expanded[profile.id] ? '−' : '+') : '·');
    toggle.disabled = !children.length;
    row.appendChild(toggle);
    var summary = node('button', 'organization-summary');
    summary.type = 'button';
    summary.appendChild(node('strong', '', profile.name || '未命名'));
    summary.appendChild(node('span', '', (profile.position || '未设职位') + ' · ' + statusLabel(profile.employment_status)));
    summary.appendChild(node('small', '', '直属 ' + children.length + ' 人'));
    summary.addEventListener('click', function () { renderProfileDetail(detail, profile); });
    row.appendChild(summary);
    wrap.appendChild(row);
    if (children.length) {
      var branch = node('div', 'organization-children');
      branch.hidden = !expanded[profile.id] && !query;
      children.forEach(function (child) { renderTreeNode(branch, child, query, matches, detail); });
      toggle.addEventListener('click', function () {
        expanded[profile.id] = !expanded[profile.id];
        toggle.textContent = expanded[profile.id] ? '−' : '+';
        branch.hidden = !expanded[profile.id];
      });
      wrap.appendChild(branch);
    }
    parent.appendChild(wrap);
  }
  function renderProfileDetail(detail, profile) {
    empty(detail);
    detail.appendChild(node('h3', '', profile.name || '人员详情'));
    [
      ['职位', profile.position || '未设置'], ['技能', profile.skill || '未设置'],
      ['入职日期', profile.join_date || '未设置'], ['在职状态', statusLabel(profile.employment_status)],
      ['组织路径', pathFor(profile.id)]
    ].forEach(function (item) {
      var row = node('div', 'profile-detail-row');
      row.appendChild(node('span', '', item[0]));
      row.appendChild(node('strong', '', item[1]));
      detail.appendChild(row);
    });
    var actions = node('div', 'management-actions');
    var edit = node('button', 'btn sm', '编辑档案');
    edit.addEventListener('click', function () { openProfileEditor(profile); });
    var manager = node('button', 'btn gray sm', '调整直属上级');
    manager.addEventListener('click', function () { openManagerDialog(profile); });
    actions.appendChild(edit);
    actions.appendChild(manager);
    detail.appendChild(actions);
  }

  function modal(title) {
    var mask = node('div', 'management-modal-mask');
    var box = node('div', 'management-modal');
    var head = node('div', 'management-modal-head');
    head.appendChild(node('h3', '', title));
    var close = node('button', 'management-modal-close', '×');
    close.addEventListener('click', function () { mask.remove(); });
    head.appendChild(close);
    box.appendChild(head);
    mask.appendChild(box);
    document.body.appendChild(mask);
    return { mask: mask, box: box };
  }
  function managerOptions(excludeId) {
    return [{ value: '', label: '未分配上级' }].concat(profiles.filter(function (profile) {
      return Number(profile.id) !== Number(excludeId);
    }).map(function (profile) {
      return { value: profile.id, label: profile.name + ' · ' + (profile.position || '未设职位') };
    }));
  }
  function openManagerDialog(profile) {
    var dialog = modal('调整直属上级');
    var manager = select(managerOptions(profile.id), profile.manager_id);
    var oldPath = node('strong', '', pathFor(profile.id));
    var newPath = node('strong', '', pathFor(profile.id, manager.value || null));
    dialog.box.appendChild(field('新直属上级', manager));
    var compare = node('div', 'manager-paths');
    compare.appendChild(node('span', '', '原路径'));
    compare.appendChild(oldPath);
    compare.appendChild(node('span', '', '新路径'));
    compare.appendChild(newPath);
    dialog.box.appendChild(compare);
    manager.addEventListener('change', function () {
      newPath.textContent = pathFor(profile.id, manager.value || null);
      var old = dialog.box.querySelector('.management-inline-message');
      if (old) old.remove();
    });
    var save = node('button', 'btn', '保存调整');
    save.addEventListener('click', async function () {
      save.disabled = true;
      try {
        await request('/api/staff/profiles/' + profile.id + '/manager', {
          method: 'PATCH', body: JSON.stringify({ manager_id: manager.value || null })
        });
        dialog.mask.remove();
        loaded.organization = false;
        activate('organization');
      } catch (error) {
        var text = error.message;
        if (error.code === 'ORGANIZATION_CYCLE') {
          var byId = profileMap();
          var cycle = (error.details.path || []).map(function (id) {
            return byId[id] ? byId[id].name : ('#' + id);
          }).join(' → ');
          text = '无法保存：检测到组织循环' + (cycle ? '（' + cycle + '）' : '');
        }
        showMessage(dialog.box, text, true);
        save.disabled = false;
      }
    });
    dialog.box.appendChild(save);
  }
  function openProfileEditor(profile) {
    var dialog = modal('编辑人员档案');
    var joinDate = node('input'); joinDate.type = 'date'; joinDate.value = profile.join_date || '';
    var position = node('input'); position.value = profile.position || '';
    var skill = node('input'); skill.value = profile.skill || '';
    var manager = select(managerOptions(profile.id), profile.manager_id);
    var employment = select([
      { value: 'active', label: '在岗' }, { value: 'inactive', label: '停用' }
    ], profile.employment_status || 'active');
    [
      ['入职日期', joinDate], ['职位', position], ['技能', skill],
      ['直属上级', manager], ['在职状态', employment]
    ].forEach(function (item) { dialog.box.appendChild(field(item[0], item[1])); });
    var warning = node('div', 'management-warning',
      '停用档案不会在本轮自动禁用登录账号');
    warning.hidden = employment.value !== 'inactive';
    employment.addEventListener('change', function () { warning.hidden = employment.value !== 'inactive'; });
    dialog.box.appendChild(warning);
    var save = node('button', 'btn', '保存档案');
    save.addEventListener('click', async function () {
      save.disabled = true;
      try {
        await request('/api/staff/profiles/' + profile.id, {
          method: 'PATCH',
          body: JSON.stringify({
            join_date: joinDate.value || null, position: position.value.trim(),
            skill: skill.value.trim(), manager_id: manager.value || null,
            employment_status: employment.value
          })
        });
        dialog.mask.remove();
        loaded.organization = false;
        activate('organization');
      } catch (error) {
        showMessage(dialog.box, error.message, true);
        save.disabled = false;
      }
    });
    dialog.box.appendChild(save);
  }

  async function loadSchedule() {
    var target = panel('schedule');
    var today = window.WorkforceUtils.localDateKey(new Date());
    var results = await Promise.all([
      request('/api/shift-templates'),
      profiles.length ? Promise.resolve(profiles) : request('/api/staff/profiles')
    ]);
    profiles = results[1] || [];
    empty(target);
    var toolbar = node('div', 'management-toolbar');
    var date = node('input'); date.type = 'date'; date.value = today;
    var staff = select([{ value: '', label: '全部人员' }].concat(profiles.map(function (p) {
      return { value: p.id, label: p.name };
    })), '');
    var type = select([
      { value: 'work', label: '上班' }, { value: 'rest', label: '休息' },
      { value: 'leave', label: '请假' }
    ], 'work');
    var template = select([{ value: '', label: '不使用模板' }].concat((results[0] || []).map(function (t) {
      return { value: t.id, label: t.name };
    })), '');
    if ((results[0] || []).length) template.value = String(results[0][0].id);
    var leaveType = select([
      { value: '事假', label: '事假' }, { value: '病假', label: '病假' },
      { value: '年假', label: '年假' }, { value: '其他', label: '其他' }
    ], '事假');
    var templateField = field('模板', template);
    var leaveField = field('请假类型', leaveType); leaveField.hidden = true;
    function syncAssignmentFields() {
      templateField.hidden = type.value !== 'work';
      leaveField.hidden = type.value !== 'leave';
    }
    type.addEventListener('change', syncAssignmentFields);
    [field('日期', date), field('人员', staff), field('类型', type), templateField, leaveField]
      .forEach(function (el) { toolbar.appendChild(el); });
    syncAssignmentFields();
    var list = node('div', 'management-list card');
    var calendar = node('div', 'management-calendar card');
    async function refresh() {
      var url = '/api/shifts?work_date=' + encodeURIComponent(date.value);
      if (staff.value) url += '&staff_id=' + encodeURIComponent(staff.value);
      empty(list);
      list.appendChild(node('div', 'management-state', '加载中…'));
      try {
        var assignments = await request(url);
        empty(list);
        (assignments || []).forEach(function (shift) {
          var person = profiles.find(function (p) {
            return Number(p.id) === Number(shift.staff_id);
          });
          var row = node('div', 'management-list-row');
          row.appendChild(node('strong', '',
            shift.staff_name || (person ? person.name : ('人员 #' + shift.staff_id))));
          row.appendChild(node('span', '',
            shift.work_date + ' · ' + shift.assignment_type
            + (shift.template_name ? ' · ' + shift.template_name : '')));
          var remove = node('button', 'btn gray sm', '删除');
          remove.addEventListener('click', async function () {
            try {
              await request('/api/shifts/' + shift.id, { method: 'DELETE' });
              await refresh();
            } catch (error) {
              showMessage(target, error.message, true);
            }
          });
          row.appendChild(remove);
          list.appendChild(row);
        });
        if (!list.firstChild) list.appendChild(node('div', 'management-state', '所选条件暂无排班'));
        var calendarUrl = '/api/calendar/day?date=' + encodeURIComponent(date.value);
        if (staff.value) calendarUrl += '&staff_id=' + encodeURIComponent(staff.value);
        var calendarData = await request(calendarUrl);
        window.ResponsiveCalendar.render(calendar, calendarData || {}, { width: window.innerWidth });
      } catch (error) {
        empty(list);
        showMessage(list, error.message, true);
      }
    }
    date.addEventListener('change', refresh);
    staff.addEventListener('change', refresh);
    var add = node('button', 'btn sm', '新增排班');
    add.addEventListener('click', async function () {
      if (!staff.value) return showMessage(target, '请选择人员', true);
      if (type.value === 'work' && !template.value) {
        return showMessage(target, '上班排班请选择班次模板', true);
      }
      try {
        await request('/api/shifts', {
          method: 'POST', body: JSON.stringify({
            staffId: Number(staff.value), workDate: date.value,
            assignmentType: type.value,
            templateId: type.value === 'work' && template.value ? Number(template.value) : null,
            leaveType: type.value === 'leave' ? leaveType.value : null
          })
        });
        await refresh();
      } catch (error) { showMessage(target, error.message, true); }
    });
    toolbar.appendChild(add);
    var batch = node('button', 'btn gray sm', '批量排班');
    batch.addEventListener('click', function () {
      var dialog = modal('批量排班');
      var people = node('select'); people.multiple = true; people.size = Math.min(8, Math.max(3, profiles.length));
      profiles.forEach(function (profile) {
        var option = node('option', '', profile.name); option.value = profile.id; people.appendChild(option);
      });
      var from = node('input'); from.type = 'date'; from.value = date.value;
      var to = node('input'); to.type = 'date'; to.value = date.value;
      var batchType = select([
        { value: 'work', label: '上班' }, { value: 'rest', label: '休息' }, { value: 'leave', label: '请假' }
      ], type.value);
      var batchTemplate = select([{ value: '', label: '不使用模板' }].concat((results[0] || []).map(function (item) {
        return { value: item.id, label: item.name };
      })), template.value);
      var batchLeaveType = select([
        { value: '事假', label: '事假' }, { value: '病假', label: '病假' },
        { value: '年假', label: '年假' }, { value: '其他', label: '其他' }
      ], '事假');
      var batchTemplateField = field('模板', batchTemplate);
      var batchLeaveField = field('请假类型', batchLeaveType);
      function syncBatchFields() {
        batchTemplateField.hidden = batchType.value !== 'work';
        batchLeaveField.hidden = batchType.value !== 'leave';
      }
      batchType.addEventListener('change', syncBatchFields);
      [field('人员（可多选）', people), field('开始日期', from), field('结束日期', to),
        field('类型', batchType), batchTemplateField, batchLeaveField]
        .forEach(function (item) { dialog.box.appendChild(item); });
      syncBatchFields();
      var submit = node('button', 'btn', '保存批量排班');
      submit.addEventListener('click', async function () {
        var staffIds = Array.from(people.selectedOptions).map(function (item) { return Number(item.value); });
        if (!staffIds.length) return showMessage(dialog.box, '请至少选择一名人员', true);
        if (batchType.value === 'work' && !batchTemplate.value) {
          return showMessage(dialog.box, '上班排班请选择班次模板', true);
        }
        var dates = [];
        var cursor = new Date(from.value + 'T00:00:00+08:00');
        var end = new Date(to.value + 'T00:00:00+08:00');
        if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor > end) {
          return showMessage(dialog.box, '日期范围无效', true);
        }
        while (cursor <= end && dates.length <= 62) {
          dates.push(window.WorkforceUtils.localDateKey(cursor));
          cursor = new Date(cursor.getTime() + 86400000);
        }
        if (dates.length > 62) return showMessage(dialog.box, '单次最多安排 62 天', true);
        var payload = {
          staffIds: staffIds, dates: dates, assignmentType: batchType.value,
          templateId: batchType.value === 'work' && batchTemplate.value
            ? Number(batchTemplate.value) : null,
          leaveType: batchType.value === 'leave' ? batchLeaveType.value : null,
          overwrite: false
        };
        submit.disabled = true;
        try {
          try {
            await request('/api/shifts/batch', { method: 'POST', body: JSON.stringify(payload) });
          } catch (error) {
            if (error.code !== 'SHIFT_ALREADY_EXISTS' || !window.confirm('发现已有排班，是否覆盖冲突日期？')) throw error;
            payload.overwrite = true;
            await request('/api/shifts/batch', { method: 'POST', body: JSON.stringify(payload) });
          }
          dialog.mask.remove();
          await refresh();
        } catch (error) {
          showMessage(dialog.box, error.message, true); submit.disabled = false;
        }
      });
      dialog.box.appendChild(submit);
    });
    toolbar.appendChild(batch);
    target.appendChild(toolbar);
    target.appendChild(list);
    target.appendChild(calendar);
    await refresh();
  }
  function renderAttendance() {
    var target = panel('attendance'); empty(target);
    var toolbar = node('div', 'management-toolbar');
    var date = node('input'); date.type = 'date'; date.value = window.WorkforceUtils.localDateKey(new Date());
    toolbar.appendChild(field('日期', date));
    target.appendChild(toolbar);
    var summary = node('div', 'manager-today-grid');
    var detail = node('div', 'management-list card');
    target.appendChild(summary); target.appendChild(detail);
    target.appendChild(node('div', 'management-warning', '本轮暂未启用签到、补卡和考勤修正；此处只读展示已有考勤记录。'));
    async function refresh() {
      empty(summary); empty(detail);
      try {
        var data = await request('/api/calendar/day?date=' + encodeURIComponent(date.value));
        var people = data.people || [];
        var actual = people.filter(function (person) { return person.attendance; });
        var abnormal = actual.filter(function (person) {
          return !['normal', 'rest', 'leave'].includes(person.attendance.status);
        });
        [['应到', people.filter(function (p) { return p.shift && p.shift.assignmentType === 'work'; }).length],
          ['已有记录', actual.length], ['异常', abnormal.length]].forEach(function (item) {
          var card = node('div', 'card manager-today-card'); card.appendChild(node('span', '', item[0]));
          card.appendChild(node('strong', '', item[1] + ' 人')); summary.appendChild(card);
        });
        people.forEach(function (person) {
          var row = node('div', 'management-list-row');
          row.appendChild(node('strong', '', person.name));
          row.appendChild(node('span', '', person.attendance ? person.attendance.status : '暂无记录'));
          detail.appendChild(row);
        });
      } catch (error) { showMessage(detail, error.message, true); }
    }
    date.addEventListener('change', refresh); refresh();
  }
  function renderRegistrations() {
    var target = panel('registrations'); empty(target);
    var title = node('h3', '', '注册审核 ');
    var count = node('span');
    count.id = 'pending-count';
    title.appendChild(count);
    target.appendChild(title);
    var mount = node('div', 'card');
    mount.id = 'pending-reg-list';
    mount.appendChild(node('div', 'management-state', '加载中…'));
    target.appendChild(mount);
    if (typeof window.loadPendingRegistrations === 'function') {
      window.loadPendingRegistrations();
    } else {
      empty(mount);
      mount.appendChild(node('div', 'management-state', '注册审核入口暂不可用'));
    }
  }
  function renderReports() {
    var target = panel('reports'); empty(target);
    target.appendChild(node('div', 'management-state card', '报告模块正在接入，当前可从首页生成工单报告。'));
    var button = node('button', 'btn sm', '打开现有报告');
    button.addEventListener('click', function () { if (typeof window.showReport === 'function') window.showReport(); });
    target.appendChild(button);
  }
  function renderSettings() {
    var target = panel('settings'); empty(target);
    target.appendChild(node('h3', '', '系统设置'));
    var links = node('div', 'management-settings-grid');
    var community = node('button', 'card management-setting', '小区管理');
    community.addEventListener('click', function () { if (typeof window.openCommunityModal === 'function') window.openCommunityModal(); });
    links.appendChild(community);
    var intervals = [1, 3, 5, 10, 15, 30, 60, 0].map(function (minutes) {
      return { value: minutes, label: minutes ? minutes + ' 分钟' : '关闭推送' };
    });
    var reminder = node('div', 'card management-setting');
    reminder.appendChild(node('strong', '', '待派单提醒'));
    var reminderSelect = select(intervals, 5);
    reminderSelect.id = 'reminder-interval';
    reminder.appendChild(reminderSelect);
    var reminderButton = node('button', 'btn sm', '保存');
    reminderButton.addEventListener('click', function () {
      if (typeof window.saveReminderInterval === 'function') window.saveReminderInterval();
    });
    reminder.appendChild(reminderButton);
    var reminderStatus = node('span');
    reminderStatus.id = 'reminder-status';
    reminder.appendChild(reminderStatus);
    links.appendChild(reminder);
    var sla = node('div', 'card management-setting');
    sla.appendChild(node('strong', '', 'SLA 超时告警'));
    var slaSelect = select(intervals.slice(2), 0);
    slaSelect.id = 'sla-interval';
    sla.appendChild(slaSelect);
    var slaButton = node('button', 'btn sm', '保存');
    slaButton.addEventListener('click', function () {
      if (typeof window.saveSlaInterval === 'function') window.saveSlaInterval();
    });
    sla.appendChild(slaButton);
    var slaStatus = node('span');
    slaStatus.id = 'sla-status';
    sla.appendChild(slaStatus);
    links.appendChild(sla);
    target.appendChild(links);
    if (typeof window.loadReminderInterval === 'function') window.loadReminderInterval();
  }

  window.ManagementWorkspace = {
    tabs: MANAGEMENT_TABS.slice(),
    init: init,
    activate: activate,
    refreshOrganization: function () { loaded.organization = false; activate('organization'); }
  };
})();
