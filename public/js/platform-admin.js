(function (global) {
  'use strict';

  var locks = new WeakSet();
  var selectedApplicationId = null;

  function redirectToLogin() {
    sessionStorage.removeItem('platform_token');
    global.location.replace('/platform-login.html');
  }

  function safeError(code, status) {
    if (code === 'STAFF_LIMIT_BELOW_ACTIVE_COUNT') return '人数上限不能低于当前在职人数，原配置未修改。';
    if (status === 409) return '数据已发生变化，请刷新后重试。';
    if (status === 429) return '操作过于频繁，请稍后再试。';
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
      var active = Number(tenant.activeStaffCount ?? tenant.active_staff_count ?? 0);
      var limit = Number(tenant.staffLimit ?? tenant.staff_limit ?? 1);
      nameInput.value = tenant.name || '';
      limitInput.value = String(limit);
      row.querySelector('[data-field="activeStaffCount"]').textContent = String(active);
      row.querySelector('[data-field="status"]').textContent = normalizedState(tenant.status);
      var saveButton = row.querySelector('[data-action="save"]');
      var message = row.querySelector('[data-field="message"]');
      saveButton.addEventListener('click', function () {
        if (!nameInput.reportValidity() || !limitInput.reportValidity()) return;
        saveTenantChanges(tenant, {
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
      appendTextCell(row, log.actorName ?? log.actor_name ?? '平台运维');
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
      await Promise.all([loadOverview(), loadApplications(), loadTenants(), loadAudit()]);
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
    refreshData();
  }

  global.PlatformAdmin = {
    apiFetch: apiFetch,
    updateTenant: updateTenant,
    approveApplication: approveApplication,
    rejectApplication: rejectApplication,
    withSubmitLock: withSubmitLock,
    saveTenantChanges: saveTenantChanges,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
