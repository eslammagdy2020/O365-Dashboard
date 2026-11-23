import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import type { MsalClientProvider } from '../src/auth/requireAuth.js';

const databases: Database.Database[] = [];
const staticDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of staticDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('static frontend serving', () => {
  it('serves the app, SPA routes, and assets without treating unknown API routes as pages', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'o365-static-'));
    staticDirectories.push(staticDir);
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>O365 test app</title>');
    writeFileSync(join(staticDir, 'app.js'), 'window.testApp = true;');

    const database = new Database(':memory:');
    databases.push(database);
    database.exec(
      readFileSync(
        fileURLToPath(new URL('../src/db/migrations/001_init.sql', import.meta.url)),
        'utf8',
      ),
    );
    const config = loadConfig({
      SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      LOCALAPPDATA: 'C:\\test-data',
      DATA_DIR: 'C:\\test-data',
      CLIENT_ID: 'mock-client-id',
      TENANT_ID: 'mock-tenant-id',
      FRONTEND_URL: 'http://localhost:5173',
      REDIRECT_URI: 'http://localhost:5000/auth/callback',
    });
    const clientProvider = (async () => ({})) as MsalClientProvider;
    const app = createApp(config, database, clientProvider, staticDir);
    const html = '<!doctype html><title>O365 test app</title>';

    await request(app).get('/').set('Accept', 'text/html').expect(200, html);
    await request(app).get('/mail/something').set('Accept', 'text/html').expect(200, html);
    await request(app)
      .get('/app.js')
      .expect(200, 'window.testApp = true;');
    const unknownApi = await request(app).get('/api/does-not-exist').set('Accept', 'text/html');
    expect(unknownApi.text).not.toBe(html);
  });
});
