import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import type { IPersistence } from '@azure/msal-node-extensions';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenCachePlugin } from '../src/auth/tokenCache.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('token cache persistence', () => {
  it('serializes concurrent cache access without creating a lockfile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'o365-token-cache-'));
    temporaryDirectories.push(directory);
    const cachePath = join(directory, 'token-cache.bin');
    const lockPath = `${cachePath}.lockfile`;
    let activePersistenceCalls = 0;
    let overlappingPersistenceCalls = false;
    let lockfileObservedDuringAccess = false;
    const withTrackedAccess = async (operation: () => Promise<unknown>): Promise<unknown> => {
      activePersistenceCalls += 1;
      if (activePersistenceCalls > 1) overlappingPersistenceCalls = true;
      if (existsSync(lockPath)) lockfileObservedDuringAccess = true;
      try {
        await Promise.resolve();
        return await operation();
      } finally {
        activePersistenceCalls -= 1;
      }
    };
    const persistence: IPersistence = {
      load: async () =>
        (await withTrackedAccess(async () => 'serialized-cache')) as string | null,
      save: async () => {
        await withTrackedAccess(async () => undefined);
      },
      delete: async () => false,
      reloadNecessary: async () => true,
      getFilePath: () => cachePath,
      getLogger: () => {
        throw new Error('Logger is not used by the cache plugin');
      },
      verifyPersistence: async () => true,
      createForPersistenceValidation: async () => persistence,
    };
    const plugin: ICachePlugin = await createTokenCachePlugin(cachePath, persistence);
    const createContext = (): TokenCacheContext =>
      ({
        cacheHasChanged: true,
        tokenCache: {
          deserialize: () => undefined,
          serialize: () => 'serialized-cache',
        },
      }) as TokenCacheContext;
    const access = async (): Promise<void> => {
      const context = createContext();
      await plugin.beforeCacheAccess(context);
      await plugin.afterCacheAccess(context);
    };

    await Promise.all([access(), access(), access()]);

    expect(overlappingPersistenceCalls).toBe(false);
    expect(lockfileObservedDuringAccess).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });
});
