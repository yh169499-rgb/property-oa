const test = require('node:test');
const assert = require('node:assert/strict');

const StaffReport = require('../public/js/staff-report');

const report = {
  staff: { id: 3, name: '张师傅', position: '维修师傅' },
  received: { total: 5 },
  completed: { total: 4, averageHours: 2.5, onTimeRate: 90 },
  current: { doing: 1, pending: 0, waiting: 0, returned: 0 },
  recurrence: { total: 1 },
  feedback: { multiple: 0 },
  categories: [{ category: '水暖', total: 5 }],
  performance: {
    status: 'scored', score: 88, level: 'good', sampleSize: 4,
    components: {
      completion: { score: 80, contribution: 24 },
      onTime: { score: 90, contribution: 45 },
      quality: { score: 95, contribution: 19 },
    },
    ruleVersions: [{ version: 1, sampleSize: 4 }],
  },
};

const filters = {
  from: '2026-08-01', to: '2026-08-31', community_name: '一号小区',
};

const analysis = {
  summary: '本期整体表现稳定。',
  highlights: ['按时率保持较高水平'],
  issues: ['存在一单复发问题'],
  trends: ['处理时长总体平稳'],
  risks: ['复发问题可能影响满意度'],
  recommendations: ['对水暖高频点位开展专项巡检'],
};

test('复制文本和 HTML 导出都包含完整六段式 AI 润色结果', () => {
  const text = StaffReport.reportText(report, filters, analysis);
  const html = StaffReport.reportHtml(report, filters, analysis);
  for (const expected of [
    'AI 润色报告', '本期整体表现稳定', '工作亮点', '主要问题',
    '趋势判断', '风险提醒', '后续建议', '专项巡检',
  ]) {
    assert.match(text, new RegExp(expected));
    assert.match(html, new RegExp(expected));
  }
  assert.match(html, /AI 建议，仅供管理参考/);
});

test('AI 内容经过 HTML 转义且没有分析时原报告仍可导出', () => {
  const unsafe = { ...analysis, summary: '<img src=x onerror=alert(1)>结论' };
  const html = StaffReport.reportHtml(report, filters, unsafe);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);

  const original = StaffReport.reportHtml(report, filters);
  assert.match(original, /人员工作报告/);
  assert.doesNotMatch(original, /AI 润色报告/);
});
