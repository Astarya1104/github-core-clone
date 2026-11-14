// HTTP server: routing, auth, request ids, body reading. The forge itself lives
// in store.ts (state), git.ts (smart HTTP), rest.ts (REST v3), graphql.ts and
// mcp.ts. Only Node stdlib is used.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp, mcpParseError } from './mcp.ts';
import { infoRefs, uploadPack, receivePack } from './git.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  function authed(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length).trim();
    if (token === '') return false;
    if (expectedToken !== '') return token === expectedToken;
    return true;
  }

  function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, headers?: Record<string, string>): void {
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
      ...headers,
    });
    res.end(payload);
  }

  function sendBuffer(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': requestId,
    });
    res.end(body);
  }

  const server = createServer((req, res) => {
    void (async () => {
      requestSeq += 1;
      const requestId = `req-${requestSeq}`;
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = (req.method ?? 'GET').toUpperCase();
        const segments = url.pathname.split('/').filter((part) => part !== '');
        const host = req.headers.host ?? '127.0.0.1';
        const baseUrl = `http://${host}`;

        if (url.pathname === '/healthz') {
          sendJson(res, requestId, 200, { ok: true });
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
          if (!authed(req)) {
            sendJson(res, requestId, 401, { message: 'requires authentication' });
            return;
          }
          const owner = decodeURIComponent(segments[0] as string);
          const repoName = decodeURIComponent((segments[1] as string).slice(0, -4));
          const gitProtocol = req.headers['git-protocol'];
          const sub = segments[2] ?? '';
          if (method === 'GET' && sub === 'info' && segments[3] === 'refs') {
            const service = url.searchParams.get('service') ?? '';
            const result = infoRefs(store, owner, repoName, service, gitProtocol);
            sendBuffer(res, requestId, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && sub === 'git-upload-pack') {
            const body = await readBody(req);
            const result = uploadPack(store, owner, repoName, gitProtocol, body);
            sendBuffer(res, requestId, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && sub === 'git-receive-pack') {
            const body = await readBody(req);
            const result = receivePack(store, owner, repoName, body);
            sendBuffer(res, requestId, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, requestId, 404, { message: 'not found' });
          return;
        }

        // MCP: a body that is not JSON answers 400/-32700 before the auth check.
        if (url.pathname === '/mcp') {
          const body = await readBody(req);
          let parsed: unknown = null;
          try {
            parsed = body.length === 0 ? null : JSON.parse(body.toString('utf8'));
          } catch {
            const result = mcpParseError();
            sendJson(res, requestId, result.status, result.body);
            return;
          }
          if (!authed(req)) {
            sendJson(res, requestId, 401, { message: 'requires authentication' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, requestId, 405, { message: 'method not allowed' });
            return;
          }
          const result = handleMcp(store, parsed);
          sendJson(res, requestId, result.status, result.body);
          return;
        }

        if (!authed(req)) {
          sendJson(res, requestId, 401, { message: 'requires authentication' });
          return;
        }

        // GraphQL.
        if (url.pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, requestId, 405, { message: 'method not allowed' });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, requestId, 400, { message: 'malformed JSON' });
            return;
          }
          const result = handleGraphql(store, parsed);
          sendJson(res, requestId, result.status, result.body);
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const body = await readBody(req);
          let parsed: unknown = null;
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, requestId, 400, { message: 'malformed JSON' });
              return;
            }
          }
          const result = handleRest(store, method, segments.slice(2), url.searchParams, parsed, baseUrl);
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, requestId, result.status, result.body, result.headers);
          return;
        }

        sendJson(res, requestId, 404, { message: 'not found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, requestId, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
