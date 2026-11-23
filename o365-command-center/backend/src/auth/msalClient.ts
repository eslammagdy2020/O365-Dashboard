import { PublicClientApplication, CryptoProvider } from '@azure/msal-node';
import type { Configuration } from '@azure/msal-node';
import type { AppConfig } from '../config/env.js';
import { resolveDataPaths } from '../config/paths.js';
import { createTokenCachePlugin } from './tokenCache.js';

export const delegatedScopes = ['User.Read', 'Mail.ReadWrite'];
export const cryptoProvider = new CryptoProvider();

export async function createMsalClient(config: AppConfig): Promise<PublicClientApplication> {
  if (!config.CLIENT_ID || !config.TENANT_ID) {
    throw new Error('CLIENT_ID and TENANT_ID are required for sign-in');
  }

  const cachePlugin = await createTokenCachePlugin(resolveDataPaths(config.DATA_DIR).tokenCache);
  const msalConfig: Configuration = {
    auth: {
      clientId: config.CLIENT_ID,
      authority: `https://login.microsoftonline.com/${encodeURIComponent(config.TENANT_ID)}`,
    },
    cache: { cachePlugin },
  };
  return new PublicClientApplication(msalConfig);
}
