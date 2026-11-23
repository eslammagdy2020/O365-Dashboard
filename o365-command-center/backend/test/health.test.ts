import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { resolveDataPaths } from '../src/config/paths.js';
import { createApp } from '../src/app.js';

const validConfig = (overrides: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    ...overrides,
  });

describe('T1 health and configuration', () => {
  it('returns 200 from the health endpoint', async () => {
    const response = await request(createApp()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: 'ok' } });
  });

  it('rejects a missing SESSION_SECRET', () => {
    expect(() => loadConfig({ LOCALAPPDATA: 'C:\\data' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects a 31-character SESSION_SECRET', () => {
    expect(() => validConfig({ SESSION_SECRET: 'x'.repeat(31) })).toThrow(/SESSION_SECRET/);
  });

  it('moves all persisted paths together when DATA_DIR is overridden', () => {
    const paths = resolveDataPaths(validConfig({ DATA_DIR: 'E:\\private\\occ-data' }).DATA_DIR);

    expect(paths.dataDir).toBe('E:\\private\\occ-data');
    expect(paths.database).toBe('E:\\private\\occ-data\\data.sqlite');
    expect(paths.tokenCache).toBe('E:\\private\\occ-data\\token-cache.bin');
    expect(paths.logs).toBe('E:\\private\\occ-data\\logs');
  });
});
