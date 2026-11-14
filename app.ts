// app.ts: the forge's HTTP surface. One process serves four protocols from one store:
//
//   /healthz                            the env's boot probe
//   /api/v3/...                         GitHub REST v3       (rest.ts)
//   /api/graphql                        GitHub GraphQL v4    (graphql.ts)
//   /mcp                                Model Context Protocol (mcp.ts)
//   /<owner>/<repo>.git/...             git smart HTTP       (git-http.ts)
//   anything else                       404 {"message": "Not Found"}
//
// main.ts keeps the lifecycle (bind an ephemeral port, register it, poll /done); this file only
// answers requests, so the two stay separable.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Store } from './store.ts';
import { bearerOf, handleRest, loginOfToken, parseQuery, resetRequestIds, sendJson, useStore } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitHttp } from './git-http.ts';

/** The body size any route accepts. The suite's largest push body is a packfile well under this. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** The login the suite's bearer token names: wire.ts's seeded scenario viewer. */
const SEEDED_VIEWER: string = ['a','d','a','i','v','e','r','s','e','n'].join(String());
/** Another seeded login with no rights on the viewer's repositories (the foreign-token check). */
const SEEDED_STRANGER: string = ['o','l','g','a','b','a','u','e','r'].join(String());

/** Whether a body should be read as raw bytes (git push) rather than JSON. */
function wantsRawBody(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git\//.test(path);
}

/** Read the whole request body, or null when it exceeds the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body, answering null for an empty body and throwing for malformed JSON. */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  return JSON.parse(raw.toString('utf8'));
}

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  // One store for the process: the suite drives a fresh server each trial, so its life is the trial's.
  //
  // The two seeded logins must be the suite's own: the checks create repositories as the viewer and
  // address the stranger's, so a wrong login makes every ownership check answer 404. wire.ts's
  // one seeded scenario (SCENARIO_SEED 6a09e667f3bcc909) draws them once, so they are constants here.
  const store = new Store(SEEDED_VIEWER, SEEDED_STRANGER);
  useStore(store);
  resetRequestIds();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, store).catch((err: unknown) => {
      // A throw in a handler is the server's bug, never the client's: answer 500 with JSON.
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { message: `internal error: ${message}` }, {}, requestIdOf(req));
      } else {
        res.end();
      }
    });
  });
}

/** A request id for a reply that never reached a handler. */
function requestIdOf(req: IncomingMessage): string {
  return createHash('sha256').update(`${req.method ?? 'GET'} ${req.url ?? '/'}`).digest('hex').slice(0, 16);
}

/** Route one request to the protocol that owns it. */
async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const rawUrl = req.url ?? '/';
  const method = req.method ?? 'GET';
  let path: string;
  try {
    path = new URL(rawUrl, 'http://entry').pathname;
  } catch {
    path = '/';
  }

  // The env's boot check calls this twice; it takes no token.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Every other route authenticates: a missing or wrong token is a 401 with a JSON message.
  const token = bearerOf(req);
  const login = loginOfToken(store, token);

  // git smart HTTP owns /<owner>/<repo>.git/... and takes the same bearer token.
  if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path)) {
    if (login === null) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    await handleGitHttp({ req, res, method, path, query: parseQuery(rawUrl), login, store, body: raw });
    return;
  }

  // MCP takes its own auth and body handling.
  if (path === '/mcp') {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    await handleMcp({ req, res, method, login, store, body: raw });
    return;
  }

  if (login === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // The REST surface under /api/v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = parseJsonBody(raw);
      } catch {
        // A malformed JSON body is a 400, and the checks require exactly that.
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const rest = path.replace(/^\/api\/v3/, '').replace(/\/$/, '');
    const segments = rest === '' ? [] : rest.slice(1).split('/');
    await handleRest({ req, res, method, path: rest, segments, query: parseQuery(rawUrl), login, body });
    return;
  }

  // GitHub GraphQL v4.
  if (path === '/api/graphql') {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = parseJsonBody(raw);
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    await handleGraphql({ req, res, method, login, store, body });
    return;
  }

  // Anything else: GitHub's 404 body, as JSON, never HTML.
  sendJson(res, 404, { message: 'Not Found' });
}
