import express from 'express';
import type { Request, RequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import { healthRoutes } from './routes/healthRoutes.js';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config/env.js';
import { loadConfig } from './config/env.js';
import { resolveDataPaths } from './config/paths.js';
import { openDatabase } from './db/db.js';
import { createSessionMiddleware } from './db/sessionStore.js';
import { createAuthRoutes } from './auth/authRoutes.js';
import { createMsalClient } from './auth/msalClient.js';
import type { MsalClientProvider } from './auth/requireAuth.js';
import { requireAuth } from './auth/requireAuth.js';
import { createFolderRoutes } from './routes/folderRoutes.js';
import { createSyncRoutes } from './routes/syncRoutes.js';
import { createSettingsRoutes } from './routes/settingsRoutes.js';
import { createMessageRoutes } from './routes/messageRoutes.js';
import { SyncService } from './sync/syncService.js';
import { SyncScheduler } from './sync/scheduler.js';
import { acquireGraphToken } from './auth/tokenCache.js';
import { createMailApi } from './graph/mailApi.js';
import type { MailApi } from './graph/mailApi.js';

export function createApp(
  suppliedConfig?: AppConfig,
  suppliedDatabase?: Database,
  suppliedClientProvider?: MsalClientProvider,
  staticDir?: string,
): express.Express {
  const app = express();
  let runtime:
    | {
        database: Database;
        clientProvider: MsalClientProvider;
        sessions: RequestHandler;
        authRoutes: ReturnType<typeof createAuthRoutes>;
        syncService: SyncService;
        syncScheduler: SyncScheduler;
      }
    | undefined;

  const getRuntime = () => {
    if (runtime) return runtime;
    const config = suppliedConfig ?? loadConfig();
    const database = suppliedDatabase ?? openDatabase(resolveDataPaths(config.DATA_DIR));
    let clientPromise: ReturnType<MsalClientProvider> | undefined;
    const clientProvider: MsalClientProvider = () => {
      clientPromise ??= Promise.resolve().then(() =>
        suppliedClientProvider ? suppliedClientProvider() : createMsalClient(config),
      );
      return clientPromise;
    };
    const syncService = new SyncService(database, clientProvider);
    runtime = {
      database,
      clientProvider,
      sessions: createSessionMiddleware(config, database),
      authRoutes: createAuthRoutes(config, database, clientProvider, (homeAccountId) =>
        getRuntime().syncScheduler.start(homeAccountId),
      ),
      syncService,
      syncScheduler: new SyncScheduler(database, syncService),
    };
    // A persisted browser session survives restart. Resume its background sync the first
    // time the lazy runtime is initialized; token acquisition remains silent in SyncService.
    const persistedAccount = database
      .prepare('SELECT sess_json FROM sessions WHERE expires_at > ?')
      .all(new Date().toISOString()) as Array<{ sess_json: string }>;
    for (const { sess_json: sessionJson } of persistedAccount) {
      try {
        const homeAccountId = (JSON.parse(sessionJson) as { homeAccountId?: unknown })
          .homeAccountId;
        if (typeof homeAccountId === 'string' && homeAccountId) {
          runtime.syncScheduler.start(homeAccountId);
          break;
        }
      } catch {
        // Ignore corrupt or unrelated persisted sessions; the next request can sign in again.
      }
    }
    return runtime;
  };

  app.locals.initialise = (): void => { getRuntime(); };
  app.locals.shutdown = async (): Promise<void> => {
    if (!runtime) return;
    await runtime.syncScheduler.shutdown();
    await runtime.syncService.shutdown();
    runtime.database.close();
  };

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        },
      },
    }),
  );
  app.use(express.json());

  app.use((request, response, next) => {
    const host = request.get('host');
    if (!host) {
      response
        .status(403)
        .json({ error: { code: 'forbidden', message: 'Loopback requests only' } });
      return;
    }
    try {
      const parsedHost = new URL(`http://${host}`);
      const hostname = parsedHost.hostname.toLowerCase();
      if (
        parsedHost.username ||
        parsedHost.password ||
        (hostname !== 'localhost' && hostname !== '127.0.0.1')
      ) {
        response
          .status(403)
          .json({ error: { code: 'forbidden', message: 'Loopback requests only' } });
        return;
      }
    } catch {
      response
        .status(403)
        .json({ error: { code: 'forbidden', message: 'Loopback requests only' } });
      return;
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      let frontendOrigin: string;
      try {
        frontendOrigin = (suppliedConfig ?? loadConfig()).FRONTEND_URL;
      } catch {
        response
          .status(500)
          .json({ error: { code: 'internal_error', message: 'Server configuration is invalid' } });
        return;
      }
      if (
        request.get('x-requested-with') !== 'occ' ||
        request.get('origin') !== new URL(frontendOrigin).origin
      ) {
        response
          .status(403)
          .json({ error: { code: 'forbidden', message: 'Request origin was rejected' } });
        return;
      }
    }
    next();
  });

  // Preserve the health check exception while session-gating every other route.
  app.use('/api', healthRoutes);

  app.use((request, response, next) => {
    if (request.path === '/api/health' || request.originalUrl.startsWith('/api/health?')) {
      next();
      return;
    }
    try {
      getRuntime().sessions(request, response, next);
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Server configuration is invalid' } });
    }
  });

  app.use('/auth', (request, response, next) => {
    try {
      getRuntime().authRoutes(request, response, next);
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Server configuration is invalid' } });
    }
  });
  app.use('/api', (request, response, next) => {
    if (request.path === '/health') return next();
    try {
      return requireAuth(getRuntime().clientProvider)(request, response, next);
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Server configuration is invalid' } });
    }
  });
  app.use('/api/folders', (request, response, next) => {
    try {
      return createFolderRoutes(getRuntime().clientProvider)(request, response, next);
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Server configuration is invalid' } });
    }
  });
  app.use('/api/sync', (request, response, next) => {
    try {
      const current = getRuntime();
      return createSyncRoutes(current.syncService, current.syncScheduler)(request, response, next);
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Unable to initialize sync service' } });
    }
  });
  app.use('/api/settings', (request, response, next) => {
    try {
      const current = getRuntime();
      return createSettingsRoutes(current.database, current.syncScheduler)(request, response, next);
    } catch {
      response.status(500).json({ error: { code: 'internal_error', message: 'Unable to load settings' } });
    }
  });
  const getMailApi = async (request: Request): Promise<MailApi> => {
    const homeAccountId = request.session?.homeAccountId;
    if (typeof homeAccountId !== 'string' || !homeAccountId) {
      throw new Error('login_required');
    }
    const client = await getRuntime().clientProvider();
    await acquireGraphToken(client, homeAccountId);
    return createMailApi(client, homeAccountId);
  };
  app.use('/api/messages', (request, response, next) => {
    try {
      return createMessageRoutes(getRuntime().database, getMailApi)(request, response, next);
    } catch {
      response
        .status(500)
        .json({ error: { code: 'internal_error', message: 'Unable to load cached messages' } });
    }
  });

  const staticRoot = staticDir ?? fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  if (existsSync(staticRoot)) {
    app.use(express.static(staticRoot));
    app.get('*', (request, response, next) => {
      if (
        request.path.startsWith('/api/') ||
        request.path === '/api' ||
        request.path.startsWith('/auth/') ||
        request.path === '/auth' ||
        !request.accepts('html')
      ) {
        next();
        return;
      }
      response.sendFile('index.html', { root: staticRoot });
    });
  }
  return app;
}
