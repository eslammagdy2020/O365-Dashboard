import { chmodSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { getCurrentWindowsUser, loadConfig } from './env.js';

export type DataPaths = {
  dataDir: string;
  database: string;
  tokenCache: string;
  logs: string;
};

export function resolveDataPaths(dataDir = loadConfig().DATA_DIR): DataPaths {
  const root = resolve(dataDir);
  return {
    dataDir: root,
    database: join(root, 'data.sqlite'),
    tokenCache: join(root, 'token-cache.bin'),
    logs: join(root, 'logs'),
  };
}

export function ensureDataDirectory(paths = resolveDataPaths()): void {
  mkdirSync(paths.dataDir, { recursive: true });

  if (process.platform === 'win32') {
    const user = getCurrentWindowsUser();
    execFileSync(
      'icacls.exe',
      [
        paths.dataDir,
        '/inheritance:r',
        '/grant:r',
        `${user}:(OI)(CI)F`,
        'SYSTEM:(OI)(CI)F',
      ],
      { stdio: 'pipe' },
    );
  } else {
    chmodSync(paths.dataDir, 0o700);
  }

  mkdirSync(dirname(paths.logs), { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
}
