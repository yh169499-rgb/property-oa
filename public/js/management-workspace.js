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
    return body.data;
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
    var today = new Date().toISOString().slice(0, 10);
    var results = await Promise.all([
      request('/api/shifts?from=' + today + '&to=' + today),
      request('/api/shift-templates'),
      profiles.length ? Promise.resolve(profiles) : request('/api/staff/profiles')
    ]);
    profiles = results[2] || [];
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
    var template = select([{ value: '', label: '不使用模板' }].concat((results[1] || []).map(function (t) {
      return { value: t.id, label: t.name };
    })), '');
    [field('日期', date), field('人员', staff), field('类型', type), field('模板', template)]
      .forEach(function (el) { toolbar.appendChild(el); });
    var add = node('button', 'btn sm', '新增排班');
    add.addEventListener('click', async function () {
      if (!staff.value) return showMessage(target, '请选择人员', true);
      try {
        await request('/api/shifts', {
          method: 'POST', body: JSON.stringify({
            staffId: Number(staff.value), workDate: date.value,
            assignmentType: type.value, templateId: template.value ? Number(template.value) : null
          })
        });
        loaded.schedule = false; activate('schedule');
      } catch (error) { showMessage(target, error.message, true); }
    });
    toolbar.appendChild(add);
    target.appendChild(toolbar);
    var list = node('div', 'management-list card');
    (results[0] || []).forEach(function (shift) {
      var person = profiles.find(function (p) { return Number(p.id) === Number(shift.staff_id); });
      var row = node('div', 'management-list-row');
      row.appendChild(node('strong', '', person ? person.name : ('人员 #' + shift.staff_id)));
      row.appendChild(node('span', '', shift.work_date + ' · ' + shift.assignment_type));
      var remove = node('button', 'btn gray sm', '删除');
      remove.addEventListener('click', async function () {
        await request('/api/shifts/' + shift.id, { method: 'DELETE' });
        loaded.schedule = false; activate('schedule');
      });
      row.appendChild(remove);
      list.appendChild(row);
    });
    if (!list.firstChild) list.appendChild(node('div', 'management-state', '当日暂无排班'));
    target.appendChild(list);
  }
  function renderAttendance() {
    var target = panel('attendance'); empty(target);
    target.appendChild(node('div', 'management-state card', '本轮暂未启用签到/补卡'));
  }
  function renderRegistrations() {
    var target = panel('registrations'); empty(target);
    target.appendChild(node('h3', '', '注册审核'));
    var mount = node('div', 'card');
    mount.id = 'management-pending-registrations';
    target.appendChild(mount);
    if (typeof window.loadPendingRegistrations === 'function') {
      window.loadPendingRegistrations();
      var legacy = document.getElementById('pending-reg-list');
      if (legacy) mount.appendChild(legacy);
    } else {
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
    var reminder = node('div', 'card management-setting');
    reminder.appendChild(node('strong', '', '待派单提醒'));
    var reminderSelect = document.getElementById('reminder-interval');
    var openLegacySettings = function () {
      if (reminderSelect) reminderSelect.focus();
      var legacy = document.getElementById('legacy-management-settings');
      if (legacy) legacy.hidden = false;
    };
    var reminderButton = node('button', 'btn sm', '打开设置');
    reminderButton.addEventListener('click', openLegacySettings);
    reminder.appendChild(reminderButton);
    links.appendChild(reminder);
    var sla = node('div', 'card management-setting');
    sla.appendChild(node('strong', '', 'SLA 超时告警'));
    var slaButton = node('button', 'btn sm', '打开设置');
    slaButton.addEventListener('click', openLegacySettings);
    sla.appendChild(slaButton);
    links.appendChild(sla);
    target.appendChild(links);
    var legacySettings = document.getElementById('legacy-management-settings');
    if (legacySettings) {
      legacySettings.hidden = false;
      target.appendChild(legacySettings);
    }
  }

  window.ManagementWorkspace = {
    tabs: MANAGEMENT_TABS.slice(),
    init: init,
    activate: activate,
    refreshOrganization: function () { loaded.organization = false; activate('organization'); }
  };
})();
