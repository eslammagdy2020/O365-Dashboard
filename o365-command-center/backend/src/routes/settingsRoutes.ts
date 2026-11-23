import { Router } from 'express';
import type Database from 'better-sqlite3';
import type { SyncScheduler } from '../sync/scheduler.js';
import {
  createGetSettingsController,
  createPutSettingsController,
} from '../controllers/settingsController.js';

export function createSettingsRoutes(database: Database.Database, scheduler?: SyncScheduler): Router {
  const router = Router();
  router.get('/', createGetSettingsController(database));
  router.put('/', createPutSettingsController(database, scheduler));
  return router;
}
