/* ============================================================
   物业 OA 工单审批系统 —— 应用逻辑
   后端 API 模式（飞书多维表格）+ localStorage 人员管理
   ============================================================ */

const LS_KEY = 'juzi_oa_demo_v1';
const LS_ROLE = 'juzi_oa_role_v1';
const LS_COMMUNITY = 'juzi_oa_community_v1';
const API_BASE = ''; // 同域，留空即可；部署到 Render 后改为实际 URL

function authHeaders(json) {
  var headers = json ? { 'Content-Type': 'application/json' } : {};
  var token = localStorage.getItem('auth_token');
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

/* ---------- 状态映射 ---------- */
const STATUS_LABEL = { wait: '待派单', doing: '处理中', pending: '搁置中', confirm: '待确认', done: '已完成' };
const STATUS_CLASS = { wait: 'wait', doing: 'doing', pending: 'pending', confirm: 'confirm', done: 'done' };

/* ---------- 全局 state ---------- */
let state = { tickets: [], staff: [], communities: [] };
let currentRole = 'eng_lead';
let currentCommunity = 'default';
let charts = {};   // echarts 实例缓存
let useApi = true; // 是否使用后端 API

/* ============================================================
   数据加载与持久化
   ============================================================ */
async function load() {
  // 人员仍用 localStorage
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    try { var parsed = JSON.parse(raw); state.staff = parsed.staff || JSON.parse(JSON.stringify(SEED.staff)); } catch(e) { state.staff = JSON.parse(JSON.stringify(SEED.staff)); }
  } else { state.staff = JSON.parse(JSON.stringify(SEED.staff)); }
  currentRole = localStorage.getItem(LS_ROLE) || 'eng_lead';
  currentCommunity = localStorage.getItem(LS_COMMUNITY) || 'default';

  // 加载小区列表
  if (useApi) {
    try {
      var isLead = currentRole === 'eng_lead';
      var myName = currentRole.replace(/^worker_|^pm_keeper_/, '');
      var communityUrl = API_BASE + '/api/communities' + (!isLead && myName ? '?staff_name=' + encodeURIComponent(myName) : '');
      var cResp = await fetch(communityUrl);
      var cJson = await cResp.json();
      if (cJson.data) state.communities = cJson.data;
    } catch(e) { console.warn('小区列表加载失败', e); state.communities = [{ id: 'default', name: '默认小区', address: '' }]; }
  }

  // 工单从 API 加载（按当前小区筛选）
  if (useApi) {
    // 加载人员状态
    try {
      var stResp = await fetch(API_BASE + '/api/staff/status');
      var stJson = await stResp.json();
      if (stJson.data) {
        stJson.data.forEach(function(r) {
          var s = state.staff.find(function(x) { return x.name === r.name; });
          if (s) s.status = r.status;
        });
      }
    } catch(e) { /* ignore */ }
    try {
      var resp = await fetch(API_BASE + '/api/tickets?community_id=' + encodeURIComponent(currentCommunity));
      var json = await resp.json();
      if (json.data) {
        state.tickets = json.data.filter(t => t.id && t.type);
        saveLocal();
        return;
      }
    } catch(e) { console.warn('API 不可用，回退到本地数据', e); }
  }
  // 回退：使用本地数据
  var localRaw = localStorage.getItem(LS_KEY);
  if (localRaw) { try { state.tickets = JSON.parse(localRaw).tickets || []; } catch(e) { state.tickets = []; } }
  else { state.tickets = []; }
}

function saveLocal() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function save() { saveLocal(); }

async function apiPatch(recordId, updates) {
  if (!useApi || !recordId) return;
  try {
    var headers = { 'Content-Type': 'application/json' };
    var token = localStorage.getItem('auth_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    await fetch(API_BASE + '/api/tickets/' + recordId, {
      method: 'PATCH',
      headers: headers,
      body: JSON.stringify(updates)
    });
  } catch(e) { console.warn('API更新失败', e); }
}

/* ============================================================
   小工具
   ============================================================ */
function $(s, root = document) { return root.querySelector(s); }
function $$(s, root = document) { return [...root.querySelectorAll(s)]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function fmtTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${t.getMonth() + 1}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}
function durHours(a, b) { if (!a || !b) return null; return +((new Date(b) - new Date(a)) / 3600000).toFixed(1); }

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* 头像 */
function avatar(name, color) {
  const c = color || '#1677ff';
  const ch = name ? name[0] : '?';
  return `<span class="avatar" style="background:${c}">${esc(ch)}</span>`;
}
function staffColor(name) {
  const palette = { '张师傅': '#13c2c2', '李师傅': '#52c41a', '王师傅': '#fa8c16', '赵师傅': '#eb2f96', '孙师傅': '#1677ff', '陈管家': '#08979c', '周管家': '#722ed1' };
  return palette[name] || '#1677ff';
}

/* ============================================================
   导航
   ============================================================ */
function initNav() {
  $$('.nav button').forEach(b => {
    b.onclick = () => showPage(b.dataset.page);
  });
}

function showPage(page, navPage) {
  var employeeView = currentRole.startsWith('worker_') || currentRole.startsWith('pm_keeper_');
  var resolvedPage = page === 'dashboard' && employeeView ? 'worker-home' : page;
  var target = $('#page-' + resolvedPage);
  if (!target) return false;
  $$('.nav button').forEach(x => x.classList.remove('active'));
  var activeNav = $$('.nav button').find(b => b.dataset.page === (navPage || page));
  if (activeNav) activeNav.classList.add('active');
  $$('.page').forEach(p => p.classList.remove('active'));
  target.classList.add('active');
  if (resolvedPage === 'dashboard') setTimeout(function() {
    // 销毁旧图表实例避免display:none时尺寸为0的问题
    Object.keys(charts).forEach(function(k) { try { charts[k].dispose(); } catch(e) {} });
    charts = {};
    renderDashboard();
  }, 50);
  if (resolvedPage === 'worker-home' && window.WorkerHome) {
    setTimeout(window.WorkerHome.init, 0);
  }
  if (resolvedPage === 'management' && window.ManagementWorkspace) {
    setTimeout(window.ManagementWorkspace.init, 0);
  }
  if (resolvedPage === 'my' && window.MyPage && typeof window.MyPage.init === 'function') {
    setTimeout(function() { window.MyPage.init('month'); }, 0);
  }
  return true;
}

function navTo(page) {
  var btn = $$('.nav button').find(b => b.dataset.page === page);
  if (btn) btn.click();
}

/* ============================================================
   角色切换
   ============================================================ */
function initRole() {
  const sel = $('#roleSelect');
  // 管理角色（合并为一个主管）
  var html = '<optgroup label="管理层">';
  html += '<option value="eng_lead">主管</option>';
  html += '</optgroup>';
  // 维修工（从 state.staff 动态读取）
  var workers = state.staff.filter(s => s.role === '维修工');
  if (workers.length) {
    html += '<optgroup label="维修工">';
    workers.forEach(s => { html += `<option value="worker_${esc(s.name)}">${esc(s.name)} · ${esc(s.skill)}</option>`; });
    html += '</optgroup>';
  }
  // 管家（从 state.staff 动态读取）
  var keepers = state.staff.filter(s => s.role === '物业管家');
  if (keepers.length) {
    html += '<optgroup label="物业管家">';
    keepers.forEach(s => { html += `<option value="pm_keeper_${esc(s.name)}">${esc(s.name)} · ${esc(s.skill)}</option>`; });
    html += '</optgroup>';
  }
  sel.innerHTML = html;
  // 恢复上次选中的角色
  if (sel.querySelector(`option[value="${currentRole}"]`)) sel.value = currentRole;
  else { currentRole = 'eng_lead'; sel.value = currentRole; }
  sel.onchange = () => {
    currentRole = sel.value;
    localStorage.setItem(LS_ROLE, currentRole);
    toast('已切换角色：' + sel.options[sel.selectedIndex].text);
    applyRoleView();
  };
}
function roleObj() {
  if (currentRole === 'eng_lead') return { id: 'eng_lead', name: '主管', kind: '管理' };
  // 动态角色
  var name = currentRole.replace(/^worker_|^pm_keeper_/, '');
  var s = state.staff.find(x => x.name === name);
  if (s) return { id: currentRole, name: s.name, kind: s.role };
  return { id: currentRole, name: currentRole, kind: '未知' };
}
function roleWorkerName() {
  if (currentRole.startsWith('worker_')) return currentRole.replace('worker_', '');
  return null;
}
function applyRoleView() {
  var isWorker = currentRole.startsWith('worker_');
  var isKeeper = currentRole.startsWith('pm_keeper_');
  // 员工视图保留独立首页，只显示与本人职责相关的工单入口。
  $$('.nav button').forEach(b => {
    if (b.dataset.page === 'management') b.style.display = (isWorker || isKeeper) ? 'none' : '';
    if (b.dataset.page === 'dashboard') b.style.display = '';
    if (b.dataset.page === 'repair') b.style.display = isKeeper ? 'none' : '';
    if (b.dataset.page === 'complaint' || b.dataset.page === 'help') b.style.display = isWorker ? 'none' : '';
  });
  // 重新加载小区列表（按角色权限过滤）
  reloadCommunities();
  // 师傅/管家登录后进入自己的工作台。
  if (isWorker || isKeeper) navTo('dashboard');
  renderAll();
  if (openTicketId) openDrawer(openTicketId);
}

async function reloadCommunities() {
  if (!useApi) return;
  try {
    var isLead = currentRole === 'eng_lead';
    var myName = currentRole.replace(/^worker_|^pm_keeper_/, '');
    var url = API_BASE + '/api/communities' + (!isLead && myName ? '?staff_name=' + encodeURIComponent(myName) : '');
    var resp = await fetch(url);
    var json = await resp.json();
    if (json.data) state.communities = json.data;
  } catch(e) { /* keep existing */ }
  initCommunitySelect();
}

/* ============================================================
   详情抽屉 & 照片
   ============================================================ */
let openTicketId = null;

function loadDrawerPhotos(ticketId) {
  fetch(API_BASE + '/api/tickets/' + ticketId + '/photos')
    .then(function(r) { return r.json(); })
    .then(function(json) {
      var container = $('#drawer-photos');
      if (!container) return;
      var photos = json.data || [];
      if (!photos.length) {
        container.innerHTML = '<span style="color:#aaa;font-size:13px">暂无现场照片</span>';
        return;
      }
      container.innerHTML = '<div class="photos">' + photos.map(function(p, i) {
        var src = API_BASE + p.url;
        return '<div class="photo" style="display:inline-block;margin:0 8px 8px 0;cursor:pointer">' +
          '<img src="' + esc(src) + '" alt="现场照片' + (i + 1) + '" style="width:120px;height:90px;object-fit:cover;border-radius:8px;border:1px solid #e6eaf0" onclick="previewPhoto(\'' + esc(src) + '\')">' +
          '<small style="display:block;text-align:center;color:#8c8c8c;margin-top:4px">照片' + (i + 1) + '</small></div>';
      }).join('') + '</div>';
    })
    .catch(function() {
      var container = $('#drawer-photos');
      if (container) container.innerHTML = '<span style="color:#aaa;font-size:13px">照片加载失败</span>';
    });
}

function previewPhoto(src) {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
  overlay.innerHTML = '<img src="' + src + '" style="max-width:90%;max-height:90%;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.4)">';
  overlay.onclick = function() { document.body.removeChild(overlay); };
  document.body.appendChild(overlay);
}

function closeDrawer() {
  $('#drawerMask').classList.remove('open');
  $('#drawer').classList.remove('open');
  openTicketId = null;
}

/* ============================================================
   工单操作
   ============================================================ */
function pushStep(t, title, who) { t.steps.push({ title, who, time: new Date().toISOString() }); }

