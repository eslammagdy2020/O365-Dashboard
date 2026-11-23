import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z.object({
  TENANT_ID: z.string().optional(),
  CLIENT_ID: z.string().optional(),
  REDIRECT_URI: z.string().url().default('http://localhost:5000/auth/callback'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  AI_ENABLED: booleanFromEnv,
});

export type AppConfig = z.infer<typeof environmentSchema> & { DATA_DIR: string };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(source);
  const requestedDataDir = parsed.DATA_DIR?.trim();
  const dataDir = requestedDataDir || defaultDataDirectory(source);

  return { ...parsed, DATA_DIR: dataDir };
}

function defaultDataDirectory(source: NodeJS.ProcessEnv): string {
  const localAppData = source.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('LOCALAPPDATA must be set when DATA_DIR is not configured');
  }

  return `${localAppData.replace(/[\\/]+$/, '')}\\o365-command-center`;
}

export function getCurrentWindowsUser(): string {
  return execFileSync('whoami.exe', [], { encoding: 'utf8' }).trim();
}
