import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessageListController } from '../src/controllers/messageController.js';
import { generate50kMessages } from './fixtures/generate-50k.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function measureQuery(database: Database.Database, query: Record<string, string>): number {
  const controller = createMessageListController(database);
  const response = { json: () => undefined, status: () => response };
  const start = performance.now();
  controller({ query } as never, response as never);
  return performance.now() - start;
}

describe('50k mailbox read performance', () => {
  it('reports p95 for received-date pages and FTS search below 200 ms', () => {
    const database = new Database(':memory:');
    databases.push(database);
    generate50kMessages(database);
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
      count: 50_000,
    });
    expect(
      database.prepare('SELECT COUNT(DISTINCT from_address) AS count FROM messages').get(),
    ).toEqual({ count: 5_000 });
    expect(
      database
        .prepare(
          'SELECT MIN(length(body_preview)) AS min, MAX(length(body_preview)) AS max FROM messages',
        )
        .get(),
    ).toEqual({ min: 255, max: 255 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE folder_id = 'synthetic-inbox'")
        .get(),
    ).toEqual({ count: 30_000 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE folder_id = 'synthetic-sent'")
        .get(),
    ).toEqual({ count: 15_000 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE folder_id = 'synthetic-other'")
        .get(),
    ).toEqual({ count: 5_000 });

    const dateQuery = {
      view: 'inbox',
      offset: '0',
      limit: '100',
      sort: 'receivedAt',
      order: 'desc',
    };
    const searchQuery = { ...dateQuery, q: 'mailsearch' };
    for (let index = 0; index < 5; index += 1) {
      measureQuery(database, dateQuery);
      measureQuery(database, searchQuery);
    }
    const dateSamples = Array.from({ length: 40 }, () => measureQuery(database, dateQuery));
    const searchSamples = Array.from({ length: 40 }, () => measureQuery(database, searchQuery));
    const dateP95 = percentile95(dateSamples);
    const searchP95 = percentile95(searchSamples);

    console.info(
      `50k SQLite query p95 (ms): received-date page=${dateP95.toFixed(2)}, FTS search=${searchP95.toFixed(2)}`,
    );
    expect(dateP95).toBeLessThan(200);
    expect(searchP95).toBeLessThan(200);
  }, 120_000);
});
