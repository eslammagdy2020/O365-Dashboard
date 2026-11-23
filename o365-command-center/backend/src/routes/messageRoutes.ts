import { Router } from 'express';
import type Database from 'better-sqlite3';
import {
  createMessageDetailController,
  createMessageListController,
} from '../controllers/messageController.js';
import type { MailApi } from '../graph/mailApi.js';
import type { Request } from 'express';

export function createMessageRoutes(
  database: Database.Database,
  getMailApi?: (request: Request) => Promise<MailApi>,
): Router {
  const router = Router();
  router.get('/', createMessageListController(database));
  router.get('/:id', createMessageDetailController(database, getMailApi));
  return router;
}
