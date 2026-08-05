/**
 * 物业工单系统 — 入口文件（重构版）
 */
const config = require('./config');
const { initDB, flushPersistence } = require('./db');
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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，等待远程数据库同步完成`);
  try { await Promise.race([flushPersistence(), new Promise(resolve => setTimeout(resolve, 5000))]); }
  finally { process.exit(0); }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});