function uploadPhoto(id) {
  // 创建隐藏的文件输入框
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = function() {
    if (!input.files.length) return;
    var formData = new FormData();
    for (var i = 0; i < Math.min(input.files.length, 10); i++) {
      formData.append('photos', input.files[i]);
    }
    toast('正在上传 ' + input.files.length + ' 张照片...');
    fetch(API_BASE + '/api/tickets/' + id + '/photos', {
      method: 'POST',
      body: formData
    }).then(r => r.json()).then(d => {
      if (d.success) {
        toast('已上传 ' + d.uploaded + ' 张照片');
        // 更新本地状态
        var t = state.tickets.find(x => x.id === id);
        if (t) {
          t.photos = t.photos || [];
          d.photos.forEach(p => t.photos.push('📷'));
          if (!t.steps.some(s => s.title.includes('现场确认'))) pushStep(t, '现场确认', t.worker);
          save();
        }
        afterAction(id, '已上传 ' + d.uploaded + ' 张照片');
      } else {
        toast('上传失败: ' + (d.error || '未知错误'));
      }
    }).catch(() => toast('上传失败，网络错误'));
  };
  input.click();
}


/* ============================================================
   看板 & 图表
   ============================================================ */

function getChart(id) {
  if (charts[id]) return charts[id];
  charts[id] = echarts.init($('#' + id));
  return charts[id];
}

window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));

/* ============================================================
   管理平台
   ============================================================ */

let editingStaffId = null;
function openStaffModal(id) {
  editingStaffId = id || null;
  const s = id ? state.staff.find(x => x.id === id) : { name: '', role: '维修工', skill: '', phone: '', status: 'on', done: 0, dutyStart: '08:00', dutyEnd: '18:00' };
  $('#modal-title').textContent = id ? '编辑人员' : '新增人员';
  $('#f-name').value = s.name;
  $('#f-role').value = s.role;
  // 技能标签多选
  var skills = (s.skill || '').split('/').map(x => x.trim());
  $$('#f-skill-tags input[type=checkbox]').forEach(cb => { cb.checked = skills.includes(cb.value); });
  $('#f-phone').value = s.phone;
  $('#f-status').value = s.status;
  $('#f-done').value = s.done;
  $('#f-duty-start').value = s.dutyStart || '08:00';
  $('#f-duty-end').value = s.dutyEnd || '18:00';
  $('#f-join-date').value = s.joinDate || '';
  $('#staffModal').classList.add('open');
}
function closeStaffModal() { $('#staffModal').classList.remove('open'); }

function getSelectedSkills() {
  return $$('#f-skill-tags input[type=checkbox]:checked').map(cb => cb.value).join('/') || '—';
}

function saveStaff() {
  const name = $('#f-name').value.trim();
  if (!name) { toast('请填写姓名'); return; }
  const phone = $('#f-phone').value.trim();
  const password = $('#f-password').value;
  const data = {
    name,
    role: $('#f-role').value,
    skill: getSelectedSkills(),
    phone: phone || '—',
    status: $('#f-status').value,
    done: parseInt($('#f-done').value) || 0,
    dutyStart: $('#f-duty-start').value || '08:00',
    dutyEnd: $('#f-duty-end').value || '18:00',
    joinDate: $('#f-join-date').value || '',
  };

  // 状态校验：编辑已有人员时检查工单状态
  if (editingStaffId) {
    var existing = state.staff.find(s => s.id === editingStaffId);
    if (existing && data.status !== existing.status) {
      var staffName = existing.name;
      var hasActive = state.tickets.some(function(t) { return t.worker === staffName && (t.status === 'doing' || t.status === 'confirm'); });
      if (hasActive && (data.status === 'on' || data.status === 'off')) {
        toast('该人员手上还有未完成工单，请先完成或驳回后再更改状态');
        return;
      }
      if (!hasActive && data.status === 'busy') {
        toast('该人员当前没有处理中的工单，无法设为"正在处理"');
        return;
      }
    }
  }

  if (editingStaffId) {
    Object.assign(state.staff.find(s => s.id === editingStaffId), data);
    toast('已更新人员信息');
  } else {
    data.id = 's' + Date.now();
    state.staff.push(data);
    toast('已新增人员');
  }
  // 同步创建/更新登录账号
  if (phone && password) {
    if (!/^1[3-9]\d{9}$/.test(phone)) { toast('手机号格式不正确（需为中国内地11位）'); return; }
    var userRole = data.role === '维修工' ? 'worker' : data.role === '物业管家' ? 'keeper' : data.role === '主管' ? 'admin' : 'worker';
    fetch(API_BASE + '/api/users', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ phone: phone, password: password, name: name, role: userRole })
    }).then(r => r.json()).then(d => {
      if (d.success) toast('登录账号已创建');
      else if (d.error && d.error.includes('已注册')) { /* 已有账号，忽略 */ }
      else if (d.error) toast(d.error);
    }).catch(() => {});
  } else if (!editingStaffId) {
    toast('请填写手机号和密码以创建登录账号'); return;
  }
  save(); renderStaff(); closeStaffModal();
}
function deleteStaff(id) {
  const s = state.staff.find(x => x.id === id);
  if (confirm(`确定删除「${s.name}」？`)) {
    state.staff = state.staff.filter(x => x.id !== id);
    save(); renderStaff(); toast('已删除');
  }
}

/* ============================================================
   小区管理
   ============================================================ */
function initCommunitySelect() {
  var sel = $('#communitySelect');
  if (!sel) return;
  sel.innerHTML = state.communities.map(function(c) {
    return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
  }).join('');
  if (sel.querySelector('option[value="' + currentCommunity + '"]')) {
    sel.value = currentCommunity;
  } else if (state.communities.length) {
    currentCommunity = state.communities[0].id;
    sel.value = currentCommunity;
  }
  sel.onchange = function() {
    currentCommunity = sel.value;
    localStorage.setItem(LS_COMMUNITY, currentCommunity);
    var name = state.communities.find(function(c) { return c.id === currentCommunity; });
    toast('已切换到：' + (name ? name.name : currentCommunity));
    updateLogo();
    reloadTickets();
  };
  // 非主管隐藏小区管理按钮
  var mgBtn = document.querySelector('.community-switch .btn');
  if (mgBtn) mgBtn.style.display = (currentRole === 'eng_lead') ? '' : 'none';
  updateLogo();
}

function updateLogo() {
  var logo = $('#app-logo');
  if (!logo) return;
  var c = state.communities.find(function(x) { return x.id === currentCommunity; });
  var name = c ? c.name : '';
  logo.textContent = '🏢 ' + (name && name !== '默认小区' ? name + '工单系统' : '工单系统');
}

async function reloadTickets() {
  if (useApi) {
    try {
      var resp = await fetch(API_BASE + '/api/tickets?community_id=' + encodeURIComponent(currentCommunity));
      var json = await resp.json();
      if (json.data) {
        state.tickets = json.data.filter(function(t) { return t.id && t.type; });
        saveLocal();
      }
    } catch(e) { console.warn('重新加载工单失败', e); }
  }
  enhanceState();
  renderAll();
  if ($('#page-dashboard').classList.contains('active')) renderDashboard();
}

function openCommunityModal() {
  renderCommunityList();
  // 渲染新增小区的人员选择
  var staffEl = $('#f-community-staff');
  if (staffEl) {
    staffEl.innerHTML = state.staff.map(function(s) {
      return '<label class="skill-tag"><input type="checkbox" value="' + esc(s.name) + '"><span>' + esc(s.name) + ' · ' + esc(s.role) + '</span></label>';
    }).join('');
  }
  $('#communityModal').classList.add('open');
}
function closeCommunityModal() {
  $('#communityModal').classList.remove('open');
}
function renderCommunityList() {
  var el = $('#community-list');
  if (!state.communities.length) { el.innerHTML = '<div style="color:#aaa">暂无小区</div>'; return; }
  el.innerHTML = state.communities.map(function(c) {
    var isDefault = c.id === 'default';
    var staffNames = (c.allowedStaff || []).join('、') || '全部人员';
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border);flex-wrap:wrap">' +
      '<span style="font-weight:500;min-width:80px">' + esc(c.name) + '</span>' +
      '<span style="color:var(--text-3);font-size:11px;flex:1">' + esc(c.address || '') + '</span>' +
      '<span style="font-size:11px;color:var(--primary)">👷 ' + esc(staffNames) + '</span>' +
      '<button class="btn sm ghost" onclick="editCommunityPermissions(\'' + c.id + '\')">编辑权限</button>' +
      '<button class="btn sm" onclick="getInviteCode(\'' + c.id + '\')" title="生成/查看邀请码">📋 邀请码</button>' +
      (isDefault ? '' : '<button class="btn sm danger" onclick="deleteCommunity(\'' + c.id + '\')">删除</button>') +
      '</div>';
  }).join('');
}

async function getInviteCode(communityId) {
  try {
    var resp = await fetch(API_BASE + '/api/communities/' + communityId + '/invite-code', { method: 'POST', headers: authHeaders() });
    var json = await resp.json();
    if (json.code) {
      var c = state.communities.find(function(x) { return x.id === communityId; });
      var name = c ? c.name : communityId;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(json.code).then(function() {
          toast('邀请码 ' + json.code + ' 已复制到剪贴板');
        });
      }
      alert('「' + name + '」的邀请码：\n\n' + json.code + '\n\n将此码发给师傅，师傅在登录页点"注册"输入即可申请加入。');
    } else {
      toast('生成失败');
    }
  } catch(e) { toast('网络错误'); }
}

function editCommunityPermissions(communityId) {
  var c = state.communities.find(function(x) { return x.id === communityId; });
  if (!c) return;
  var allowed = c.allowedStaff || [];
  var staffHtml = state.staff.map(function(s) {
    var checked = allowed.includes(s.name) ? ' checked' : '';
    return '<label class="skill-tag"><input type="checkbox" value="' + esc(s.name) + '"' + checked + '><span>' + esc(s.name) + ' · ' + esc(s.role) + '</span></label>';
  }).join('');
  var modal = document.createElement('div');
  modal.className = 'modal-mask open';
  modal.id = 'permModal';
  modal.innerHTML = '<div class="modal" style="max-width:480px"><h3>编辑「' + esc(c.name) + '」的人员权限</h3>' +
    '<p style="font-size:12px;color:var(--text-2);margin-bottom:12px">勾选有权限进入该小区的人员（不勾选 = 仅主管可见）</p>' +
    '<div class="skill-tags" id="perm-staff-tags" style="margin-bottom:16px">' + staffHtml + '</div>' +
    '<div class="modal-foot"><button class="btn gray" onclick="closePermModal()">取消</button><button class="btn" onclick="savePermissions(\'' + communityId + '\')">保存</button></div></div>';
  document.body.appendChild(modal);
}

function closePermModal() {
  var m = $('#permModal');
  if (m) document.body.removeChild(m);
}

async function savePermissions(communityId) {
  var checks = $$('#perm-staff-tags input[type=checkbox]:checked');
  var allowedStaff = checks.map(function(cb) { return cb.value; });
  try {
    var resp = await fetch(API_BASE + '/api/communities/' + communityId, {
      method: 'PATCH',
      headers: authHeaders(true),
      body: JSON.stringify({ allowedStaff: allowedStaff })
    });
    var json = await resp.json();
    if (json.success) {
      var c = state.communities.find(function(x) { return x.id === communityId; });
      if (c) c.allowedStaff = allowedStaff;
      renderCommunityList();
      toast('权限已更新');
    } else {
      toast('保存失败: ' + (json.error || ''));
    }
  } catch(e) { toast('网络错误'); }
  closePermModal();
}
async function addCommunity() {
  var name = $('#f-community-name').value.trim();
  if (!name) { toast('请填写小区名称'); return; }
  var addr = $('#f-community-addr').value.trim();
  var allowedStaff = $$('#f-community-staff input[type=checkbox]:checked').map(function(cb) { return cb.value; });
  try {
    var resp = await fetch(API_BASE + '/api/communities', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ name: name, address: addr, allowedStaff: allowedStaff })
    });
    var json = await resp.json();
    if (json.success) {
      state.communities.push(json.community);
      initCommunitySelect();
      renderCommunityList();
      $('#f-community-name').value = '';
      $('#f-community-addr').value = '';
      $$('#f-community-staff input[type=checkbox]').forEach(function(cb) { cb.checked = false; });
      toast('小区「' + name + '」已添加');
    } else {
      toast('添加失败: ' + (json.error || ''));
    }
  } catch(e) { toast('网络错误'); }
}
async function deleteCommunity(id) {
  var c = state.communities.find(function(x) { return x.id === id; });
  if (!confirm('确定删除「' + (c ? c.name : id) + '」？\n该小区下的工单将移入默认小区。')) return;
  try {
    await fetch(API_BASE + '/api/communities/' + id, { method: 'DELETE', headers: authHeaders() });
    state.communities = state.communities.filter(function(x) { return x.id !== id; });
    if (currentCommunity === id) {
      currentCommunity = 'default';
      localStorage.setItem(LS_COMMUNITY, currentCommunity);
      reloadTickets();
    }
    initCommunitySelect();
    renderCommunityList();
    toast('已删除');
  } catch(e) { toast('删除失败'); }
}


