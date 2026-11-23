import type { Request, Response } from 'express';
import type { SyncService } from '../sync/syncService.js';
import type { SyncScheduler } from '../sync/scheduler.js';

export function createSyncStatusController(syncService: SyncService) {
  return (_request: Request, response: Response): void => {
    response.json({ data: syncService.status() });
  };
}

export function createSyncRunController(syncService: SyncService, scheduler?: SyncScheduler) {
  return (request: Request, response: Response): void => {
    const homeAccountId = request.session?.homeAccountId;
    if (typeof homeAccountId !== 'string' || !homeAccountId) {
      response
        .status(401)
        .json({ error: { code: 'login_required', message: 'Sign in is required' } });
      return;
    }
    if (scheduler) scheduler.runNow(homeAccountId);
    else syncService.start(homeAccountId);
    response.status(202).json({ data: syncService.status() });
  };
}
