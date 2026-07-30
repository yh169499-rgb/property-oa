const { createServerApp } = require('../../server-app');

async function startHttpServer(testDb) {
  const restoreDB = testDb
    ? require('../../db').setDBForTests(testDb)
    : () => {};
  const app = createServerApp();
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
      listeningServer.once('error', reject);
    });
  } catch (error) {
    restoreDB();
    throw error;
  }
  const { port } = server.address();
  let closed = false;

  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } finally {
        restoreDB();
      }
    },
  };
}

module.exports = { startHttpServer };