/* ============================================================
   工单优先级 / 帮助工单 / 真实数据看板增强
   ============================================================ */
var PRIORITY_LABEL = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
var PRIORITY_ORDER = { urgent: 4, high: 3, normal: 2, low: 1 };
var HELP_CATS = ['生活帮助', '咨询建议', '邻里协调', '其他'];

function inferPriority(t) {
  var text = [t.cat, t.desc, t.elements && t.elements.event].join('');
  if (/爆裂|燃气|消防|积水|挡路|跳闸|断电|卡死|危险|突发/.test(text)) return 'urgent';
  if (/漏水|占用|损坏|噪音|投诉|卫生差|堵塞/.test(text)) return 'high';
  if (/建议|咨询|代收|座椅/.test(text)) return 'low';
  return 'normal';
}
function typeLabel(t) { return t.type === 'repair' ? '报修' : (t.type === 'complaint' ? '投诉' : '帮助/其他'); }
function typeCats(type) { return type === 'repair' ? SEED.repairCats : (type === 'complaint' ? SEED.complaintCats : HELP_CATS); }
function leadFor(t) { return 'eng_lead'; }
function isLead(t) { return currentRole === 'eng_lead'; }
function priorityHtml(p) { p = p || 'normal'; return `<span class="priority-tag ${p}"><i class="priority-dot ${p}"></i>${PRIORITY_LABEL[p]}</span>`; }
function ageLabel(t) {
  var end = t.finished || new Date().toISOString();
  var h = Math.max(0, durHours(t.created, end) || 0);
  if (h < 1) return Math.round(h * 60) + '分钟';
  if (h < 24) return h.toFixed(1) + '小时';
  return Math.floor(h / 24) + '天' + Math.round(h % 24) + '小时';
}
function ticketSla(t) { return t.priority === 'urgent' ? 2 : (t.priority === 'high' ? 8 : (t.priority === 'normal' ? 24 : 48)); }
function isOnTime(t) { var h = durHours(t.created, t.finished); return h != null && h <= ticketSla(t); }
function activeStaff(role) {
  var now = new Date();
  var currentHM = now.getHours() * 60 + now.getMinutes();
  return state.staff.filter(s => {
    if (s.role !== role || s.status !== 'on') return false;
    // 检查值班时间
    var start = parseHM(s.dutyStart || '00:00');
    var end = parseHM(s.dutyEnd || '23:59');
    if (start <= end) return currentHM >= start && currentHM <= end;
    // 跨午夜（如 22:00 ~ 06:00）
    return currentHM >= start || currentHM <= end;
  });
}
function parseHM(hm) { var p = (hm || '08:00').split(':'); return parseInt(p[0]) * 60 + parseInt(p[1] || 0); }

function enhanceState() {
  state.tickets.forEach(t => {
    t.priority = t.priority || inferPriority(t);
    t.rejectHistory = t.rejectHistory || [];
    t.steps = t.steps || [];
    t.photos = t.photos || [];
    t.aggregated = t.aggregated || [];
    t.repeatOf = t.repeatOf || '';
    t.repeatCount = Number(t.repeatCount) || 1;
    t.isRecurring = Boolean(t.isRecurring);
    t.recurrenceNote = t.recurrenceNote || '';
    t.feedbackCount = Number(t.feedbackCount) || 1;
    t.notes = t.notes || [];
    t.urged = t.urged || [];
    t.suspendReason = t.suspendReason || '';
    t.suspendEstimate = t.suspendEstimate || '';
  });
  // 自动推导师傅状态 + 确保 joinDate
  state.staff.forEach(s => {
    s.joinDate = s.joinDate || '2026-01-01';
    if (s.status === 'off') return;
    var hasActive = state.tickets.some(t => t.worker === s.name && (t.status === 'doing' || t.status === 'confirm'));
    s.status = hasActive ? 'busy' : 'on';
  });
}

function setupEnhancedUI() {
  var dash = $('#page-dashboard');
  dash.querySelector('.page-sub').textContent = '实时统计报修 / 投诉 / 帮助工单；所有图表均由当前工单数据计算';
  var kpis = dash.querySelector('.kpi-grid');
  if (!$('#kpi-help')) kpis.insertAdjacentHTML('beforeend', '<div class="kpi teal"><div class="label">帮助/其他</div><div class="value" id="kpi-help">—</div><div class="trend">生活帮助/咨询/协调/其他</div></div><div class="kpi orange"><div class="label">紧急待处理</div><div class="value" id="kpi-urgent">—</div><div class="trend">按紧急度与等待时间排序</div></div>');
  var grid = dash.querySelector('.chart-grid');
  if (!$('#chart-event-frequency')) grid.insertAdjacentHTML('beforeend', '<div class="chart-card chart-full"><h3>事件发生频率（全部工单）</h3><div class="chart-box" id="chart-event-frequency"></div></div><div class="chart-card performance-card"><h3>师傅 / 管家处理明细与表现</h3><div class="table-wrap"><table class="performance-table"><thead><tr><th>人员</th><th>处理过什么</th><th>总工单</th><th>已完成</th><th>处理中</th><th>平均时长</th><th>按时率</th><th>表现</th></tr></thead><tbody id="tbody-performance"></tbody></table></div></div>');
  if (!$('#page-help')) $('#page-management').insertAdjacentHTML('beforebegin', `<section class="page" id="page-help"><div class="page-title">帮助 / 其他工单</div><div class="page-sub">生活帮助、咨询建议、邻里协调及其他事项</div><div class="card"><div class="priority-legend"><b>优先级：</b><span><i class="priority-dot urgent"></i>紧急</span><span><i class="priority-dot high"></i>高</span><span><i class="priority-dot normal"></i>普通</span><span><i class="priority-dot low"></i>低</span><span>默认同级按等待时间从长到短</span></div><div class="toolbar"><select id="filter-status-help"></select><select id="filter-cat-help"></select><select id="filter-priority-help"></select><select id="sort-help"><option value="newest" selected>最新创建</option><option value="oldest">等待最久</option><option value="priority">紧急度优先</option></select><span class="spacer"></span><span class="count" id="count-help"></span></div><div class="table-wrap"><table><thead><tr><th>优先级</th><th>工单号</th><th>位置</th><th>状态</th><th>负责人</th><th>创建时间</th><th>已等待/处理时长</th></tr></thead><tbody id="tbody-help"></tbody></table></div></div></section>`);
  ['repair','complaint'].forEach(type => {
    var page = $('#page-' + type), toolbar = page.querySelector('.toolbar');
    if (!$('#filter-priority-' + type)) toolbar.querySelector('.spacer').insertAdjacentHTML('beforebegin', `<select id="filter-priority-${type}"></select><select id="sort-${type}"><option value="newest" selected>最新创建</option><option value="oldest">等待最久</option><option value="priority">紧急度优先</option></select>`);
    if (!page.querySelector('.priority-legend')) page.querySelector('.card').insertAdjacentHTML('afterbegin', '<div class="priority-legend"><b>优先级：</b><span><i class="priority-dot urgent"></i>紧急</span><span><i class="priority-dot high"></i>高</span><span><i class="priority-dot normal"></i>普通</span><span><i class="priority-dot low"></i>低</span><span>同级按等待时间排序</span></div>');
    page.querySelector('thead tr').innerHTML = type === 'repair' 
      ? '<th>优先级</th><th>工单号</th><th>位置</th><th>类型</th><th>状态</th><th>负责人</th><th>创建时间</th><th>已等待/处理时长</th>'
      : '<th>优先级</th><th>工单号</th><th>位置</th><th>状态</th><th>负责人</th><th>创建时间</th><th>已等待/处理时长</th>';
  });
}

function initFilters(type) {
  var catSel = $(`#filter-cat-${type}`);
  if (type === 'repair') {
    catSel.innerHTML = '<option value="">全部类型</option>' + typeCats(type).map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    catSel.style.display = '';
  } else {
    catSel.innerHTML = '<option value="">全部类型</option>';
    catSel.style.display = 'none';
  }
  $(`#filter-status-${type}`).innerHTML = '<option value="">全部状态</option>' + Object.entries(STATUS_LABEL).map(([k,v]) => `<option value="${k}">${v}</option>`).join('');
  $(`#filter-priority-${type}`).innerHTML = '<option value="">全部优先级</option>' + Object.entries(PRIORITY_LABEL).map(([k,v]) => `<option value="${k}">${v}</option>`).join('');
  [`filter-cat-${type}`,`filter-status-${type}`,`filter-priority-${type}`,`sort-${type}`].forEach(id => $('#' + id).onchange = () => renderTickets(type));
}
function recurrenceBadges(t) {
  var badges = '';
  if (t.isRecurring) badges += `<span class="recurrence-badge">复发 ×${t.repeatCount || 2}</span>`;
  if ((t.feedbackCount || 1) > 1) badges += `<span class="feedback-badge">多人反馈 ×${t.feedbackCount}</span>`;
  return badges ? `<div class="ticket-badges">${badges}</div>` : '';
}

function recurrenceAlert(t) {
  if (t.isRecurring) {
    return `<div class="recurrence-alert"><div class="recurrence-alert-icon">⚠️</div><div><b>复发问题提醒</b><p>${esc(t.recurrenceNote || `该位置近期再次发生“${t.cat}”，可能存在系统性故障。`)}</p>${t.repeatOf ? `<button type="button" class="recurrence-history-link" id="recurrence-history-link" data-ticket-id="${esc(t.repeatOf)}">查看历史工单 ${esc(t.repeatOf)}</button>` : ''}</div></div>`;
  }
  if ((t.feedbackCount || 1) > 1) {
    return `<div class="feedback-alert"><b>多人重复反馈：</b>15 分钟内已有 ${t.feedbackCount} 位居民反馈同一问题，请优先核实影响范围。</div>`;
  }
  return '';
}

