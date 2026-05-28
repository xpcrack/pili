import fs from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import { getRequestListener, serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { registerApiRoutes } from '@/server/api';
import { createRuntimeContext } from '@/server/runtime-context';

interface CreateServerOptions {
  mode: 'live' | 'prod';
  repoRoot: string;
  port: number;
}

interface RuntimeServer {
  start(): Promise<void>;
  stop(signal?: string): Promise<void>;
}

async function closeNodeServer(server: {
  close(callback: (error?: Error | null) => void): void;
}) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function buildSpaHtmlTemplate(repoRoot: string) {
  return fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
}

function getRequestPathname(url: string | undefined) {
  return new URL(url || '/', 'http://127.0.0.1').pathname;
}

function isApiRequestPath(pathname: string) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function shouldServeSpaHtml(request: IncomingMessage) {
  const method = (request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  const pathname = getRequestPathname(request.url);
  if (isApiRequestPath(pathname)) {
    return false;
  }

  if (path.extname(pathname)) {
    return false;
  }

  const accept = request.headers.accept || '';
  return accept.includes('text/html');
}

async function sendHtmlResponse(response: ServerResponse, html: string, method?: string) {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if ((method || 'GET').toUpperCase() === 'HEAD') {
    response.end();
    return;
  }

  response.end(html);
}

export async function createServer(options: CreateServerOptions): Promise<RuntimeServer> {
  const runtimeContext = createRuntimeContext({
    repoRoot: options.repoRoot,
    mode: options.mode,
    port: options.port,
  });
  await runtimeContext.tasks.startAll();

  const app = new Hono();
  registerApiRoutes(app);
  app.onError((error, c) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[runtime] request failed:', message);
    return c.text('internal error', 500);
  });

  let vite: ViteDevServer | null = null;
  let prodServer: ServerType | null = null;
  const template = buildSpaHtmlTemplate(options.repoRoot);
  const honoListener = getRequestListener(app.fetch, {
    hostname: '127.0.0.1',
    overrideGlobalObjects: false,
  });

  if (options.mode === 'prod') {
    app.use('/assets/*', serveStatic({ root: './dist/client' }));
    app.use('/spa/*', serveStatic({ root: './dist/client' }));
  } else {
    const httpServer = createHttpServer(async (request, response) => {
      const pathname = getRequestPathname(request.url);

      if (isApiRequestPath(pathname)) {
        await honoListener(request, response);
        return;
      }

      try {
        if (shouldServeSpaHtml(request)) {
          const html = await vite!.transformIndexHtml(request.url || '/', template);
          await sendHtmlResponse(response, html, request.method);
          return;
        }

        await new Promise<void>((resolve, reject) => {
          vite!.middlewares(request, response, (error?: Error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });

        if (!response.writableEnded) {
          response.statusCode = 404;
          response.end('not found');
        }
      } catch (error) {
        if (error instanceof Error) {
          vite?.ssrFixStacktrace(error);
        }
        response.statusCode = 500;
        response.end(error instanceof Error ? error.stack || error.message : 'internal error');
      }
    });

    vite = await createViteServer({
      configFile: path.join(options.repoRoot, 'vite.config.ts'),
      server: {
        host: '127.0.0.1',
        port: options.port,
        strictPort: true,
        middlewareMode: { server: httpServer },
      },
      appType: 'custom',
    });

    return {
      async start() {
        await new Promise<void>((resolve, reject) => {
          httpServer.once('error', reject);
          httpServer.listen(options.port, '127.0.0.1', () => {
            httpServer.off('error', reject);
            console.log(`[runtime] mode=${options.mode} url=http://127.0.0.1:${options.port}`);
            resolve();
          });
        });
      },
      async stop(signal?: string) {
        await runtimeContext.tasks.stopAll(signal);
        await vite?.close();
        await closeNodeServer(httpServer);
      },
    };
  }

  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound();
    }

    const distIndexPath = path.join(options.repoRoot, 'dist/client/index.html');
    const html = await fs.promises.readFile(distIndexPath, 'utf8');
    return c.html(html);
  });

  return {
    async start() {
      const server = serve({
        fetch: app.fetch,
        port: options.port,
        hostname: '127.0.0.1',
        overrideGlobalObjects: false,
      }, () => {
        console.log(`[runtime] mode=${options.mode} url=http://127.0.0.1:${options.port}`);
      });

      await new Promise<void>((resolve) => {
        server.on('listening', () => {
          resolve();
        });
      });

      prodServer = server;
    },
    async stop(signal?: string) {
      await runtimeContext.tasks.stopAll(signal);
      if (prodServer) {
        prodServer.close();
        prodServer = null;
      }
    },
  };
}
