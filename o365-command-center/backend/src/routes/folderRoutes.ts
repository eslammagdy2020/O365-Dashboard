import { Router } from 'express';
import type { MsalClientProvider } from '../auth/requireAuth.js';
import { createFolderController } from '../controllers/folderController.js';

export function createFolderRoutes(getClient: MsalClientProvider): Router {
  const router = Router();
  router.get('/', createFolderController(getClient));
  return router;
}