function renderTickets(type) {
  var tbody = $(`#tbody-${type}`); if (!tbody) return;
  var rows = state.tickets.filter(t => t.type === type && t.status !== 'done');
  // 师傅/管家视图：只看自己负责的工单
  var myName = roleWorkerName();
  if (currentRole.startsWith('worker_') && myName) rows = rows.filter(t => t.worker === myName);
  if (currentRole.startsWith('pm_keeper_')) { var keeperName = currentRole.replace('pm_keeper_',''); rows = rows.filter(t => t.worker === keeperName); }
  var fs=$(`#filter-status-${type}`).value, fc=$(`#filter-cat-${type}`).value, fp=$(`#filter-priority-${type}`).value, sort=$(`#sort-${type}`).value;
  if(fs) rows=rows.filter(t=>t.status===fs); if(fc) rows=rows.filter(t=>t.cat===fc); if(fp) rows=rows.filter(t=>t.priority===fp);
  rows.sort((a,b) => sort==='newest' ? new Date(b.created)-new Date(a.created) : sort==='oldest' ? new Date(a.created)-new Date(b.created) : (PRIORITY_ORDER[b.priority]-PRIORITY_ORDER[a.priority] || new Date(a.created)-new Date(b.created)));
  $(`#count-${type}`).textContent=`共 ${rows.length} 张工单`;
  var showCat = (type === 'repair');
  var colspan = showCat ? 8 : 7;
  if(!rows.length){tbody.innerHTML='<tr><td colspan="'+colspan+'" class="empty">暂无符合条件的工单</td></tr>';return;}
  tbody.innerHTML=rows.map(t=>{var h=durHours(t.created,t.finished||new Date().toISOString())||0;var urgedMark=t.urged&&t.urged.length?' <span style="color:#d97706;font-size:11px" title="已被催办'+t.urged.length+'次">⚡</span>':'';var catTd=showCat?'<td><span class="tag cat">'+esc(t.cat)+'</span></td>':'';return `<tr class="ticket-row-${t.priority}" onclick="openDrawer('${t.id}')"><td>${priorityHtml(t.priority)}</td><td class="mono"><div>${esc(t.id)}</div>${recurrenceBadges(t)}</td><td>${esc(t.loc)}</td>${catTd}<td><span class="tag ${STATUS_CLASS[t.status]}">${STATUS_LABEL[t.status]}</span>${urgedMark}</td><td>${t.worker?avatar(t.worker,staffColor(t.worker))+esc(t.worker):'<span style="color:#aaa">待指派</span>'}</td><td class="mono">${fmtTime(t.created)}</td><td><span class="wait-age ${t.status!=='done'&&h>ticketSla(t)?'overdue':''}">${t.status==='done'?'处理用时':'已等待'} ${ageLabel(t)}</span></td></tr>`}).join('');
}

function hint(text) { return `<div class="hint">ℹ️ ${esc(text)}</div>`; }

function openDrawer(id) {
  var t=state.tickets.find(x=>x.id===id); if(!t)return; openTicketId=id;
  $('#drawer-title').textContent=`${t.id} · ${t.cat}`; $('#drawer-sub').textContent=`${t.loc}　|　${STATUS_LABEL[t.status]}`;
  var rejects=(t.rejectHistory||[]).map(r=>`<div class="reject-history"><b>驳回：</b>${esc(r.reason)} · ${esc(r.who)} · ${fmtTime(r.time)}</div>`).join('');
  var timeline=(t.steps||[]).map((s,i)=>`<div class="tl-item ${i===t.steps.length-1&&t.status!=='done'?'current':'done'}"><div class="dot"></div><div class="tl-title">${esc(s.title)}</div><div class="tl-meta">${esc(s.who)} · ${fmtTime(s.time)}</div></div>`).join('');
  var photos='<div id="drawer-photos" style="color:#aaa;font-size:13px">加载照片中...</div>';
  var repeatAlert=recurrenceAlert(t);
  // 备注列表
  var notesHtml = '';
  if (t.notes && t.notes.length) {
    notesHtml = '<div class="drawer-section"><h4>📝 备注</h4>' + t.notes.map(function(n) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--hairline-soft);font-size:12px"><b>' + esc(n.who) + '</b> · <span style="color:var(--muted)">' + fmtTime(n.time) + '</span><div style="margin-top:2px;color:var(--text)">' + esc(n.text) + '</div></div>';
    }).join('') + '</div>';
  }
  // 催办提醒
  var urgedHtml = '';
  if (t.urged && t.urged.length) {
    var lastUrge = t.urged[t.urged.length - 1];
    urgedHtml = '<div style="padding:8px 12px;background:#fff3cd;border:1px solid #ffc107;border-radius:6px;font-size:12px;margin-bottom:12px;color:#856404">⚡ 已被催办（' + esc(lastUrge.who) + ' · ' + fmtTime(lastUrge.time) + '）共 ' + t.urged.length + ' 次</div>';
  }
  $('#drawer-body').innerHTML=`${repeatAlert}${urgedHtml}<div class="drawer-section"><h4>工单信息</h4><div class="elements"><div class="elem"><div class="k">优先级</div><div class="v">${priorityHtml(t.priority)}</div></div><div class="elem"><div class="k">事件类别</div><div class="v">${esc(typeLabel(t))} · ${esc(t.cat)}</div></div><div class="elem"><div class="k">地点</div><div class="v">${esc(t.loc)}</div></div><div class="elem"><div class="k">已等待/处理</div><div class="v">${ageLabel(t)}</div></div><div class="elem"><div class="k">创建时间</div><div class="v">${fmtTime(t.created)}</div></div><div class="elem full"><div class="k">问题描述</div><div class="v">${esc(t.desc)}</div></div></div>${rejects}</div><div class="drawer-section"><h4>流转时间线</h4><div class="timeline">${timeline}</div></div>${notesHtml}<div class="drawer-section"><h4>现场材料</h4>${photos}</div><div class="drawer-section"><h4>操作（当前角色：${esc(roleObj().name)}）</h4><div class="actions">${buildActions(t)}</div></div>`;
  $('#drawerMask').classList.add('open'); $('#drawer').classList.add('open');
  var historyLink=$('#recurrence-history-link');
  if(historyLink) historyLink.onclick=function(){openDrawer(historyLink.dataset.ticketId);};
  loadDrawerPhotos(id);
}
function buildActions(t) {
  var repair=t.type==='repair', keeper=!repair, mine=repair&&currentRole.startsWith('worker_')&&t.worker===roleWorkerName();
  var noteBtn = `<button class="btn sm ghost" onclick="addTicketNote('${t.id}')">📝 备注</button>`;
  var urgeBtn = (isLead(t) && t.status === 'pending') ? `<button class="btn sm" style="background:var(--warning);color:#fff" onclick="urgeTicket('${t.id}')">⚡ 催办</button>` : '';

  if(t.status==='wait'){
    if(!isLead(t)) return hint(`仅${repair?'工程部':'物业'}主管可指派。`);
    var people=activeStaff(repair?'维修工':'物业管家'); if(!people.length)return hint('暂无可派单人员（全部正在处理、请假或不在值班时段）。');
    var defHrs = CAT_DEFAULT_HOURS[t.cat] || 2;
    var timeOpts = [0.5,1,1.5,2,2.5,3,4,5,6,8].map(h => `<option value="${h}"${h===defHrs?' selected':''}>${h}小时</option>`).join('');
    return `<select id="assignWorker">${people.map(s=>`<option value="${esc(s.name)}">${esc(s.name)} · ${esc(s.skill)}</option>`).join('')}</select><select id="assignDuration" title="预计处理时间">${timeOpts}</select><button class="btn" onclick="assignTicket('${t.id}')">确认指派</button>`;
  }
  if(t.status==='doing'){
    if(mine) return `<button class="btn teal" onclick="uploadPhoto('${t.id}')">上传照片</button><button class="btn green" onclick="workerFinish('${t.id}','once')">完成·提交</button><button class="btn gray" onclick="suspendTicket('${t.id}')">⏸ 搁置</button><button class="btn danger" onclick="workerReject('${t.id}')">退回</button> ${noteBtn}`;
    if(keeper&&currentRole.startsWith('pm_keeper_')) return `<button class="btn green" onclick="workerFinish('${t.id}','once')">完成·提交</button><button class="btn gray" onclick="suspendTicket('${t.id}')">⏸ 搁置</button><button class="btn danger" onclick="workerReject('${t.id}')">退回</button> ${noteBtn}`;
    return hint(`已指派给 ${esc(t.worker||'处理人')}。`) + ` ${urgeBtn} ${noteBtn}`;
  }
  if(t.status==='pending'){
    var suspendInfo = t.suspendReason ? `<div style="margin-bottom:8px;padding:8px 12px;background:var(--tint-yellow);border-radius:6px;font-size:12px;color:#92600a">⏸ 搁置原因：${esc(t.suspendReason)}${t.suspendEstimate ? '　预计恢复：' + esc(t.suspendEstimate) : ''}</div>` : '';
    if(mine || (keeper&&currentRole.startsWith('pm_keeper_'))) return suspendInfo + `<button class="btn green" onclick="resumeTicket('${t.id}')">▶ 恢复处理</button> ${noteBtn}`;
    if(isLead(t)) return suspendInfo + `<button class="btn green" onclick="resumeTicket('${t.id}')">▶ 恢复处理</button> ${urgeBtn} ${noteBtn}`;
    return suspendInfo + hint('工单搁置中，等待处理人恢复。');
  }
  if(t.status==='confirm') return (isLead(t)?`<button class="btn green" onclick="confirmDone('${t.id}')">确认完成</button><button class="btn danger" onclick="reject('${t.id}')">驳回工单</button>`:hint('等待主管审核。')) + ` ${noteBtn}`;
  return hint('工单已完成。') + ` ${noteBtn}`;
}
function assignTicket(id){
  var t=state.tickets.find(x=>x.id===id);
  if(!t||t.status!=='wait'||!isLead(t)){toast('无权指派该工单');return;}
  var el=$('#assignWorker');if(!el)return;
  var workerName=el.value;
  var durEl=$('#assignDuration');
  var estHours=durEl?parseFloat(durEl.value)||2:2;

  // 日程冲突检测：检查该师傅当前是否有时间重叠
  var conflicts=checkAssignConflicts(workerName, t, estHours);
  if(conflicts.length){
    var msg='⚠️ 日程冲突提醒：\n\n'+workerName+' 在以下时段已有工单：\n\n';
    conflicts.forEach(function(c){
      msg+='• '+c.ticketId+'（'+c.cat+'）\n  时间：'+c.startTime+' ~ '+c.endTime+'\n  重叠：'+c.overlap+'小时\n\n';
    });
    msg+='当前工单预计时段：'+conflicts[0].newStart+' ~ '+conflicts[0].newEnd+'\n\n确定仍要派单给该师傅吗？';
    if(!confirm(msg))return;
  }

  t.worker=workerName;
  t.status='doing';
  t.estimatedHours=estHours;
  pushStep(t,t.type==='repair'?'工单分配':'主管指派',roleObj().name);
  save();apiPatch(t.id,{status:'doing',worker:t.worker});
  afterAction(id,'已指派给 '+t.worker+'，预计 '+(t.estimatedHours||2)+'h');
}

