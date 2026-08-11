(function () {
  'use strict';

  var MANAGEMENT_TABS = [
    'organization', 'schedule', 'registrations', 'reports', 'settings'
  ];
  var TAB_LABELS = {
    organization: '组织架构', schedule: '排班',
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
    var hero = node('section', 'management-hero');
    var heroCopy = node('div');
    heroCopy.appendChild(node('span', 'management-eyebrow', '运营控制中心'));
    heroCopy.appendChild(node('h2', '', '管理工作台'));
    heroCopy.appendChild(node('p', '', '统一管理组织、排班、请假、审核、报告与系统设置。'));
    hero.appendChild(heroCopy);
    container.appendChild(hero);
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
        window.ResponsiveCalendar.render(calendar, calendarData || {}, {
          width: window.innerWidth,
          onDeleteAttendance: async function (attendance, person) {
            if (!attendance || !attendance.id) return;
            if (!window.confirm('确认删除 ' + (person.name || '该人员') + ' 在 ' + date.value + ' 的考勤记录？')) return;
            await request('/api/attendance/' + attendance.id, { method: 'DELETE' });
            await refresh();
          },
          onError: function (error) { showMessage(target, error.message || '考勤删除失败', true); }
        });
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
    batch.addEventListener('click', async function () {
      try {
        var latestTemplates = await request('/api/shift-templates');
        latestTemplates = latestTemplates || [];
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
        var batchTemplate = select([{ value: '', label: '不使用模板' }].concat(latestTemplates.map(function (item) {
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
      } catch (error) {
        showMessage(target, error.message || '班次模板加载失败', true);
      }
    });
    toolbar.appendChild(batch);
    target.appendChild(toolbar);
    target.appendChild(list);
    target.appendChild(calendar);
    await refresh();
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
    var today = window.WorkforceUtils.localDateKey(new Date());
    var monthStart = today.slice(0, 7) + '-01';
    var sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    var period = select([
      { value: 'today', label: '今日' }, { value: 'week', label: '近 7 天' },
      { value: 'month', label: '本月' }, { value: 'custom', label: '自定义' }
    ], 'month');
    var staff = select([{ value: 'all', label: '全部人员' }].concat(profiles.map(function (profile) {
      return { value: profile.id, label: profile.name + (profile.position ? ' · ' + profile.position : '') };
    })), 'all');
    var from = node('input'); from.type = 'date'; from.value = monthStart;
    var to = node('input'); to.type = 'date'; to.value = today;
    var currentControl = document.getElementById('community-select');
    var currentId = currentControl && currentControl.value
      ? currentControl.value : (localStorage.getItem('juzi_oa_community_v1') || 'default');
    var currentName = currentControl && currentControl.selectedOptions[0]
      ? currentControl.selectedOptions[0].textContent : currentId;
    var community = select([
      { value: currentId, label: '当前小区（' + currentName + '）' },
      { value: '', label: '全部授权小区' }
    ], currentId);
    function applyPeriod() {
      if (period.value === 'today') from.value = to.value = today;
      if (period.value === 'week') {
        from.value = window.WorkforceUtils.localDateKey(sevenDaysAgo); to.value = today;
      }
      if (period.value === 'month') { from.value = monthStart; to.value = today; }
      from.disabled = period.value !== 'custom'; to.disabled = period.value !== 'custom';
    }
    period.addEventListener('change', function () { applyPeriod(); generateReport(); }); applyPeriod();
    var toolbar = node('div', 'management-toolbar staff-report-toolbar');
    [field('人员', staff), field('周期', period), field('开始', from), field('结束', to), field('小区范围', community)]
      .forEach(function (item) { toolbar.appendChild(item); });
    var output = node('div', 'card staff-report-output');
    var generate = node('button', 'btn', '生成报告');
    function generateReport() {
      if (!staff.value) return showMessage(target, '暂无可生成报告的人员', true);
      if (!from.value || !to.value || from.value > to.value) return showMessage(target, '日期范围无效', true);
      window.StaffReport.load(output, staff.value, {
        from: from.value, to: to.value,
        community_id: community.value,
        community_name: community.options[community.selectedIndex].textContent
      }).catch(function () {});
    }
    generate.addEventListener('click', generateReport);
    staff.addEventListener('change', generateReport);
    community.addEventListener('change', generateReport);
    from.addEventListener('change', generateReport);
    to.addEventListener('change', generateReport);
    toolbar.appendChild(generate);
    target.appendChild(toolbar); target.appendChild(output);
    if (staff.value) generateReport();
  }

  function legacyProfiles() {
    try {
      var stored = JSON.parse(localStorage.getItem('juzi_oa_demo_v1') || '{}');
      return (stored.staff || []).map(function (person) {
        var profile = {
          name: person.name || '', phone: person.phone || '', skill: person.skill || '',
          joinDate: person.joinDate || person.join_date || '',
          birthMonth: person.birthMonth || person.birth_month || '',
          position: person.position || person.role || ''
        };
        if (person.status) profile.employmentStatus = person.status === 'off' ? 'inactive' : 'active';
        return profile;
      });
    } catch (_) { return []; }
  }

  function openProfileImport() {
    var dialog = modal('导入旧人员资料');
    dialog.box.appendChild(node('p', 'management-help', '仅预览差异，不会立即写入。手机号优先匹配；没有手机号时仅接受唯一姓名。'));
    var source = node('textarea', 'profile-import-source');
    source.rows = 10; source.value = JSON.stringify(legacyProfiles(), null, 2);
    dialog.box.appendChild(field('浏览器旧资料（JSON）', source));
    var result = node('div', 'profile-import-result'); dialog.box.appendChild(result);
    var preview = node('button', 'btn', '预览匹配'); dialog.box.appendChild(preview);
    preview.addEventListener('click', async function () {
      var payload;
      try { payload = JSON.parse(source.value); } catch (_) { return showMessage(dialog.box, 'JSON 格式无效', true); }
      if (!Array.isArray(payload) || !payload.length) return showMessage(dialog.box, '没有可导入的旧资料', true);
      preview.disabled = true; empty(result);
      try {
        var response = await window.WorkforceAPI.importProfilesPreview(payload);
        if (!response || response.ok === false) throw new Error(response && response.error || '预览失败');
        var data = response.data || {};
        result.appendChild(node('h4', '', '可匹配 ' + (data.matches || []).length + ' 条 · 冲突 ' + (data.conflicts || []).length + ' 条 · 未匹配 ' + (data.unmatched || []).length + ' 条'));
        (data.matches || []).forEach(function (match) {
          var card = node('div', 'profile-import-match');
          card.appendChild(node('strong', '', (match.source.name || ('第 ' + (match.index + 1) + ' 条')) + ' → ' + match.profile.name + '（按' + (match.matched_by === 'phone' ? '手机号' : '姓名') + '）'));
          var fields = node('div', 'profile-import-fields');
          [['phone', '手机号'], ['skill', '技能'], ['joinDate', '入职日期'], ['birthMonth', '出生年月'], ['position', '职位'], ['employmentStatus', '在岗状态']]
            .forEach(function (item) {
              if (!Object.prototype.hasOwnProperty.call(match.source, item[0]) || match.source[item[0]] === '') return;
              var label = node('label'); var checkbox = node('input'); checkbox.type = 'checkbox';
              checkbox.checked = true; checkbox.className = 'profile-import-field';
              checkbox.dataset.index = match.index; checkbox.dataset.field = item[0];
              label.appendChild(checkbox); label.appendChild(node('span', '', item[1] + '：' + match.source[item[0]])); fields.appendChild(label);
            });
          card.appendChild(fields); result.appendChild(card);
        });
        (data.conflicts || []).forEach(function (item) { result.appendChild(node('div', 'management-warning', '同名冲突：' + (item.source.name || ('第 ' + (item.index + 1) + ' 条')) + '，请先在组织架构中消除重名歧义。')); });
        (data.unmatched || []).forEach(function (item) { result.appendChild(node('div', 'management-warning', '未匹配：' + (item.source.name || ('第 ' + (item.index + 1) + ' 条')) + '，不会创建新人员。')); });
        if (!(data.matches || []).length) return;
        var confirm = node('button', 'btn', '确认导入勾选字段');
        confirm.addEventListener('click', async function () {
          var grouped = {};
          result.querySelectorAll('.profile-import-field:checked').forEach(function (checkbox) {
            if (!grouped[checkbox.dataset.index]) grouped[checkbox.dataset.index] = [];
            grouped[checkbox.dataset.index].push(checkbox.dataset.field);
          });
          var selections = Object.keys(grouped).map(function (index) { return { index: Number(index), fields: grouped[index] }; });
          if (!selections.length) return showMessage(dialog.box, '请至少勾选一个字段', true);
          confirm.disabled = true;
          var saved = await window.WorkforceAPI.importProfilesConfirm(payload, selections);
          if (!saved || saved.ok === false) {
            showMessage(dialog.box, saved && saved.error || '导入失败', true); confirm.disabled = false; return;
          }
          var summary = saved.data && saved.data.summary || {};
          showMessage(dialog.box, (saved.data && saved.data.already_imported ? '该版本已导入过；' : '导入完成；') + '更新 ' + (summary.updated || 0) + ' 人。');
          loaded.organization = false;
        });
        result.appendChild(confirm);
      } catch (error) { showMessage(dialog.box, error.message, true); }
      finally { preview.disabled = false; }
    });
  }

  function openShiftTemplateEditor(template, onSaved) {
    var editing = Boolean(template);
    var dialog = modal(editing ? '编辑班次模板' : '新增班次模板');
    var name = node('input'); name.type = 'text'; name.maxLength = 40; name.value = template ? template.name || '' : '';
    var start = node('input'); start.type = 'time'; start.value = template ? template.start_time || '' : '08:00';
    var end = node('input'); end.type = 'time'; end.value = template ? template.end_time || '' : '18:00';
    var color = node('input'); color.type = 'color'; color.value = template && /^#[0-9a-f]{6}$/i.test(template.color || '') ? template.color : '#2f6fed';
    var grace = node('input'); grace.type = 'number'; grace.min = '0'; grace.step = '1'; grace.value = template && template.grace_minutes != null ? template.grace_minutes : 5;
    [[ '名称', name ], [ '上班时间', start ], [ '下班时间', end ], [ '颜色', color ], [ '迟到宽限（分钟）', grace ]]
      .forEach(function (item) { dialog.box.appendChild(field(item[0], item[1])); });
    var save = node('button', 'btn', editing ? '保存模板' : '新增模板');
    save.addEventListener('click', async function () {
      var payload = {
        name: name.value.trim(), startTime: start.value, endTime: end.value,
        color: color.value, graceMinutes: Number(grace.value)
      };
      if (!payload.name || !payload.startTime || !payload.endTime || !Number.isInteger(payload.graceMinutes) || payload.graceMinutes < 0) {
        showMessage(dialog.box, '请填写完整的模板信息', true); return;
      }
      save.disabled = true;
      try {
        await request(editing ? '/api/shift-templates/' + template.id : '/api/shift-templates', {
          method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload)
        });
        dialog.mask.remove();
        if (onSaved) await onSaved();
      } catch (error) {
        showMessage(dialog.box, error.message || '模板保存失败', true);
        save.disabled = false;
      }
    });
    dialog.box.appendChild(save);
  }

  async function renderShiftTemplates(target) {
    var section = node('section', 'card management-template-card');
    var head = node('div', 'management-section-head');
    var title = node('div');
    title.appendChild(node('h3', '', '班次模板'));
    title.appendChild(node('p', 'management-help', '统一定义上下班时间、跨夜班和迟到宽限。'));
    head.appendChild(title);
    var actions = node('div', 'management-actions');
    var add = node('button', 'btn sm', '新增模板');
    actions.appendChild(add);
    var refresh = node('button', 'btn gray sm', '刷新模板');
    actions.appendChild(refresh);
    head.appendChild(actions);
    section.appendChild(head);
    var list = node('div', 'management-template-list');
    section.appendChild(list);
    target.appendChild(section);

    async function refreshList() {
      empty(list); list.appendChild(node('div', 'management-state', '加载中…'));
      try {
        var templates = await request('/api/shift-templates');
        empty(list);
        if (!templates || !templates.length) {
          list.appendChild(node('div', 'management-state', '暂无班次模板，请先新增模板。'));
          return;
        }
        templates.forEach(function (template) {
          var row = node('div', 'management-template-row');
          var swatch = node('span', 'management-template-swatch'); swatch.style.backgroundColor = template.color || '#2f6fed';
          row.appendChild(swatch);
          var info = node('div', 'management-template-info');
          info.appendChild(node('strong', '', template.name || '未命名模板'));
          var overnight = template.end_time <= template.start_time ? ' · 跨夜' : '';
          info.appendChild(node('span', '', (template.start_time || '--:--') + '—' + (template.end_time || '--:--') + overnight + ' · 宽限 ' + Number(template.grace_minutes || 0) + ' 分钟'));
          row.appendChild(info);
          var rowActions = node('div', 'management-actions');
          var edit = node('button', 'btn gray sm', '编辑模板');
          edit.addEventListener('click', function () { openShiftTemplateEditor(template, refreshList); });
          rowActions.appendChild(edit);
          var remove = node('button', 'btn danger sm', '删除模板');
          remove.addEventListener('click', async function () {
            if (!window.confirm('确认删除模板“' + (template.name || '') + '”？')) return;
            remove.disabled = true;
            try {
              await request('/api/shift-templates/' + template.id, { method: 'DELETE' });
              await refreshList();
            } catch (error) {
              showMessage(section, error.code === 'SHIFT_TEMPLATE_IN_USE' ? '该模板正在被排班使用，不能删除' : (error.message || '模板删除失败'), true);
              remove.disabled = false;
            }
          });
          rowActions.appendChild(remove);
          row.appendChild(rowActions);
          list.appendChild(row);
        });
      } catch (error) {
        empty(list); showMessage(list, error.message || '模板加载失败', true);
      }
    }
    add.addEventListener('click', function () { openShiftTemplateEditor(null, refreshList); });
    refresh.addEventListener('click', refreshList);
    await refreshList();
  }

  function renderSettings() {
    var target = panel('settings'); empty(target);
    target.appendChild(node('h3', '', '系统设置'));
    renderPerformanceSettings(target);
    renderShiftTemplates(target);
    var links = node('div', 'management-settings-grid');
    var community = node('button', 'card management-setting', '小区管理');
    community.addEventListener('click', function () { if (typeof window.openCommunityModal === 'function') window.openCommunityModal(); });
    links.appendChild(community);
    var profileImport = node('button', 'card management-setting', '导入旧人员资料');
    profileImport.addEventListener('click', openProfileImport);
    links.appendChild(profileImport);
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

  function renderPerformanceSettings(target) {
    var section = node('section', 'card management-performance-settings');
    section.appendChild(node('h3', '', '绩效评分标准'));
    section.appendChild(node('p', 'management-hint', '评分全部由服务端按已发布规则计算；发布新版本后仅后续工单使用。'));
    var form = node('div', 'management-form-grid');
    var fields = [
      ['完成率权重', 'completion_weight', 30],
      ['准时率权重', 'on_time_weight', 50],
      ['质量权重', 'quality_weight', 20],
      ['优秀分界线', 'excellent_threshold', 90],
      ['良好分界线', 'good_threshold', 80],
      ['合格分界线', 'qualified_threshold', 60],
      ['最小样本数', 'minimum_sample_size', 1]
    ];
    var inputs = {};
    fields.forEach(function (item) {
      var input = node('input'); input.type = 'number'; input.min = '0'; input.value = item[2]; input.dataset.field = item[1];
      inputs[item[1]] = input; form.appendChild(field(item[0], input));
    });
    var name = node('input'); name.type = 'text'; name.placeholder = '规则名称'; inputs.name = name; form.appendChild(field('规则名称', name));
    var total = node('span', 'management-inline-message', '权重合计：100%');
    function updateTotal() {
      var sum = Number(inputs.completion_weight.value || 0) + Number(inputs.on_time_weight.value || 0) + Number(inputs.quality_weight.value || 0);
      total.textContent = '权重合计：' + sum + '%'; total.classList.toggle('error', sum !== 100);
    }
    ['completion_weight', 'on_time_weight', 'quality_weight'].forEach(function (key) { inputs[key].addEventListener('input', updateTotal); });
    form.appendChild(total);
    var actions = node('div', 'management-actions');
    var publish = node('button', 'btn sm', '发布新评分规则');
    publish.addEventListener('click', async function () {
      publish.disabled = true;
      try {
        var body = {};
        Object.keys(inputs).forEach(function (key) { body[key] = key === 'name' ? inputs[key].value.trim() : Number(inputs[key].value); });
        await request('/api/settings/performance/versions', { method: 'POST', body: JSON.stringify(body) });
        showMessage(section, '评分规则已发布');
        await loadPerformance();
      } catch (error) { showMessage(section, error.message || '评分规则发布失败', true); }
      publish.disabled = false;
    });
    actions.appendChild(publish); section.appendChild(form); section.appendChild(actions);
    var history = node('div', 'management-performance-history'); section.appendChild(history); target.appendChild(section);
    async function loadPerformance() {
      try {
        var data = await request('/api/settings/performance');
        var active = data.active || {};
        fields.forEach(function (item) { if (active[item[1]] != null) inputs[item[1]].value = active[item[1]]; });
        if (active.name) inputs.name.value = active.name;
        updateTotal(); empty(history);
        (data.versions || []).forEach(function (version) {
          history.appendChild(node('div', 'management-performance-version', '规则 v' + version.version_no + ' · 样本 ' + Number(version.sample_size || version.sampleSize || 0) + ' · ' + (version.effective_at || '')));
        });
      } catch (error) { showMessage(section, error.message || '评分规则加载失败', true); }
    }
    loadPerformance();
  }

  window.ManagementWorkspace = {
    tabs: MANAGEMENT_TABS.slice(),
    init: init,
    activate: activate,
    refreshOrganization: function () { loaded.organization = false; activate('organization'); }
  };
})();
