import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { PublicClientApplication } from '@azure/msal-node';
import type { AppConfig } from '../config/env.js';
import { cryptoProvider, delegatedScopes } from './msalClient.js';
import type { MsalClientProvider } from './requireAuth.js';
import { acquireGraphToken, removeCachedAccount } from './tokenCache.js';

type AuthClient = Pick<
  PublicClientApplication,
  'getAuthCodeUrl' | 'acquireTokenByCode' | 'getTokenCache' | 'acquireTokenSilent'
>;

declare module 'express-session' {
  interface SessionData {
    homeAccountId?: string;
    authState?: string;
    pkceVerifier?: string;
    pkceChallenge?: string;
    authClaims?: string;
  }
}

export function createAuthRoutes(
  config: AppConfig,
  database: Database,
  getClient: MsalClientProvider,
  startScheduler?: (homeAccountId: string) => void,
): Router {
  const router = Router();

  router.get('/login', async (request, response): Promise<void> => {
    try {
      const client = (await getClient()) as AuthClient;
      const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
      const state = cryptoProvider.createNewGuid();
      request.session.authState = state;
      request.session.pkceVerifier = verifier;
      request.session.pkceChallenge = challenge;
      const claims = request.session.authClaims;
      delete request.session.authClaims;
      const authorizeUrl = await client.getAuthCodeUrl({
        scopes: delegatedScopes,
        redirectUri: config.REDIRECT_URI,
        prompt: 'select_account',
        state,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        ...(claims ? { claims } : {}),
      });
      response.redirect(authorizeUrl);
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Unable to start sign-in' } });
    }
  });

  router.get('/callback', async (request, response): Promise<void> => {
    const expectedState = request.session.authState;
    const verifier = request.session.pkceVerifier;
    delete request.session.authState;
    delete request.session.pkceVerifier;
    delete request.session.pkceChallenge;

    if (
      !expectedState ||
      typeof request.query.state !== 'string' ||
      request.query.state !== expectedState
    ) {
      response.status(400).json({ error: { code: 'forbidden', message: 'Invalid sign-in state' } });
      return;
    }
    if (typeof verifier !== 'string' || typeof request.query.code !== 'string') {
      response
        .status(400)
        .json({ error: { code: 'validation_error', message: 'Invalid sign-in response' } });
      return;
    }

    try {
      const client = (await getClient()) as AuthClient;
      const result = await client.acquireTokenByCode({
        code: request.query.code,
        scopes: delegatedScopes,
        redirectUri: config.REDIRECT_URI,
        codeVerifier: verifier,
        state: expectedState,
      });
      const account = result.account;
      if (!account?.homeAccountId || !account.localAccountId) {
        response.status(400).json({
          error: { code: 'login_required', message: 'Unable to identify signed-in account' },
        });
        return;
      }

      const mailbox = database
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get('mailboxObjectId') as { value_json: string } | undefined;
      if (mailbox && JSON.parse(mailbox.value_json) !== account.localAccountId) {
        await removeCachedAccount(client as PublicClientApplication, account);
        response
          .status(403)
          .json({ error: { code: 'forbidden', message: 'Another mailbox is already configured' } });
        return;
      }

      database
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
        .run('mailboxObjectId', JSON.stringify(account.localAccountId));
      await new Promise<void>((resolve, reject) => {
        request.session.regenerate((error) => (error ? reject(error) : resolve()));
      });
      request.session.homeAccountId = account.homeAccountId;
      await new Promise<void>((resolve, reject) => {
        request.session.save((error) => (error ? reject(error) : resolve()));
      });
      startScheduler?.(account.homeAccountId);
      response.redirect(config.FRONTEND_URL);
    } catch {
      response
        .status(401)
        .json({ error: { code: 'login_required', message: 'Sign-in could not be completed' } });
    }
  });

  router.get('/me', async (request, response): Promise<void> => {
    const homeAccountId = request.session.homeAccountId;
    if (!homeAccountId) {
      response
        .status(401)
        .json({ error: { code: 'login_required', message: 'Sign in is required' } });
      return;
    }
    try {
      const client = (await getClient()) as AuthClient;
      const account = await client.getTokenCache().getAccountByHomeId(homeAccountId);
      if (!account) {
        response
          .status(401)
          .json({ error: { code: 'login_required', message: 'Sign in is required' } });
        return;
      }
      await acquireGraphToken(client as PublicClientApplication, homeAccountId);
      response.json({ data: { name: account.name ?? '' } });
    } catch {
      response
        .status(401)
        .json({ error: { code: 'login_required', message: 'Sign in is required' } });
    }
  });

  router.post('/logout', async (request, response): Promise<void> => {
    const homeAccountId = request.session.homeAccountId;
    try {
      if (homeAccountId) {
        const client = (await getClient()) as AuthClient;
        const account = await client.getTokenCache().getAccountByHomeId(homeAccountId);
        await removeCachedAccount(client as PublicClientApplication, account);
      }
      await new Promise<void>((resolve, reject) => {
        request.session.destroy((error) => (error ? reject(error) : resolve()));
      });
      response.clearCookie('occ.sid');
      response.status(204).end();
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Unable to sign out' } });
    }
  });

  return router;
}
