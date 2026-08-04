/**
 * 物业工单系统 — 入口文件（重构版）
 */
const config = require('./config');
const { initDB } = require('./db');
const { createServerApp } = require('./server-app');

// 启动
async function start() {
  await initDB();
  const app = createServerApp();
  app.listen(config.PORT, () => {
    console.log(`✅ 物业工单系统已启动: http://localhost:${config.PORT}`);
  });
}

// 全局错误处理
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获异常:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason);
});

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