function checkAssignConflicts(workerName, newTicket, estHours){
  var newStart=new Date(newTicket.created||new Date().toISOString());
  var newEnd=new Date(newStart.getTime()+estHours*3600000);
  var results=[];

  state.tickets.forEach(function(t){
    if(t.id===newTicket.id)return;
    if(t.worker!==workerName)return;
    if(t.status==='done'||t.status==='wait')return;
    // 计算已有工单的时间块
    var tStart=new Date(t.created);
    var tHours=estimateDuration(t);
    var tEnd=new Date(tStart.getTime()+tHours*3600000);
    // 判断是否重叠
    if(newStart<tEnd&&newEnd>tStart){
      var overlapStart=Math.max(newStart.getTime(),tStart.getTime());
      var overlapEnd=Math.min(newEnd.getTime(),tEnd.getTime());
      var overlapH=((overlapEnd-overlapStart)/3600000).toFixed(1);
      results.push({
        ticketId:t.id,
        cat:t.cat||'',
        startTime:fmtHM(tStart),
        endTime:fmtHM(tEnd),
        overlap:overlapH,
        newStart:fmtHM(newStart),
        newEnd:fmtHM(newEnd)
      });
    }
  });
  return results;
}
function workerFinish(id,mode){var t=state.tickets.find(x=>x.id===id);if(!t||t.status!=='doing'){toast('当前状态不可提交');return;}var allowed=t.type==='repair'?(t.worker===roleWorkerName()):(currentRole.startsWith('pm_keeper_'));if(!allowed){toast('仅当前负责人可提交，且不可转单');return;}if(t.type==='repair'&&!t.steps.some(s=>s.title.includes('现场确认')))pushStep(t,'现场确认',t.worker);pushStep(t,t.type==='repair'?'维修完成·提交结果':'处理完成·提交结果',t.worker);t.status='confirm';save();apiPatch(t.id,{status:'confirm'});afterAction(id,'已提交结果，等待主管审核');}
function confirmDone(id){var t=state.tickets.find(x=>x.id===id);if(!t||t.status!=='confirm'||!isLead(t)){toast('仅主管可确认待审核工单');return;}t.status='done';t.finished=new Date().toISOString();pushStep(t,'主管确认完成',roleObj().name);save();apiPatch(t.id,{status:'done',finished:t.finished});afterAction(id,'工单已确认完成');}
function reject(id){var t=state.tickets.find(x=>x.id===id);if(!t||t.status!=='confirm'||!isLead(t)){toast('仅主管可驳回待确认工单');return;}var reason=prompt('请输入驳回原因（必填）：','现场材料不完整，请补充后重新提交');if(reason===null)return;reason=reason.trim();if(!reason){toast('驳回原因不能为空');return;}t.rejectHistory=t.rejectHistory||[];t.rejectHistory.push({reason:reason,who:roleObj().name,time:new Date().toISOString()});pushStep(t,'主管驳回：'+reason,roleObj().name);t.status='doing';save();apiPatch(t.id,{status:'doing',rejectReason:reason});afterAction(id,'工单已驳回给原负责人，不允许转单');}
function workerReject(id){var t=state.tickets.find(x=>x.id===id);if(!t||t.status!=='doing'){toast('当前状态不可退回');return;}var allowed=t.type==='repair'?(t.worker===roleWorkerName()):(currentRole.startsWith('pm_keeper_'));if(!allowed){toast('仅当前负责人可退回工单');return;}var reason=prompt('请输入无法处理的原因（必填）：','现场条件不满足/需要其他工种配合/非本人技能范围');if(reason===null)return;reason=reason.trim();if(!reason){toast('退回原因不能为空');return;}t.rejectHistory=t.rejectHistory||[];t.rejectHistory.push({reason:reason,who:roleObj().name,time:new Date().toISOString()});pushStep(t,'维修人员退回：'+reason,roleObj().name);t.worker='';t.status='wait';save();apiPatch(t.id,{status:'wait',worker:'',rejectReason:reason});afterAction(id,'工单已退回，等待主管重新派单');}
function afterAction(id,msg){toast(msg);enhanceState();renderAll();renderDashboard();if(id)openDrawer(id);}

/* ============================================================
   搁置 / 恢复 / 备注 / 催办
   ============================================================ */
function syncMetadata(t) {
  var meta = JSON.stringify({ notes: t.notes || [], urged: t.urged || [], suspendReason: t.suspendReason || '', suspendEstimate: t.suspendEstimate || '', steps: t.steps || [] });
  apiPatch(t.id, { metadata: meta }).catch(function() {
    // 重试一次
    setTimeout(function() { apiPatch(t.id, { metadata: meta }); }, 2000);
  });
}

function suspendTicket(id) {
  var t = state.tickets.find(x => x.id === id);
  if (!t || t.status !== 'doing') { toast('仅处理中的工单可搁置'); return; }
  var reason = prompt('搁置原因（必填）：', '等待零件到货');
  if (reason === null) return;
  reason = reason.trim();
  if (!reason) { toast('请填写搁置原因'); return; }
  var estimateDate = prompt('预计恢复日期（选填，格式 YYYY-MM-DD）：', '');
  t.status = 'pending';
  t.suspendReason = reason;
  t.suspendTime = new Date().toISOString();
  t.suspendEstimate = estimateDate ? estimateDate.trim() : '';
  pushStep(t, '搁置：' + reason + (t.suspendEstimate ? '（预计' + t.suspendEstimate + '恢复）' : ''), roleObj().name);
  save();
  apiPatch(t.id, { status: 'pending' });
  syncMetadata(t);
  afterAction(id, '工单已搁置');
}

function resumeTicket(id) {
  var t = state.tickets.find(x => x.id === id);
  if (!t || t.status !== 'pending') { toast('仅搁置中的工单可恢复'); return; }
  t.status = 'doing';
  t.suspendReason = '';
  t.suspendTime = '';
  t.suspendEstimate = '';
  pushStep(t, '恢复处理', roleObj().name);
  save();
  apiPatch(t.id, { status: 'doing' });
  syncMetadata(t);
  afterAction(id, '工单已恢复处理');
}

function addTicketNote(id) {
  var t = state.tickets.find(x => x.id === id);
  if (!t) return;
  var note = prompt('添加备注：');
  if (note === null || !note.trim()) return;
  t.notes = t.notes || [];
  t.notes.push({ text: note.trim(), who: roleObj().name, time: new Date().toISOString() });
  pushStep(t, '备注：' + note.trim(), roleObj().name);
  save();
  syncMetadata(t);
  afterAction(id, '备注已添加');
}

function urgeTicket(id) {
  var t = state.tickets.find(x => x.id === id);
  if (!t) { toast('工单不存在'); return; }
  if (t.status !== 'pending') { toast('仅搁置中的工单可催办'); return; }
  t.urged = t.urged || [];
  t.urged.push({ who: roleObj().name, time: new Date().toISOString() });
  pushStep(t, '⚡ 催办', roleObj().name);
  save();
  var meta = JSON.stringify({ notes: t.notes || [], urged: t.urged || [], suspendReason: t.suspendReason || '', suspendEstimate: t.suspendEstimate || '', steps: t.steps || [] });
  apiPatch(t.id, { metadata: meta, _action: 'urge' });
  toast('已催办「' + t.id + '」，处理人将收到提醒');
  openDrawer(id);
}

function staffMetrics(name){var all=state.tickets.filter(t=>t.worker===name),done=all.filter(t=>t.status==='done'),active=all.filter(t=>t.status==='doing'||t.status==='confirm'),d=done.map(t=>durHours(t.created,t.finished)).filter(x=>x!=null),avg=d.length?(d.reduce((a,b)=>a+b,0)/d.length):null,on=done.filter(isOnTime).length,cats=[...new Set(all.map(t=>t.cat))];return{all,done,active,avg,onRate:done.length?Math.round(on/done.length*100):0,cats};}
function performanceScore(m){if(!m.done.length)return 60;return Math.max(0,Math.min(100,Math.round(m.onRate*.7+Math.max(0,30-(m.avg||0)))));}
function renderPerformance(){var body=$('#tbody-performance');if(!body)return;var staffList=state.staff.filter(s=>s.role==='维修工'||s.role==='物业管家');body.innerHTML=staffList.map(s=>{var m=staffMetrics(s.name),score=performanceScore(m),cls=score>=85?'good':score<70?'warn':'';return `<tr style="cursor:pointer" onclick="openStaffProfile('${s.id}')"><td>${avatar(s.name,staffColor(s.name))}<b>${esc(s.name)}</b><br><small>${esc(s.role)} · ${esc(s.skill)}</small></td><td class="type-list">${m.cats.length?m.cats.map(c=>`<span class="tag cat">${esc(c)}</span>`).join(' '):'暂无工单'}</td><td>${m.all.length}</td><td>${m.done.length}</td><td>${m.active.length}</td><td>${m.avg==null?'—':m.avg.toFixed(1)+'h'}</td><td>${m.done.length?m.onRate+'%':'—'}</td><td><span class="performance-score ${cls}">${score}</span><small>/100</small></td></tr>`}).join('');}
function renderStaff(){var tbody=$('#tbody-staff');if(!tbody)return;var staffList=state.staff.filter(s=>s.role==='维修工'||s.role==='物业管家');tbody.innerHTML=staffList.map(s=>{var m=staffMetrics(s.name),st=s.status==='on'?'在岗待命':s.status==='busy'?'正在处理':'请假',dot=s.status==='on'?'on':s.status==='busy'?'busy':'off';return `<tr style="cursor:pointer" onclick="openStaffProfile('${s.id}')"><td>${avatar(s.name,staffColor(s.name))}${esc(s.name)}</td><td>${esc(s.role)}</td><td>${esc(s.skill)}</td><td class="mono">${esc(s.phone)}</td><td><span class="staff-status"><span class="status-dot ${dot}"></span>${st}</span></td><td><b>${m.done.length}</b> / 共${m.all.length}</td><td><button class="btn sm ghost" onclick="event.stopPropagation();openStaffModal('${s.id}')">编辑</button> <button class="btn sm danger" onclick="event.stopPropagation();deleteStaff('${s.id}')">删除</button></td></tr>`}).join('');}

function openStaffProfile(id){
  var s=state.staff.find(x=>x.id===id);if(!s)return;
  var m=staffMetrics(s.name);
  var score=performanceScore(m);
  var cls=score>=85?'good':score<70?'warn':'';
  var st=s.status==='on'?'在岗待命':s.status==='busy'?'正在处理':'请假';
  // 最近工单列表
  var recentTickets=state.tickets.filter(t=>t.worker===s.name).sort((a,b)=>new Date(b.created)-new Date(a.created)).slice(0,10);
  var ticketRows=recentTickets.map(t=>`<tr onclick="openDrawer('${t.id}')"><td class="mono">${esc(t.id)}</td><td><span class="tag cat">${esc(t.cat)}</span></td><td>${esc(t.loc)}</td><td><span class="tag ${STATUS_CLASS[t.status]}">${STATUS_LABEL[t.status]}</span></td><td>${fmtTime(t.created)}</td><td>${t.status==='done'&&t.finished?durHours(t.created,t.finished)+'h':'—'}</td></tr>`).join('');
  // SLA详情
  var slaDetail='';
  if(m.done.length){
    var urgent=m.done.filter(t=>t.priority==='urgent'),high=m.done.filter(t=>t.priority==='high'),normal=m.done.filter(t=>t.priority==='normal');
    slaDetail=`<div style="margin-top:12px;font-size:13px;color:#5e6573">SLA明细：紧急(2h内) ${urgent.filter(isOnTime).length}/${urgent.length} · 高(8h内) ${high.filter(isOnTime).length}/${high.length} · 普通(24h内) ${normal.filter(isOnTime).length}/${normal.length}</div>`;
  }

  $('#drawer-title').textContent=s.name+' · 人员档案';
  $('#drawer-sub').textContent=s.role+' · '+s.skill;
  $('#drawer-body').innerHTML=`
    <div class="drawer-section">
      <h4>基本信息</h4>
      <div class="elements">
        <div class="elem"><div class="k">姓名</div><div class="v">${esc(s.name)}</div></div>
        <div class="elem"><div class="k">角色</div><div class="v">${esc(s.role)}</div></div>
        <div class="elem"><div class="k">技能</div><div class="v">${esc(s.skill)}</div></div>
        <div class="elem"><div class="k">电话</div><div class="v">${esc(s.phone)}</div></div>
        <div class="elem"><div class="k">状态</div><div class="v">${st}</div></div>
      </div>
    </div>
    <div class="drawer-section">
      <h4>绩效概览</h4>
      <div class="elements">
        <div class="elem"><div class="k">综合评分</div><div class="v"><span class="performance-score ${cls}">${score}</span> / 100</div></div>
        <div class="elem"><div class="k">总工单</div><div class="v">${m.all.length} 张</div></div>
        <div class="elem"><div class="k">已完成</div><div class="v">${m.done.length} 张</div></div>
        <div class="elem"><div class="k">处理中</div><div class="v">${m.active.length} 张</div></div>
        <div class="elem"><div class="k">平均处理时长</div><div class="v">${m.avg==null?'暂无数据':m.avg.toFixed(1)+' 小时'}</div></div>
        <div class="elem"><div class="k">按时完成率</div><div class="v">${m.done.length?m.onRate+'%':'暂无数据'}</div></div>
      </div>
      ${slaDetail}
    </div>
    <div class="drawer-section">
      <h4>擅长处理</h4>
      <div class="type-list">${m.cats.length?m.cats.map(c=>'<span class="tag cat">'+esc(c)+'</span>').join(' '):'<span style="color:#aaa">暂无工单记录</span>'}</div>
    </div>
    <div class="drawer-section">
      <h4>最近工单（最多10条）</h4>
      ${recentTickets.length?'<div class="table-wrap"><table><thead><tr><th>工单号</th><th>类型</th><th>位置</th><th>状态</th><th>创建时间</th><th>耗时</th></tr></thead><tbody>'+ticketRows+'</tbody></table></div>':'<span style="color:#aaa">暂无工单记录</span>'}
    </div>
  `;
  $('#drawerMask').classList.add('open');$('#drawer').classList.add('open');
}

