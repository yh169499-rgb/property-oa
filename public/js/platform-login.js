(function (global) {
  'use strict';

  var submitting = new WeakSet();

  function setStatus(element, message, kind) {
    if (!element) return;
    element.textContent = message;
    element.className = 'platform-form-status ' + (kind || '');
  }

  async function login(form, status, button) {
    if (!form || !button || submitting.has(button)) return;
    var phone = String(form.elements.phone.value || '').trim();
    var password = String(form.elements.password.value || '');
    if (!phone || !password) {
      setStatus(status, '请输入手机号和密码。', 'is-error');
      return;
    }

    submitting.add(button);
    button.disabled = true;
    setStatus(status, '正在验证…', '');
    try {
      var response = await fetch('/api/platform/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, password: password }),
      });
      var result = await response.json().catch(function () { return {}; });
      var token = result.token || (result.data && result.data.token);
      if (!response.ok || !token) throw new Error('INVALID_PLATFORM_LOGIN');
      sessionStorage.setItem('platform_token', token);
      global.location.href = '/platform-admin.html';
    } catch (error) {
      var message = error && error.message === 'INVALID_PLATFORM_LOGIN'
        ? '平台账号或密码错误。'
        : '登录失败，请稍后重试。';
      setStatus(status, message, 'is-error');
    } finally {
      submitting.delete(button);
      button.disabled = false;
    }
  }

  function init() {
    if (sessionStorage.getItem('platform_token')) {
      global.location.href = '/platform-admin.html';
      return;
    }
    var form = document.getElementById('platform-login-form');
    var status = document.getElementById('platform-login-status');
    var button = document.getElementById('platform-login-submit');
    if (!form || !button) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      login(form, status, button);
    });
  }

  global.PlatformLogin = { login: login };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
