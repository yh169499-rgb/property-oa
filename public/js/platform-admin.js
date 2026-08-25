(function (global) {
  'use strict';

  var locks = new WeakSet();
  var selectedApplicationId = null;
  var dataCenterState = { tenantId: '', tableKey: '', page: 1, pageSize: 20, total: 0, catalog: [], rows: [] };
  var dataEditorContext = null;

  function redirectToLogin() {
    sessionStorage.removeItem('platform_token');
    global.location.replace('/platform-login.html');
  }

  function safeError(code, status) {
    if (code === 'STAFF_LIMIT_BELOW_ACTIVE_COUNT') return '人数上限不能低于当前在职人数，原配置未修改。';
    if (status === 409) return '数据已发生变化，请刷新后重试。';
    if (status === 429) return '操作过于频繁，请稍后再试。';
    if (code === 'PLATFORM_DATA_DELETE_FORBIDDEN') return '数据中心不允许删除数据。';
    if (code === 'PLATFORM_DATA_FIELD_FORBIDDEN') return '包含不允许修改的字段，请仅修改业务资料。';
    if (code === 'PLATFORM_DATA_PRIVILEGE_ESCALATION') return '不能通过数据中心提升账号权限。';
    if (code === 'PHONE_CONFLICT') return '手机号已被其他账号使用。';
    if (code === 'INVALID_TICKET_TRANSITION') return '工单状态转换不合法。';
    return '操作失败，请稍后重试。';
  }

  async function apiFetch(path, options) {
    var token = sessionStorage.getItem('platform_token');
    if (!token) {
      redirectToLogin();
      throw new Error('PLATFORM_AUTH_REQUIRED');
    }
    var request = options || {};
    var headers = Object.assign({}, request.headers || {}, { Authorization: 'Bearer ' + token });
    if (request.body) headers['Content-Type'] = 'application/json';
    var response = await fetch(path, Object.assign({}, request, { headers: headers }));
    if (response.status === 401 || response.status === 403) {
      redirectToLogin();
      throw new Error('PLATFORM_AUTH_REQUIRED');
    }
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var code = result.code || (result.error && result.error.code);
      var error = new Error(safeError(code, response.status));
      error.code = code;
      throw error;
    }
    return result.data === undefined ? result : result.data;
  }

  async function updateTenant(id, name, staffLimit) {
    return apiFetch('/api/platform/tenants/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ name: name, staffLimit: Number(staffLimit) }),
    });
  }

  async function approveApplication(id, staffLimit) {
    return apiFetch('/api/platform/applications/' + encodeURIComponent(id) + '/approve', {
      method: 'POST',
      body: JSON.stringify({ staffLimit: Number(staffLimit) }),
    });
  }

  async function rejectApplication(id, reason) {
    return apiFetch('/api/platform/applications/' + encodeURIComponent(id) + '/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: reason }),
    });
  }

  async function withSubmitLock(button, task) {
    if (!button || locks.has(button)) return;
    locks.add(button);
    button.disabled = true;
    try {
      return await task();
    } finally {
      locks.delete(button);
      button.disabled = false;
    }
  }

  async function saveTenantChanges(tenant, controls) {
    return withSubmitLock(controls.button, async function () {
      setStatus(controls.message, '正在保存…');
      try {
        await updateTenant(tenant.id, controls.nameInput.value.trim(), Number(controls.limitInput.value));
        setStatus(controls.message, '已保存', 'is-success');
        return true;
      } catch (error) {
        setStatus(controls.message, error.message, 'is-error');
        return false;
      }
    });
  }

  function setStatus(element, message, kind) {
    if (!element) return;
    element.textContent = message || '';
    element.className = 'platform-form-status ' + (kind || '');
  }

  function appendTextCell(row, value, className) {
    var cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value == null || value === '' ? '—' : String(value);
    row.appendChild(cell);
    return cell;
  }

  function replaceWithEmptyState(body, columnCount, message) {
    var row = document.createElement('tr');
    var cell = appendTextCell(row, message, 'platform-empty-state');
    cell.colSpan = columnCount;
    body.replaceChildren(row);
  }

  function listFrom(data, keys) {
    if (Array.isArray(data)) return data;
    for (var i = 0; data && i < keys.length; i += 1) {
      if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    return [];
  }

  function formatTime(value) {
    if (!value) return '—';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
  }

  function normalizedState(value) {
    var labels = { pending: '待审核', approved: '已批准', rejected: '已拒绝', active: '启用', disabled: '停用' };
    return labels[value] || value || '—';
  }

  function validTenantData(tenant) {
    if (!tenant || typeof tenant.id !== 'string' || !tenant.id.trim()) return null;
    if (typeof tenant.name !== 'string' || !tenant.name.trim()) return null;
    var staffLimit = tenant.staffLimit ?? tenant.staff_limit;
    if (!Number.isInteger(staffLimit) || staffLimit < 1 || staffLimit > 999) return null;
    return { id: tenant.id.trim(), name: tenant.name.trim(), staffLimit: staffLimit };
  }

  function setDataStatus(message, kind) {
    setStatus(document.getElementById('platform-data-status'), message, kind);
  }

  function dataTableOptionLabel(table) {
    return (table.label || table.key) + '（' + String(table.count ?? 0) + ' 条' + (table.editable ? '，可编辑' : '，只读') + '）';
  }

  function renderDataSelectOptions(select, items, selected, labeler) {
    if (!select) return;
    select.replaceChildren();
    items.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.value;
      option.textContent = labeler(item);
      option.selected = item.value === selected;
      select.appendChild(option);
    });
  }

  async function loadDataCenterTenants() {
    var tenantSelect = document.getElementById('platform-data-tenant');
    if (!tenantSelect) return;
    var data = await apiFetch('/api/platform/tenants');
    var tenants = listFrom(data, ['tenants', 'items']).map(validTenantData).filter(Boolean);
    if (!tenants.length) {
      tenantSelect.replaceChildren();
      dataCenterState.tenantId = '';
      dataCenterState.catalog = [];
      renderDataSelectOptions(document.getElementById('platform-data-table'), [], '', function () { return ''; });
      renderDataRows({ columns: [], rows: [], total: 0, page: 1, pageSize: dataCenterState.pageSize });
      return;
    }
    var current = tenants.some(function (tenant) { return tenant.id === dataCenterState.tenantId; })
      ? dataCenterState.tenantId : tenants[0].id;
    dataCenterState.tenantId = current;
    renderDataSelectOptions(tenantSelect, tenants.map(function (tenant) { return { value: tenant.id, label: tenant.name }; }), current, function (item) { return item.label; });
    await loadDataCenterCatalog();
  }

  async function loadDataCenterCatalog() {
    if (!dataCenterState.tenantId) return;
    var data = await apiFetch('/api/platform/tenants/' + encodeURIComponent(dataCenterState.tenantId) + '/data-tables');
    dataCenterState.catalog = Array.isArray(data) ? data : listFrom(data, ['tables', 'items']);
    var selected = dataCenterState.catalog.some(function (table) { return table.key === dataCenterState.tableKey; })
      ? dataCenterState.tableKey : (dataCenterState.catalog[0] && dataCenterState.catalog[0].key) || '';
    dataCenterState.tableKey = selected;
    renderDataSelectOptions(document.getElementById('platform-data-table'), dataCenterState.catalog.map(function (table) { return { value: table.key, label: dataTableOptionLabel(table) }; }), selected, function (item) { return item.label; });
    dataCenterState.page = 1;
    await loadDataCenterRows();
  }

  function formatDataCell(value, type) {
    if (value == null || value === '') return '—';
    if (type === 'boolean') return Number(value) ? '是' : '否';
    if (type === 'json') {
      try { return typeof value === 'string' ? JSON.stringify(JSON.parse(value)) : JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
  }

  function renderDataRows(data) {
    var head = document.getElementById('platform-data-head');
    var body = document.getElementById('platform-data-body');
    var pageLabel = document.getElementById('platform-data-page');
    var previous = document.getElementById('platform-data-prev');
    var next = document.getElementById('platform-data-next');
    if (!head || !body) return;
    var columns = Array.isArray(data.columns) ? data.columns : [];
    var headRow = document.createElement('tr');
    columns.forEach(function (column) { appendTextCell(headRow, column.label || column.key); });
    var table = dataCenterState.catalog.find(function (item) { return item.key === dataCenterState.tableKey; });
    if (table && table.editable) appendTextCell(headRow, '操作');
    head.replaceChildren(headRow);
    var rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      replaceWithEmptyState(body, columns.length + (table && table.editable ? 1 : 0), '暂无数据');
    } else {
      var fragment = document.createDocumentFragment();
      rows.forEach(function (rowData) {
        var row = document.createElement('tr');
        columns.forEach(function (column) { appendTextCell(row, formatDataCell(rowData[column.key], column.type)); });
        if (table && table.editable) {
          var action = document.createElement('td');
          var edit = document.createElement('button');
          edit.type = 'button'; edit.className = 'btn gray sm'; edit.textContent = '编辑';
          edit.addEventListener('click', function () { openDataEditor(table, rowData, columns); });
          action.appendChild(edit); row.appendChild(action);
        }
        fragment.appendChild(row);
      });
      body.replaceChildren(fragment);
    }
    var page = Number(data.page || dataCenterState.page || 1);
    var pageSize = Number(data.pageSize || dataCenterState.pageSize || 20);
    var total = Number(data.total || 0);
    dataCenterState.page = page; dataCenterState.pageSize = pageSize; dataCenterState.total = total; dataCenterState.rows = rows;
    if (pageLabel) pageLabel.textContent = '第 ' + page + ' 页，共 ' + total + ' 条';
    if (previous) previous.disabled = page <= 1;
    if (next) next.disabled = page * pageSize >= total;
  }

  async function loadDataCenterRows() {
    if (!dataCenterState.tenantId || !dataCenterState.tableKey) return;
    setDataStatus('正在加载数据…');
    var search = document.getElementById('platform-data-search-input');
    var query = new URLSearchParams({ page: String(dataCenterState.page), pageSize: String(dataCenterState.pageSize) });
    if (search && search.value.trim()) query.set('search', search.value.trim());
    var data = await apiFetch('/api/platform/tenants/' + encodeURIComponent(dataCenterState.tenantId) + '/data/' + encodeURIComponent(dataCenterState.tableKey) + '?' + query.toString());
    renderDataRows(data);
    setDataStatus('数据已更新。', 'is-success');
  }

  function openDataEditor(table, rowData, columns) {
    var dialog = document.getElementById('data-editor-dialog');
    var fields = document.getElementById('data-editor-fields');
    var title = document.getElementById('data-editor-title');
    if (!dialog || !fields) return;
    dataEditorContext = { table: table, row: rowData, columns: columns };
    title.textContent = '编辑' + (table.label || table.key);
    fields.replaceChildren();
    columns.filter(function (column) { return column.editable; }).forEach(function (column) {
      var label = document.createElement('label');
      label.textContent = column.label || column.key;
      var input = document.createElement('input');
      input.name = column.key; input.value = rowData[column.key] == null ? '' : String(rowData[column.key]);
      input.maxLength = 2000;
      if (column.type === 'number') input.type = 'number';
      if (column.type === 'date') input.type = 'date';
      if (column.type === 'time') input.type = 'time';
      if (column.type === 'datetime') input.type = 'datetime-local';
      if (column.key === 'message' || column.key === 'desc' || column.key === 'note') { input = document.createElement('textarea'); input.name = column.key; input.value = rowData[column.key] == null ? '' : String(rowData[column.key]); input.maxLength = 4000; }
      label.appendChild(input); fields.appendChild(label);
    });
    setStatus(document.getElementById('data-editor-status'), '');
    dialog.showModal();
  }

  async function saveDataEditor() {
    if (!dataEditorContext) return;
    var form = document.getElementById('data-editor-form');
    var submit = document.getElementById('data-editor-submit');
    var patch = {};
    Array.from(form.querySelectorAll('[name]')).forEach(function (input) { patch[input.name] = input.value; });
    await withSubmitLock(submit, async function () {
      try {
        await apiFetch('/api/platform/tenants/' + encodeURIComponent(dataCenterState.tenantId) + '/data/' + encodeURIComponent(dataEditorContext.table.key) + '/' + encodeURIComponent(dataEditorContext.row[dataEditorContext.table.idColumn]), { method: 'PATCH', body: JSON.stringify(patch) });
        document.getElementById('data-editor-dialog').close();
        setDataStatus('修改已保存，审计记录已写入。', 'is-success');
        await loadDataCenterCatalog();
      } catch (error) {
        setStatus(document.getElementById('data-editor-status'), error.message, 'is-error');
      }
    });
  }

  async function loadOverview() {
    var root = document.getElementById('platform-overview-cards');
    if (!root) return;
    var data = await apiFetch('/api/platform/overview');
    var items = [
      ['待审核申请', data.pendingApplications ?? data.pending_applications ?? 0],
      ['企业总数', data.tenantCount ?? data.tenant_count ?? 0],
      ['启用企业', data.activeTenantCount ?? data.active_tenant_count ?? 0],
      ['平台操作记录', data.auditCount ?? data.audit_count ?? 0],
    ];
    var fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      var card = document.createElement('article');
      card.className = 'platform-overview-card';
      var label = document.createElement('span');
      label.textContent = item[0];
      var value = document.createElement('strong');
      value.textContent = String(item[1]);
      card.append(label, value);
      fragment.appendChild(card);
    });
    root.replaceChildren(fragment);
  }

  function openApproval(id) {
    selectedApplicationId = id;
    var dialog = document.getElementById('approval-dialog');
    var input = document.getElementById('approval-staff-limit');
    var status = document.getElementById('approval-status');
    input.value = '4';
    setStatus(status, '');
    dialog.showModal();
  }

  async function handleReject(application, button) {
    var reason = global.prompt('请输入拒绝原因：', '');
    if (reason == null) return;
    reason = reason.trim();
    if (!reason) {
      setStatus(document.getElementById('platform-admin-status'), '拒绝申请必须填写原因。', 'is-error');
      return;
    }
    await withSubmitLock(button, async function () {
      await rejectApplication(application.id, reason);
      setStatus(document.getElementById('platform-admin-status'), '申请已拒绝。', 'is-success');
      await Promise.all([loadApplications(), loadOverview(), loadAudit()]);
    });
  }

  async function loadApplications() {
    var body = document.getElementById('platform-applications-body');
    if (!body) return;
    var data = await apiFetch('/api/platform/applications');
    var applications = listFrom(data, ['applications', 'items']);
    if (!applications.length) {
      replaceWithEmptyState(body, 5, '暂无企业主管申请');
      return;
    }
    var fragment = document.createDocumentFragment();
    applications.forEach(function (application) {
      var row = document.createElement('tr');
      appendTextCell(row, application.enterpriseName ?? application.enterprise_name);
      appendTextCell(row, application.supervisorName ?? application.supervisor_name);
      appendTextCell(row, formatTime(application.createdAt ?? application.created_at));
      appendTextCell(row, normalizedState(application.status));
      var actionCell = document.createElement('td');
      actionCell.className = 'platform-actions';
      if ((application.status || 'pending') === 'pending') {
        var approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'btn sm';
        approve.textContent = '批准';
        approve.addEventListener('click', function () { openApproval(application.id); });
        var reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'btn gray sm';
        reject.textContent = '拒绝';
        reject.addEventListener('click', function () {
          handleReject(application, reject).catch(showPageError);
        });
        actionCell.append(approve, reject);
      } else {
        actionCell.textContent = '已处理';
      }
      row.appendChild(actionCell);
      fragment.appendChild(row);
    });
    body.replaceChildren(fragment);
  }

  async function loadTenants() {
    var body = document.getElementById('platform-tenants-body');
    var template = document.getElementById('tenant-row-template');
    if (!body || !template) return;
    var data = await apiFetch('/api/platform/tenants');
    var tenants = listFrom(data, ['tenants', 'items']);
    if (!tenants.length) {
      replaceWithEmptyState(body, 4, '暂无企业');
      return;
    }
    var fragment = document.createDocumentFragment();
    tenants.forEach(function (tenant) {
      var row = template.content.firstElementChild.cloneNode(true);
      var nameInput = row.querySelector('[name="name"]');
      var limitInput = row.querySelector('[name="staffLimit"]');
      var saveButton = row.querySelector('[data-action="save"]');
      var message = row.querySelector('[data-field="message"]');
      var tenantData = validTenantData(tenant);
      var tenantContext = tenant && typeof tenant.name === 'string' && tenant.name.trim()
        ? tenant.name.trim()
        : '未知企业';
      nameInput.setAttribute('aria-label', tenantContext + ' 企业名称');
      limitInput.setAttribute('aria-label', tenantContext + ' 总人数上限');

      if (!tenantData) {
        nameInput.value = tenant && typeof tenant.name === 'string' ? tenant.name : '';
        var unsafeLimit = tenant && (tenant.staffLimit ?? tenant.staff_limit);
        limitInput.value = unsafeLimit == null ? '' : String(unsafeLimit);
        nameInput.disabled = true;
        limitInput.disabled = true;
        saveButton.disabled = true;
        row.querySelector('[data-field="activeStaffCount"]').textContent = '—';
        row.querySelector('[data-field="status"]').textContent = '数据异常';
        message.textContent = '企业数据不完整，暂不能编辑。';
        message.className = 'platform-row-message is-error';
        fragment.appendChild(row);
        return;
      }

      var active = Number(tenant.activeStaffCount ?? tenant.active_staff_count ?? 0);
      nameInput.value = tenantData.name;
      limitInput.value = String(tenantData.staffLimit);
      row.querySelector('[data-field="activeStaffCount"]').textContent = String(active);
      row.querySelector('[data-field="status"]').textContent = normalizedState(tenant.status);
      saveButton.addEventListener('click', function () {
        if (!nameInput.reportValidity() || !limitInput.reportValidity()) return;
        saveTenantChanges(tenantData, {
          nameInput: nameInput,
          limitInput: limitInput,
          message: message,
          button: saveButton,
        }).then(async function (saved) {
          if (saved) {
            await Promise.all([loadTenants(), loadOverview(), loadAudit()]);
          }
        }).catch(showPageError);
      });
      fragment.appendChild(row);
    });
    body.replaceChildren(fragment);
  }

  async function loadAudit() {
    var body = document.getElementById('platform-audit-body');
    if (!body) return;
    var data = await apiFetch('/api/platform/audit-logs');
    var logs = listFrom(data, ['logs', 'items']);
    if (!logs.length) {
      replaceWithEmptyState(body, 4, '暂无平台审计日志');
      return;
    }
    var fragment = document.createDocumentFragment();
    logs.forEach(function (log) {
      var row = document.createElement('tr');
      appendTextCell(row, formatTime(log.createdAt ?? log.created_at));
      appendTextCell(row, log.actorName ?? log.actor_name ?? '管理平台');
      appendTextCell(row, log.action);
      appendTextCell(row, log.targetName ?? log.target_name ?? log.targetType ?? log.target_type);
      fragment.appendChild(row);
    });
    body.replaceChildren(fragment);
  }

  function showPageError(error) {
    if (error && error.message === 'PLATFORM_AUTH_REQUIRED') return;
    var message = error && /^人数上限|^数据已|^操作过于/.test(error.message)
      ? error.message
      : '平台数据加载失败，请稍后重试。';
    setStatus(document.getElementById('platform-admin-status'), message, 'is-error');
  }

  async function refreshData() {
    setStatus(document.getElementById('platform-admin-status'), '正在刷新…');
    try {
      await Promise.all([loadOverview(), loadApplications(), loadTenants(), loadAudit(), loadDataCenterTenants()]);
      setStatus(document.getElementById('platform-admin-status'), '数据已更新。', 'is-success');
    } catch (error) {
      showPageError(error);
    }
  }

  function init() {
    if (!sessionStorage.getItem('platform_token')) {
      redirectToLogin();
      return;
    }
    var logout = document.getElementById('platform-logout');
    var refresh = document.getElementById('platform-refresh');
    var approvalForm = document.getElementById('approval-form');
    var approvalDialog = document.getElementById('approval-dialog');
    var approvalCancel = document.getElementById('approval-cancel');
    var approvalSubmit = document.getElementById('approval-submit');
    var approvalStatus = document.getElementById('approval-status');
    var approvalLimit = document.getElementById('approval-staff-limit');
    var dataTenant = document.getElementById('platform-data-tenant');
    var dataTable = document.getElementById('platform-data-table');
    var dataRefresh = document.getElementById('platform-data-refresh');
    var dataSearch = document.getElementById('platform-data-search');
    var dataPrev = document.getElementById('platform-data-prev');
    var dataNext = document.getElementById('platform-data-next');
    var dataEditorForm = document.getElementById('data-editor-form');
    var dataEditorCancel = document.getElementById('data-editor-cancel');

    logout.addEventListener('click', redirectToLogin);
    refresh.addEventListener('click', function () { withSubmitLock(refresh, refreshData); });
    approvalCancel.addEventListener('click', function () { approvalDialog.close(); });
    approvalForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!approvalLimit.reportValidity() || !selectedApplicationId) return;
      withSubmitLock(approvalSubmit, async function () {
        try {
          await approveApplication(selectedApplicationId, Number(approvalLimit.value));
          approvalDialog.close();
          setStatus(document.getElementById('platform-admin-status'), '申请已批准。', 'is-success');
          await Promise.all([loadApplications(), loadTenants(), loadOverview(), loadAudit()]);
        } catch (error) {
          setStatus(approvalStatus, error.message, 'is-error');
        }
      });
    });
    if (dataTenant) dataTenant.addEventListener('change', function () { dataCenterState.tenantId = dataTenant.value; loadDataCenterCatalog().catch(showPageError); });
    if (dataTable) dataTable.addEventListener('change', function () { dataCenterState.tableKey = dataTable.value; dataCenterState.page = 1; loadDataCenterRows().catch(showPageError); });
    if (dataRefresh) dataRefresh.addEventListener('click', function () { withSubmitLock(dataRefresh, loadDataCenterTenants).catch(showPageError); });
    if (dataSearch) dataSearch.addEventListener('click', function () { dataCenterState.page = 1; loadDataCenterRows().catch(showPageError); });
    if (dataPrev) dataPrev.addEventListener('click', function () { if (dataCenterState.page > 1) { dataCenterState.page -= 1; loadDataCenterRows().catch(showPageError); } });
    if (dataNext) dataNext.addEventListener('click', function () { if (dataCenterState.page * dataCenterState.pageSize < dataCenterState.total) { dataCenterState.page += 1; loadDataCenterRows().catch(showPageError); } });
    if (dataEditorCancel) dataEditorCancel.addEventListener('click', function () { document.getElementById('data-editor-dialog').close(); });
    if (dataEditorForm) dataEditorForm.addEventListener('submit', function (event) { event.preventDefault(); saveDataEditor().catch(showPageError); });
    refreshData();
  }

  global.PlatformAdmin = {
    apiFetch: apiFetch,
    updateTenant: updateTenant,
    approveApplication: approveApplication,
    rejectApplication: rejectApplication,
    listDataCenterRows: loadDataCenterRows,
    updateDataCenterRow: saveDataEditor,
    withSubmitLock: withSubmitLock,
    saveTenantChanges: saveTenantChanges,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