async function renderDashboard(){
  if(currentRole.startsWith('worker_')||currentRole.startsWith('pm_keeper_'))return;
  var ids=['kpi-total','kpi-repair','kpi-complaint','kpi-help','kpi-urgent','kpi-avg','kpi-rate','dashboard-manager-actions'];
  var stateEl=$('#dashboard-api-state');
  ids.forEach(function(id){var el=$('#'+id);if(el)el.textContent='—';});
  if(stateEl){stateEl.textContent='正在加载本月统计…';stateEl.classList.remove('error');}
  try{
    var result=window.WorkforceAPI&&window.WorkforceAPI.dashboardStats
      ? await window.WorkforceAPI.dashboardStats(currentCommunity, 'all')
      : await API.get('/api/dashboard/stats?community_id='+encodeURIComponent(currentCommunity)+'&range=all');
    if(!result||!result.ok||!result.data)throw new Error(result&&result.error||'统计服务暂不可用');
    var data=result.data,byType=data.byType||{};
    function value(id,value,suffix){var el=$('#'+id);if(el)el.textContent=(value===null||value===undefined?'—':value)+(suffix||'');}
    value('kpi-total',data.monthTotal,' 张');
    value('kpi-repair',byType.repair||0,' 张');
    value('kpi-complaint',byType.complaint||0,' 张');
    value('kpi-help',byType.help||0,' 张');
    value('kpi-urgent',data.urgentPending||0,' 张');
    value('kpi-avg',Number(data.averageHours||0).toFixed(1),' 小时');
    value('kpi-rate',Number(data.onTimeRate||0).toFixed(1),'%');
    value('dashboard-manager-actions',data.todayManagerActions||0,' 次');
    if(stateEl)stateEl.textContent='统计区间：系统开始记录至今（起始 '+(data.range&&data.range.from?fmtTime(data.range.from):'—')+'）';
  }catch(error){
    if(stateEl){stateEl.textContent=error.message||'月度统计加载失败';stateEl.classList.add('error');}
  }
}
function drawCharts(){var blue='#1677ff',teal='#13c2c2',orange='#fa8c16',purple='#722ed1',green='#52c41a';function localDateStr(d){var y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return y+'-'+m+'-'+day;}var today=new Date(),days=[],keys=[];for(var i=29;i>=0;i--){var d=new Date(today);d.setHours(0,0,0,0);d.setDate(d.getDate()-i);keys.push(localDateStr(d));days.push((d.getMonth()+1)+'/'+d.getDate());}var series=['repair','complaint','help'].map(type=>keys.map(k=>state.tickets.filter(t=>t.type===type&&localDateStr(new Date(t.created))===k).length));getChart('chart-trend').setOption({tooltip:{trigger:'axis'},legend:{data:['报修','投诉','帮助/其他']},grid:{left:40,right:20,top:40,bottom:30},xAxis:{type:'category',data:days},yAxis:{type:'value',minInterval:1},series:[{name:'报修',type:'line',smooth:true,data:series[0],itemStyle:{color:blue}},{name:'投诉',type:'line',smooth:true,data:series[1],itemStyle:{color:orange}},{name:'帮助/其他',type:'line',smooth:true,data:series[2],itemStyle:{color:teal}}]});var people=state.staff.filter(s=>s.role==='维修工'||s.role==='物业管家'),metrics=people.map(s=>staffMetrics(s.name));getChart('chart-worker-count').setOption({tooltip:{trigger:'axis'},grid:{left:40,right:20,top:20,bottom:60},xAxis:{type:'category',data:people.map(s=>s.name),axisLabel:{rotate:45,fontSize:11}},yAxis:{type:'value',minInterval:1},series:[{type:'bar',data:metrics.map(m=>m.done.length),itemStyle:{color:teal,borderRadius:[5,5,0,0]},label:{show:true,position:'top'}}]});getChart('chart-worker-dur').setOption({tooltip:{trigger:'axis',formatter:'{b}: {c} 小时'},grid:{left:60,right:20,top:30,bottom:60},xAxis:{type:'category',data:people.map(s=>s.name),axisLabel:{rotate:45,fontSize:11}},yAxis:{type:'value',name:'小时',nameTextStyle:{padding:[0,30,0,0]}},series:[{type:'bar',data:metrics.map(m=>m.avg==null?0:+m.avg.toFixed(1)),itemStyle:{color:purple,borderRadius:[5,5,0,0]},label:{show:true,position:'top',formatter:'{c}h'}}]});var cats={};state.tickets.forEach(t=>cats[t.cat]=(cats[t.cat]||0)+1);getChart('chart-cat').setOption({tooltip:{trigger:'item',formatter:'{b}: {c}张 ({d}%)'},legend:{bottom:0,textStyle:{fontSize:11}},color:[blue,orange,teal],series:[{type:'pie',radius:['30%','55%'],center:['50%','45%'],data:[{name:'报修',value:state.tickets.filter(t=>t.type==='repair').length},{name:'投诉',value:state.tickets.filter(t=>t.type==='complaint').length},{name:'帮助/其他',value:state.tickets.filter(t=>t.type==='help').length}],label:{formatter:'{b}\n{c}张',fontSize:11,lineHeight:14,overflow:'none'},labelLine:{length:15,length2:10}}]});var statuses={wait:0,doing:0,confirm:0,done:0};state.tickets.forEach(t=>statuses[t.status]++);getChart('chart-status').setOption({tooltip:{trigger:'item',formatter:'{b}: {c} ({d}%)'},legend:{bottom:0,textStyle:{fontSize:11}},color:[orange,blue,purple,green],series:[{type:'pie',radius:['28%','48%'],center:['50%','46%'],data:Object.entries(statuses).map(([k,value])=>({name:STATUS_LABEL[k],value})),label:{formatter:'{b} {c}',fontSize:11,overflow:'none'},labelLine:{length:15,length2:10}}]});var events=Object.entries(cats).sort((a,b)=>b[1]-a[1]);getChart('chart-event-frequency').setOption({tooltip:{trigger:'axis'},grid:{left:90,right:30,top:15,bottom:25},xAxis:{type:'value',minInterval:1},yAxis:{type:'category',inverse:true,data:events.map(x=>x[0])},series:[{type:'bar',data:events.map(x=>x[1]),itemStyle:{color:blue,borderRadius:[0,5,5,0]},label:{show:true,position:'right'}}]});}
function renderAll(){['repair','complaint','help'].forEach(renderTickets);renderDone();renderStaff();updateNavBadges();if($('#page-dashboard').classList.contains('active'))renderDashboard();}

function updateNavBadges() {
  var counts = { repair: 0, complaint: 0, help: 0 };
  var isLead = currentRole === 'eng_lead';
  var myName = roleWorkerName() || currentRole.replace('pm_keeper_', '');
  state.tickets.forEach(function(t) {
    if (t.status !== 'wait' || counts[t.type] === undefined) return;
    if (isLead) { counts[t.type]++; }
    else { if (t.worker === myName) counts[t.type]++; }
  });
  $$('.nav button').forEach(function(btn) {
    var page = btn.dataset.page;
    if (counts[page] !== undefined) {
      var badge = btn.querySelector('.nav-badge');
      if (counts[page] > 0) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; btn.appendChild(badge); }
        badge.textContent = counts[page];
      } else {
        if (badge) badge.remove();
      }
    }
  });
}

function renderDone(){
  var tbody=$('#tbody-done');if(!tbody)return;
  var rows=state.tickets.filter(t=>t.status==='done');
  // 师傅/管家视图：只看自己已完成的工单
  var myName=roleWorkerName();
  if(currentRole.startsWith('worker_')&&myName) rows=rows.filter(t=>t.worker===myName);
  if(currentRole.startsWith('pm_keeper_')){var keeperName=currentRole.replace('pm_keeper_','');rows=rows.filter(t=>t.worker===keeperName);}
  // 搜索工单号
  var search=($('#search-done')||{}).value;
  if(search)rows=rows.filter(t=>t.id.toLowerCase().includes(search.toLowerCase()));
  var ft=$('#filter-type-done').value;
  if(ft)rows=rows.filter(t=>t.type===ft);
  var fc=$('#filter-cat-done').value;
  if(fc)rows=rows.filter(t=>t.cat===fc);
  rows.sort((a,b)=>new Date(b.finished||b.created)-new Date(a.finished||a.created));
  $('#count-done').textContent='共 '+rows.length+' 张已完成';
  if(!rows.length){tbody.innerHTML='<tr><td colspan="8" class="empty">暂无已完成工单</td></tr>';return;}
  tbody.innerHTML=rows.map(t=>`<tr onclick="openDrawer('${t.id}')" style="cursor:pointer"><td class="mono"><div>${esc(t.id)}</div>${recurrenceBadges(t)}</td><td>${esc(typeLabel(t))}</td><td><span class="tag cat">${esc(t.cat)}</span></td><td>${esc(t.loc)}</td><td>${t.worker?avatar(t.worker,staffColor(t.worker))+esc(t.worker):'—'}</td><td class="mono">${fmtTime(t.created)}</td><td class="mono">${fmtTime(t.finished)}</td><td>${durHours(t.created,t.finished)?durHours(t.created,t.finished)+'h':'—'}</td></tr>`).join('');
}
function initDoneFilters(){
  var catSel=$('#filter-cat-done');
  var allCats=[...new Set(state.tickets.filter(t=>t.status==='done').map(t=>t.cat))].sort();
  catSel.innerHTML='<option value="">全部类别</option>'+allCats.map(c=>`<option value="${c}">${c}</option>`).join('');
  $('#filter-type-done').onchange=function(){renderDone();};
  $('#filter-cat-done').onchange=function(){renderDone();};
}

function saveReminderInterval(){
  var sel=$('#reminder-interval');
  var minutes=parseInt(sel.value);
  fetch(API_BASE+'/api/settings/reminder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({intervalMinutes:minutes})}).then(r=>r.json()).then(d=>{
    $('#reminder-status').textContent='✓ '+d.message;
    setTimeout(()=>$('#reminder-status').textContent='',3000);
  }).catch(()=>{$('#reminder-status').textContent='保存失败';});
}
function saveSlaInterval(){
  var sel=$('#sla-interval');
  var minutes=parseInt(sel.value);
  fetch(API_BASE+'/api/settings/sla',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({intervalMinutes:minutes})}).then(r=>r.json()).then(d=>{
    $('#sla-status').textContent='✓ '+d.message;
    setTimeout(()=>$('#sla-status').textContent='',3000);
  }).catch(()=>{$('#sla-status').textContent='保存失败';});
}
function loadReminderInterval(){
  fetch(API_BASE+'/api/settings/reminder').then(r=>r.json()).then(d=>{
    var sel=$('#reminder-interval');
    if(sel)sel.value=String(d.intervalMinutes);
  }).catch(()=>{});
  fetch(API_BASE+'/api/settings/sla').then(r=>r.json()).then(d=>{
    var sel=$('#sla-interval');
    if(sel)sel.value=String(d.intervalMinutes);
  }).catch(()=>{});
  // 加载待审核注册
  loadPendingRegistrations();
  // 渲染主管概览
  renderAdminProfile();
}

