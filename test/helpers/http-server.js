const { createServerApp } = require('../../server-app');

async function startHttpServer() {
  const app = createServerApp();
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

module.exports = { startHttpServer };
