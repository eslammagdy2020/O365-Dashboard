import { Router } from 'express';
import type { SyncService } from '../sync/syncService.js';
import type { SyncScheduler } from '../sync/scheduler.js';
import {
  createSyncRunController,
  createSyncStatusController,
} from '../controllers/syncController.js';

export function createSyncRoutes(syncService: SyncService, scheduler?: SyncScheduler): Router {
  const router = Router();
  router.get('/status', createSyncStatusController(syncService));
  router.post('/run', createSyncRunController(syncService, scheduler));
  return router;
}
