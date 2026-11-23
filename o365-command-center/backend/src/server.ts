import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { resolveDataPaths } from './config/paths.js';
import { openDatabase } from './db/db.js';

const config = loadConfig();
const database = openDatabase(resolveDataPaths(config.DATA_DIR));
const app = createApp(config, database);

app.locals.initialise();

const server = app.listen(config.PORT, '127.0.0.1', () => {
  console.info(`O365 Command Center backend listening on http://127.0.0.1:${config.PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await app.locals.shutdown();
      process.exit(0);
    });
  });
}
