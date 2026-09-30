'use strict';

const http = require('http');
const { initDatabase, closeDatabase } = require('./src/db');
const schedule = require('./src/schedule');
const { route } = require('./src/http');

const PORT = Number(process.env.PORT || 3000);

async function main() {
  await initDatabase();
  // Pre-generate absolute intervals in each store's time zone. The query path
  // compares live and pre-generated windows and repairs a drift before serving.
  await schedule.ensureSchedules(Date.now());
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
    });
  });
  server.listen(PORT, () => {
    console.log(`书屿志 Bookbar Atlas: http://localhost:${PORT}`);
    console.log(`SQLite database: ${require('./src/db').DB_PATH}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
