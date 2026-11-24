import {
  FilePersistenceWithDataProtection,
  DataProtectionScope,
  type IPersistence,
} from '@azure/msal-node-extensions';
import type {
  AccountInfo,
  ICachePlugin,
  PublicClientApplication,
  TokenCacheContext,
} from '@azure/msal-node';
import { resolveDataPaths } from '../config/paths.js';

export async function createTokenCachePlugin(
  tokenCachePath = resolveDataPaths().tokenCache,
  suppliedPersistence?: IPersistence,
): Promise<ICachePlugin> {
  if (!suppliedPersistence && process.platform !== 'win32') {
    throw new Error('The protected token cache is supported only on Windows');
  }

  const persistence =
    suppliedPersistence ??
    (await FilePersistenceWithDataProtection.create(tokenCachePath, DataProtectionScope.CurrentUser));
  let queued = Promise.resolve();
  const releaseAccess = new WeakMap<TokenCacheContext, () => void>();

  const acquire = async (): Promise<() => void> => {
    const previous = queued;
    let release!: () => void;
    queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };

  const beforeCacheAccess = async (context: TokenCacheContext): Promise<void> => {
    const release = await acquire();
    try {
      const contents = await persistence.load();
      if (contents) context.tokenCache.deserialize(contents);
      releaseAccess.set(context, release);
    } catch (error) {
      release();
      throw error;
    }
  };

  const afterCacheAccess = async (context: TokenCacheContext): Promise<void> => {
    try {
      if (context.cacheHasChanged) {
        await persistence.save(context.tokenCache.serialize());
      }
    } finally {
      releaseAccess.get(context)?.();
      releaseAccess.delete(context);
    }
  };

  return { beforeCacheAccess, afterCacheAccess };
}

export async function acquireGraphToken(
  client: PublicClientApplication,
  homeAccountId: string,
  claims?: string,
): Promise<string> {
  const account = await client.getTokenCache().getAccountByHomeId(homeAccountId);
  if (!account) throw new Error('interaction_required');

  const result = await client.acquireTokenSilent({
    account,
    scopes: ['User.Read', 'Mail.Read'],
    ...(claims ? { claims } : {}),
  });
  return result.accessToken;
}

export async function removeCachedAccount(
  client: PublicClientApplication,
  account: AccountInfo | null,
): Promise<void> {
  if (account) await client.getTokenCache().removeAccount(account);
}
