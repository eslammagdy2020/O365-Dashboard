import type { Request, Response } from 'express';
import { GraphError } from '../graph/graphClient.js';
import { createMailApi } from '../graph/mailApi.js';
import type { MsalClientProvider } from '../auth/requireAuth.js';
import type { WellKnownFolderName } from '../graph/types.js';

const WELL_KNOWN_NAMES: WellKnownFolderName[] = ['inbox', 'sentitems', 'archive', 'deleteditems'];

export function createFolderController(getClient: MsalClientProvider) {
  return async (request: Request, response: Response): Promise<void> => {
    const homeAccountId = request.session?.homeAccountId;
    if (!homeAccountId) {
      response
        .status(401)
        .json({ error: { code: 'login_required', message: 'Sign in is required' } });
      return;
    }

    try {
      const mailApi = createMailApi(await getClient(), homeAccountId);
      const folders = await mailApi.listFolders();
      const foldersById = new Set(folders.map((folder) => folder.id));
      const wellKnown = await Promise.all(
        WELL_KNOWN_NAMES.map(async (name) => {
          try {
            const folder = await mailApi.getWellKnownFolder(name);
            return foldersById.has(folder.id) ? ([folder.id, name] as const) : undefined;
          } catch (error) {
            if (error instanceof GraphError && error.status === 404) return undefined;
            throw error;
          }
        }),
      );
      const wellKnownById = new Map(wellKnown.filter((entry) => entry !== undefined));
      response.json({
        data: folders.map((folder) => ({
          ...folder,
          wellKnown: wellKnownById.get(folder.id) ?? null,
        })),
      });
    } catch (error) {
      if (error instanceof GraphError) {
        const status = error.status === 401 ? 401 : error.status === 429 ? 429 : 502;
        response.status(status).json({
          error: {
            code:
              error.code === 'login_required'
                ? 'login_required'
                : status === 429
                  ? 'throttled'
                  : 'graph_error',
            message:
              status === 401
                ? 'Sign in is required'
                : 'Unable to load folders from Microsoft Graph',
            ...(error.requestId ? { requestId: error.requestId } : {}),
          },
        });
        return;
      }
      response.status(500).json({
        error: { code: 'internal_error', message: 'Unable to load folders' },
      });
    }
  };
}