function renderAdminProfile() {
  var el = $('#admin-profile-content');
  if (!el) return;
  var ts = state.tickets;
  var waitTickets = ts.filter(t => t.status === 'wait');
  var onDuty = state.staff.filter(s => (s.role === '维修工' || s.role === '物业管家') && s.status === 'on').length;
  var busyCount = state.staff.filter(s => (s.role === '维修工' || s.role === '物业管家') && s.status === 'busy').length;
  var offCount = state.staff.filter(s => (s.role === '维修工' || s.role === '物业管家') && s.status === 'off').length;
  var totalStaff = onDuty + busyCount + offCount;

  // 超时工单（超过SLA阈值的未完成工单）
  var now = Date.now();
  var overdueCount = ts.filter(t => {
    if (t.status === 'done') return false;
    var h = (now - new Date(t.created).getTime()) / 3600000;
    var sla = t.priority === 'urgent' ? 2 : t.priority === 'high' ? 8 : t.priority === 'normal' ? 24 : 48;
    return h > sla;
  }).length;

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
      <div class="elem" style="text-align:center;${waitTickets.length ? 'border-color:var(--warning)' : ''}">
        <div class="k">🔔 待派单</div>
        <div class="v" style="font-size:20px;${waitTickets.length ? 'color:var(--warning)' : ''}">${waitTickets.length}</div>
      </div>
      <div class="elem" style="text-align:center;${overdueCount ? 'border-color:var(--danger)' : ''}">
        <div class="k">⚠️ 超时工单</div>
        <div class="v" style="font-size:20px;${overdueCount ? 'color:var(--danger)' : ''}">${overdueCount}</div>
      </div>
      <div class="elem" style="text-align:center">
        <div class="k">👷 人员在线</div>
        <div class="v" style="font-size:20px"><span style="color:var(--success)">${onDuty}</span><span style="color:var(--muted);font-size:13px"> / ${totalStaff}</span></div>
      </div>
      <div class="elem" style="text-align:center">
        <div class="k">🏘️ 管理小区</div>
        <div class="v" style="font-size:20px">${state.communities.length}</div>
      </div>
    </div>
    ${waitTickets.length ? '<div style="margin-top:10px;font-size:12px;color:var(--warning)">⏰ ' + waitTickets.length + ' 张工单等待派单，请尽快处理</div>' : ''}
    ${overdueCount ? '<div style="margin-top:4px;font-size:12px;color:var(--danger)">⚠️ ' + overdueCount + ' 张工单已超出SLA时限</div>' : ''}
  `;
}

function loadPendingRegistrations() {
  var listEl = $('#pending-reg-list');
  var countEl = $('#pending-count');
  if (!listEl) return;
  fetch(API_BASE + '/api/pending-registrations', { headers: authHeaders() }).then(function(r) { return r.json(); }).then(function(json) {
    var data = json.data || [];
    if (countEl) countEl.textContent = data.length ? '(' + data.length + '条待审核)' : '';
    if (!data.length) {
      listEl.innerHTML = '<span style="color:var(--muted)">暂无待审核申请</span>';
      return;
    }
    listEl.innerHTML = data.map(function(r) {
      var roleLabel = r.role === 'worker' ? '维修工' : r.role === 'keeper' ? '物业管家' : r.role;
      var community = state.communities.find(function(c) { return c.id === r.community_id; });
      var cName = community ? community.name : r.community_id;
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border);flex-wrap:wrap">' +
        '<b>' + esc(r.name) + '</b>' +
        '<span class="tag cat">' + esc(roleLabel) + '</span>' +
        '<span style="color:var(--text-2);font-size:12px">' + esc(r.phone) + '</span>' +
        '<span style="color:var(--text-3);font-size:11px">技能: ' + esc(r.skill || '—') + '</span>' +
        '<span style="color:var(--primary);font-size:11px">→ ' + esc(cName) + '</span>' +
        '<span style="color:var(--muted);font-size:11px">' + esc(r.created ? r.created.slice(0, 16).replace('T', ' ') : '') + '</span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn sm green" onclick="approveRegistration(' + r.id + ')">通过</button>' +
        '<button class="btn sm danger" onclick="rejectRegistration(' + r.id + ')">拒绝</button>' +
        '</div>';
    }).join('');
  }).catch(function() {
    listEl.innerHTML = '<span style="color:var(--muted)">加载失败</span>';
  });
}

function approveRegistration(id) {
  fetch(API_BASE + '/api/pending-registrations/' + id + '/approve', { method: 'POST', headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.success) {
        toast('已通过：' + (d.user ? d.user.name : ''));
        // 添加到本地 staff 列表
        if (d.user) {
          var role = d.user.role === 'worker' ? '维修工' : '物业管家';
          state.staff.push({ id: 's' + Date.now(), name: d.user.name, role: role, skill: '', phone: d.user.phone, status: 'on', done: 0 });
          save();
          renderStaff();
        }
        loadPendingRegistrations();
      } else {
        toast(d.error || '操作失败');
      }
    }).catch(function() { toast('网络错误'); });
}

function rejectRegistration(id) {
  if (!confirm('确定拒绝该注册申请？')) return;
  fetch(API_BASE + '/api/pending-registrations/' + id + '/reject', { method: 'POST', headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.success) { toast('已拒绝'); loadPendingRegistrations(); }
      else toast(d.error || '操作失败');
    }).catch(function() { toast('网络错误'); });
}

function showReport(){
  navTo('management');
  if (window.ManagementWorkspace) window.ManagementWorkspace.activate('reports');
}

window.onload=async function(){
  // 禁用导航直到渲染完成
  var nav = document.querySelector('.nav');
  if (nav) { nav.style.pointerEvents = 'none'; nav.style.opacity = '0.5'; }
  await load();enhanceState();setupEnhancedUI();initCommunitySelect();initNav();initRole();['repair','complaint','help'].forEach(initFilters);initDoneFilters();loadReminderInterval();renderAll();renderDashboard();applyRoleView();$('#drawerClose').onclick=closeDrawer;$('#drawerMask').onclick=closeDrawer;startAutoSync();checkLogin();
  // 渲染完毕，启用导航
  if (nav) { nav.style.pointerEvents = ''; nav.style.opacity = ''; }
};

function startAutoSync(){setInterval(async function(){try{var resp=await fetch(API_BASE+'/api/tickets?community_id='+encodeURIComponent(currentCommunity));var json=await resp.json();if(json.data&&json.data.length){state.tickets=json.data.filter(t=>t.id&&t.type);state.tickets.forEach(t=>{t.priority=t.priority||inferPriority(t);t.rejectHistory=t.rejectHistory||[];t.steps=t.steps||[];t.photos=t.photos||[];t.aggregated=t.aggregated||[];});saveLocal();renderAll();if($('#page-dashboard').classList.contains('active'))renderDashboard();}}catch(e){}},10000);}

/* ============================================================
   师傅日程 · 时间轴排班与冲突检测
   按小时刻度展示，工单占位 = 创建时间 + 预估耗时
   预估耗时 = 该师傅已完成工单平均时长，无数据时按类别默认值
   ============================================================ */
var CAT_DEFAULT_HOURS = { '水暖':2.5, '电路':2, '电器':2, '门窗':1.5, '公共设施':3, '物业服务':1, '生活帮助':1, '咨询建议':0.5, '邻里协调':1, '其他':1.5 };

function workerAvgHours(name) {
  var done = state.tickets.filter(t => t.worker === name && t.status === 'done' && t.finished);
  if (!done.length) return null;
  var sum = done.reduce((a, t) => a + (durHours(t.created, t.finished) || 0), 0);
  return sum / done.length;
}

function estimateDuration(t) {
  // 优先用派单时手动设定的预计时间
  if (t.estimatedHours) return t.estimatedHours;
  // 其次用该师傅的平均时长，上限 8h
  var avg = workerAvgHours(t.worker);
  if (avg != null) return Math.min(8, Math.max(0.5, avg));
  return CAT_DEFAULT_HOURS[t.cat] || 2;
}

function initSchedule() {
  var sel = $('#schedule-worker');
  var isLead = currentRole === 'eng_lead';
  if (isLead) {
    // 主管可以查看所有人
    sel.innerHTML = '<option value="">全部人员</option>' + state.staff.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
    sel.disabled = false;
    sel.style.display = '';
  } else {
    // 非主管只能看自己
    var myName = roleWorkerName() || currentRole.replace('pm_keeper_', '');
    sel.innerHTML = `<option value="${esc(myName)}">我的</option>`;
    sel.value = myName;
    sel.disabled = true;
  }
  sel.onchange = renderSchedule;
  var dateInput = $('#schedule-date');
  dateInput.value = new Date().toISOString().slice(0,10);
  dateInput.onchange = renderSchedule;
}

function renderSchedule() {
  var worker = $('#schedule-worker').value;
  var dateStr = $('#schedule-date').value;
  var day = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  day.setHours(0,0,0,0);

  // 日程需要跨小区展示，异步加载所有工单
  var url = API_BASE + '/api/tickets'; // 不带 community_id，获取全部
  if (worker) url += '?worker=' + encodeURIComponent(worker);
  fetch(url).then(function(r) { return r.json(); }).then(function(json) {
    var allTickets = (json.data || []).filter(function(t) { return t.id && t.type; });
    renderScheduleWithTickets(allTickets, worker, day);
  }).catch(function() {
    // 回退：使用当前小区数据
    renderScheduleWithTickets(state.tickets, worker, day);
  });
}

function renderScheduleWithTickets(allTickets, worker, day) {
  var dayEnd = new Date(day); dayEnd.setHours(23,59,59,999);
  var tickets = allTickets.filter(t => {
    if (!t.worker) return false;
    if (worker && t.worker !== worker) return false;
    var cr = new Date(t.created);
    if (sameDay(cr, day)) return true;
    if (t.status === 'doing' || t.status === 'confirm') {
      if (cr < dayEnd) return true;
    }
    return false;
  });

  var people = worker ? [worker] : [...new Set(tickets.map(t => t.worker))];
  if (!people.length) people = state.staff.filter(s => s.role === '维修工' || s.role === '物业管家').map(s => s.name);

  var blocks = tickets.map(t => {
    var start = new Date(t.created);
    var hrs = estimateDuration(t);
    var end;
    if (t.status === 'done' && t.finished) {
      // 已完成：用实际完成时间
      end = new Date(t.finished);
      hrs = (end - start) / 3600000;
    } else if (t.status === 'doing' || t.status === 'confirm') {
      // 处理中/待确认：实时拉长到当前时间（如果已超预估时长）
      var estimated = new Date(start.getTime() + hrs * 3600000);
      var now = new Date();
      if (now > estimated) { end = now; hrs = (now - start) / 3600000; }
      else { end = estimated; }
    } else {
      end = new Date(start.getTime() + hrs * 3600000);
    }
    return { ticket: t, start, end, hours: hrs, worker: t.worker };
  });

  var grid = $('#schedule-grid');
  var HOUR_START = 0, HOUR_END = 24;
  grid.innerHTML = renderTimelineDay(people, blocks, day, HOUR_START, HOUR_END) || '<span style="color:#aaa">当天暂无已指派工单</span>';

  var conflicts = detectTimeConflicts(blocks);
  var conflictEl = $('#schedule-conflicts');
  if (conflicts.length) {
    conflictEl.innerHTML = conflicts.map(c => `<div class="conflict-alert">⚠️ <b>${esc(c.worker)}</b>：${esc(c.t1.ticket.id)}（${fmtHM(c.t1.start)}~${fmtHM(c.t1.end)}）与 ${esc(c.t2.ticket.id)}（${fmtHM(c.t2.start)}~${fmtHM(c.t2.end)}）时段重叠 ${c.overlap.toFixed(1)}h</div>`).join('');
  } else {
    conflictEl.innerHTML = '<span style="color:#389e0d">✓ 当天无时段重叠冲突</span>';
  }

  $('#schedule-summary').textContent = `${formatDayLabel(day)} · 共 ${tickets.length} 条工单 · ${people.length} 名人员`;
}

function renderTimelineDay(people, blocks, day, hStart, hEnd) {
  var totalH = hEnd - hStart;

  // 竖版布局：X轴=师傅列，Y轴=时间从上到下
  // 左侧时间刻度列
  var timeLabels = '';
  for (var h = hStart; h < hEnd; h++) {
    var pct = ((h - hStart) / totalH * 100).toFixed(2);
    timeLabels += `<div class="vtl-hour" style="top:${pct}%">${h}:00</div>`;
  }

  // 每位师傅一列
  var columns = people.map(p => {
    var pBlocks = blocks.filter(b => b.worker === p);
    // 计算显示范围
    pBlocks.forEach(b => {
      b._displayStart = sameDay(b.start, day) ? b.start : new Date(day.getFullYear(), day.getMonth(), day.getDate(), hStart, 0);
      b._displayEnd = b.end > new Date(day.getFullYear(), day.getMonth(), day.getDate(), hEnd, 0) ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), hEnd, 0) : b.end;
    });
    // 计算lanes（冲突时左右错开）
    var lanes = [];
    pBlocks.forEach(b => {
      var lane = 0;
      for (var l = 0; l < lanes.length; l++) {
        if (lanes[l] <= b._displayStart.getTime()) { lane = l; break; }
        lane = l + 1;
      }
      lanes[lane] = b._displayEnd.getTime();
      b._lane = lane;
    });
    var maxLanes = Math.max(1, lanes.length);

    var items = pBlocks.map(b => {
      var startH = b._displayStart.getHours() + b._displayStart.getMinutes() / 60;
      var durH = (b._displayEnd - b._displayStart) / 3600000;
      var top = Math.max(0, ((startH - hStart) / totalH) * 100);
      var height = Math.min(100 - top, (durH / totalH) * 100);
      var laneWidth = 100 / maxLanes;
      var left = b._lane * laneWidth;
      var isConflict = pBlocks.some(o => o !== b && o.start < b.end && o.end > b.start);
      return `<div class="vtl-block ${b.ticket.priority||'normal'}${isConflict?' conflict':''}" style="top:${top.toFixed(2)}%;height:${Math.max(1.5,height).toFixed(2)}%;left:${left.toFixed(1)}%;width:${laneWidth.toFixed(1)}%" onclick="openDrawer('${b.ticket.id}')" title="${esc(b.ticket.id)} ${esc(b.ticket.cat)}\n${fmtHM(b.start)}~${fmtHM(b.end)} (${b.hours.toFixed(1)}h)\n${esc(b.ticket.loc)}${sameDay(b.start,day)?'':'\n⚠️ 跨天工单'}"><span class="vtl-block-text">${esc(b.ticket.id)}<br>${esc(b.ticket.cat)}<br><small>${fmtHM(b._displayStart)}~${fmtHM(b._displayEnd)}</small></span></div>`;
    }).join('');

    var avgH = workerAvgHours(p);
    var staffObj = state.staff.find(function(s) { return s.name === p; });
    var dutyLabel = staffObj ? '🕐 值班 ' + (staffObj.dutyStart || '08:00') + ' ~ ' + (staffObj.dutyEnd || '18:00') : '';
    // 生成非值班时段灰色块
    var offDutyHtml = '';
    if (staffObj) {
      var ds = parseHM(staffObj.dutyStart || '08:00');
      var de = parseHM(staffObj.dutyEnd || '18:00');
      var dsH = ds / 60, deH = de / 60;
      if (ds <= de) {
        // 正常班次：0~start 和 end~24 为休息
        if (dsH > hStart) {
          var topPct = 0;
          var hPct = ((dsH - hStart) / totalH * 100).toFixed(2);
          offDutyHtml += `<div class="vtl-offduty" style="top:${topPct}%;height:${hPct}%"></div>`;
        }
        if (deH < hEnd) {
          var topPct2 = ((deH - hStart) / totalH * 100).toFixed(2);
          var hPct2 = ((hEnd - deH) / totalH * 100).toFixed(2);
          offDutyHtml += `<div class="vtl-offduty" style="top:${topPct2}%;height:${hPct2}%"></div>`;
        }
      } else {
        // 跨午夜班次（如22:00~06:00）：end~start 为休息
        if (deH > hStart && dsH < hEnd) {
          var topPct3 = ((deH - hStart) / totalH * 100).toFixed(2);
          var hPct3 = ((dsH - deH) / totalH * 100).toFixed(2);
          offDutyHtml += `<div class="vtl-offduty" style="top:${topPct3}%;height:${hPct3}%"></div>`;
        }
      }
    }
    return `<div class="vtl-col"><div class="vtl-col-head"><b>${esc(p)}</b><br><span style="color:var(--primary);font-size:11px;font-weight:500">${dutyLabel}</span></div><div class="vtl-col-track">${offDutyHtml}${items}</div></div>`;
  }).join('');

  return `<div class="vtl-chart"><div class="vtl-time-col"><div class="vtl-col-head-placeholder"></div><div class="vtl-time-labels">${timeLabels}</div></div>${columns}</div>`;
}

function detectTimeConflicts(blocks) {
  var results = [];
  var byWorker = {};
  blocks.forEach(b => { if (!byWorker[b.worker]) byWorker[b.worker] = []; byWorker[b.worker].push(b); });
  Object.entries(byWorker).forEach(([w, list]) => {
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = list[i], b2 = list[j];
        if (a.start < b2.end && a.end > b2.start) {
          var overlapStart = Math.max(a.start.getTime(), b2.start.getTime());
          var overlapEnd = Math.min(a.end.getTime(), b2.end.getTime());
          results.push({ worker: w, t1: a, t2: b2, overlap: (overlapEnd - overlapStart) / 3600000 });
        }
      }
    }
  });
  return results;
}

function countDayConflicts(dayBlocks) {
  var count = 0;
  var byW = {};
  dayBlocks.forEach(b => { if (!byW[b.worker]) byW[b.worker] = []; byW[b.worker].push(b); });
  Object.values(byW).forEach(list => { for (var i = 0; i < list.length; i++) for (var j = i+1; j < list.length; j++) if (list[i].start < list[j].end && list[i].end > list[j].start) count++; });
  return count;
}

function sameDay(d1, d2) { return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate(); }
function fmtHM(d) { return d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0'); }
function formatDayLabel(d) { var w = ['周日','周一','周二','周三','周四','周五','周六']; return (d.getMonth()+1)+'/'+d.getDate()+' '+w[d.getDay()]; }


/* ============================================================
   登录系统
   ============================================================ */
function doLogin(){
  var phone=$('#login-phone').value.trim();
  var pwd=$('#login-password').value;
  if(!phone||!pwd){$('#login-error').textContent='请填写手机号和密码';return;}
  if(window._jigsawPassed===false){$('#login-error').textContent='请先完成滑动验证';return;}
  fetch(API_BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:phone,password:pwd,rememberMe:!!$('#login-remember').checked})}).then(r=>r.json()).then(d=>{
    if(d.success){
      localStorage.setItem('login_user',JSON.stringify(d.user));
      if(d.token) API.setToken(d.token);
      enterApp(d.user);
    } else {
      $('#login-error').textContent=d.error||'登录失败';
    }
  }).catch(()=>{$('#login-error').textContent='网络错误';});
}

function showRegisterForm() {
  $('#login-form').style.display = 'none';
  $('#reset-form').style.display = 'none';
  $('#register-form').style.display = '';
  $('#reg-error').textContent = '';
  $('#reg-success').textContent = '';
}
function showLoginForm() {
  $('#register-form').style.display = 'none';
  $('#reset-form').style.display = 'none';
  $('#login-form').style.display = '';
}
function showResetForm() {
  $('#login-form').style.display = 'none';
  $('#register-form').style.display = 'none';
  $('#reset-form').style.display = '';
  $('#reset-error').textContent = '';
  $('#reset-success').textContent = '';
}

function doResetPassword() {
  var phone = $('#reset-phone').value.trim();
  var pwd = $('#reset-password').value;
  var pwd2 = $('#reset-password2').value;
  $('#reset-error').textContent = '';
  $('#reset-success').textContent = '';
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) { $('#reset-error').textContent = '请输入正确的11位手机号'; return; }
  if (!pwd || pwd.length < 4) { $('#reset-error').textContent = '新密码至少4位'; return; }
  if (pwd !== pwd2) { $('#reset-error').textContent = '两次输入密码不一致'; return; }
  fetch(API_BASE + '/api/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone, newPassword: pwd })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.success) {
      $('#reset-success').textContent = '✓ 密码已重置，请返回登录';
      $('#reset-error').textContent = '';
    } else {
      $('#reset-error').textContent = d.error || '重置失败';
    }
  }).catch(function() { $('#reset-error').textContent = '网络错误'; });
}

function doRegister() {
  var inviteCode = $('#reg-invite').value.trim();
  var name = $('#reg-name').value.trim();
  var phone = $('#reg-phone').value.trim();
  var password = $('#reg-password').value;
  var role = $('#reg-role').value;
  var skill = $('#reg-skill').value.trim();
  $('#reg-error').textContent = '';
  $('#reg-success').textContent = '';
  if (!inviteCode) { $('#reg-error').textContent = '请输入邀请码'; return; }
  if (!name) { $('#reg-error').textContent = '请输入姓名'; return; }
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) { $('#reg-error').textContent = '请输入正确的11位手机号'; return; }
  if (!password || password.length < 4) { $('#reg-error').textContent = '密码至少4位'; return; }
  fetch(API_BASE + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone, password: password, name: name, role: role, skill: skill, inviteCode: inviteCode })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.success) {
      $('#reg-success').textContent = '✓ ' + d.message;
      $('#reg-error').textContent = '';
    } else {
      $('#reg-error').textContent = d.error || '注册失败';
    }
  }).catch(function() { $('#reg-error').textContent = '网络错误'; });
}
function enterApp(user){
  $('#login-page').style.display='none';
  $('#app-main').style.display='block';
  if(['admin','lead','manager','supervisor','主管','经理'].indexOf(user.role) >= 0){
    currentRole='eng_lead';
  } else if(user.role==='worker'){
    currentRole='worker_'+user.name;
  } else if(user.role==='keeper'){
    currentRole='pm_keeper_'+user.name;
  }
  localStorage.setItem('juzi_oa_role_v1',currentRole);
  var sel=$('#roleSelect');
  if(sel){
    sel.value=currentRole;
    sel.disabled=true;
    sel.style.display='none';
  }
  // 显示当前用户名
  var roleLabel=document.querySelector('.role-switch label');
  if(roleLabel){roleLabel.style.display='inline';roleLabel.textContent=user.name+' · '+(['admin','lead','manager','supervisor','主管','经理'].indexOf(user.role) >= 0 ? '主管' : user.role==='worker'?'维修工':'管家');}
  // 重新加载数据（小区列表 + 工单），然后渲染
  (async function(){
    await reloadCommunities();
    await reloadTickets();
    enhanceState();
    applyRoleView();
    // 图表在display:none时初始化尺寸不对，显示后强制resize
    setTimeout(function(){ Object.values(charts).forEach(function(c){c.resize();}); renderDashboard(); }, 300);
  })();
}
function checkLogin(){
  var saved=localStorage.getItem('login_user');
  if(saved){
    try{enterApp(JSON.parse(saved));}catch(e){showLoginPage();}
  } else {
    showLoginPage();
  }
}
function showLoginPage(){
  $('#app-main').style.display='none';
  $('#login-page').style.display='flex';
  window._jigsawPassed=false;
  // 初始化滑动验证码（本地 canvas，无网络请求）
  var container=$('#jigsaw-container');
  if(container&&typeof LocalCaptcha!=='undefined'){
    container.innerHTML='';
    LocalCaptcha.init({
      el:container,
      onSuccess:function(){
        window._jigsawPassed=true;
        $('#login-btn').disabled=false;
        $('#login-btn').style.opacity='1';
      },
      onFail:function(){
        window._jigsawPassed=false;
      }
    });
    $('#login-btn').disabled=true;
    $('#login-btn').style.opacity='0.5';
  } else {
    // 验证码加载失败，允许直接登录
    window._jigsawPassed=true;
  }
}
function doLogout(){
  localStorage.removeItem('login_user');
  localStorage.removeItem('auth_token');
  // 销毁所有图表实例，避免切换用户后尺寸异常
  Object.keys(charts).forEach(function(k) {
    try { charts[k].dispose(); } catch(e) {}
  });
  charts = {};
  showLoginPage();
  $('#login-phone').value='';$('#login-password').value='';$('#login-error').textContent='';
}
