/**
 * 统一 API 请求封装（含 JWT token 管理 + 错误处理）
 */
const API = {
  base: '',
  token: localStorage.getItem('auth_token') || '',

  setToken(t) { this.token = t; localStorage.setItem('auth_token', t); },
  clearToken() { this.token = ''; localStorage.removeItem('auth_token'); },

  async request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    try {
      const resp = await fetch(this.base + path, opts);
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error || data.message || '请求失败 (' + resp.status + ')';
        if (resp.status === 401) {
          // token 过期，清除登录状态
          this.clearToken();
          localStorage.removeItem('login_user');
          toast('登录已过期，请重新登录');
          if (typeof showLoginPage === 'function') showLoginPage();
        } else {
          toast(msg);
        }
        return { ok: false, error: msg, status: resp.status };
      }
      return { ok: true, ...data };
    } catch (e) {
      toast('网络错误，请检查连接');
      return { ok: false, error: '网络错误' };
    }
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  patch(path, body) { return this.request('PATCH', path, body); },
  del(path) { return this.request('DELETE', path); },

  // 文件上传（不走 JSON）
  async upload(path, formData) {
    const opts = { method: 'POST', body: formData };
    if (this.token) opts.headers = { 'Authorization': 'Bearer ' + this.token };
    try {
      const resp = await fetch(this.base + path, opts);
      return await resp.json();
    } catch(e) {
      toast('上传失败，网络错误');
      return { success: false, error: '网络错误' };
    }
  }
};
