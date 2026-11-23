import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PublicClientApplication } from '@azure/msal-node';
import { acquireGraphToken } from './tokenCache.js';

export type MsalClientProvider = () => Promise<PublicClientApplication>;

export function requireAuth(getClient: MsalClientProvider): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const homeAccountId = request.session?.homeAccountId;
    if (typeof homeAccountId !== 'string' || !homeAccountId) {
      response
        .status(401)
        .json({ error: { code: 'login_required', message: 'Sign in is required' } });
      return;
    }

    try {
      const client = await getClient();
      await acquireGraphToken(client, homeAccountId);
      next();
    } catch (error) {
      const authError = error as { errorCode?: string; claims?: string; claimsChallenge?: string };
      const claims = authError.claims ?? authError.claimsChallenge;
      if (claims) request.session.authClaims = claims;
      if (
        authError.errorCode === 'interaction_required' ||
        authError.errorCode === 'invalid_grant' ||
        (error instanceof Error && /interaction_required|invalid_grant/.test(error.message))
      ) {
        response.status(401).json({
          error: {
            code: 'login_required',
            message: 'Sign in is required',
            ...(claims ? { claims } : {}),
          },
        });
        return;
      }
      response.status(500).json({
        error: { code: 'internal_error', message: 'Unable to verify the current sign-in' },
      });
    }
  };
}
