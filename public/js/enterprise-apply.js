(function (global) {
  'use strict';

  var submitting = new WeakSet();

  function setStatus(element, message, kind) {
    if (!element) return;
    element.textContent = message;
    element.className = 'platform-form-status ' + (kind || '');
  }

  function publicError(response) {
    if (response && response.status === 409) return '该企业或手机号已提交申请，请勿重复申请。';
    if (response && response.status === 429) return '提交过于频繁，请稍后再试。';
    return '申请提交失败，请稍后重试。';
  }

  async function submitApplication(form, status, button) {
    if (!form || !button || submitting.has(button)) return;
    var values = form.elements;
    var enterpriseName = String(values.enterpriseName.value || '').trim();
    var supervisorName = String(values.supervisorName.value || '').trim();
    var phone = String(values.phone.value || '').trim();
    var password = String(values.password.value || '');
    var confirm = String(values.confirm.value || '');

    if (!enterpriseName || !supervisorName || !phone || !password || !confirm) {
      setStatus(status, '请完整填写所有申请信息。', 'is-error');
      return;
    }
    if (password !== confirm) {
      setStatus(status, '两次输入的密码不一致。', 'is-error');
      return;
    }

    submitting.add(button);
    button.disabled = true;
    setStatus(status, '正在提交申请…', '');
    try {
      var response = await fetch('/api/enterprise-applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enterpriseName: enterpriseName, supervisorName: supervisorName, phone: phone, password: password }),
      });
      if (!response.ok) throw new Error(publicError(response));
      form.reset();
      setStatus(status, '申请已提交，当前为待审核状态。审核结果将由平台通知。', 'is-success');
    } catch (error) {
      var message = error && /^申请|^该企业|^提交过于/.test(error.message) ? error.message : '网络异常，请稍后重试。';
      setStatus(status, message, 'is-error');
    } finally {
      submitting.delete(button);
      button.disabled = false;
    }
  }

  function init() {
    var form = document.getElementById('enterprise-apply-form');
    var status = document.getElementById('enterprise-apply-status');
    var button = document.getElementById('enterprise-apply-submit');
    if (!form || !button) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitApplication(form, status, button);
    });
  }

  global.EnterpriseApply = { submitApplication: submitApplication };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
