import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, resumeRun, runToEnd, spanLedger, RUN_MODES } from '../public/lab.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const STATIC_FILES = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/guide.html', ['text/html; charset=utf-8', 'guide.html']],
  ['/styles.css', ['text/css; charset=utf-8', 'styles.css']],
  ['/pb-shell.css', ['text/css; charset=utf-8', 'pb-shell.css']],
  ['/pb-back.css', ['text/css; charset=utf-8', 'pb-back.css']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/lab.mjs', ['text/javascript; charset=utf-8', 'lab.mjs']],
  ['/scenarios.mjs', ['text/javascript; charset=utf-8', 'scenarios.mjs']],
].map(([path, [type, file]]) => [path, [type, readFileSync(join(PUBLIC, file))]]));
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
};

// GET /api/run?mode=chain|while|graph — drives the same domain module the
// browser uses, to its resting state (graph auto-approves the interrupt so
// the response is the complete ledger).
function handleApiRun(url, res) {
  const mode = url.searchParams.get('mode') ?? 'graph';
  if (!RUN_MODES.includes(mode)) {
    sendJson(res, 400, { error: `mode must be one of: ${RUN_MODES.join(', ')}` });
    return;
  }
  const run = createRun({ mode });
  runToEnd(run);
  if (run.status === 'awaiting-approval') {
    resumeRun(run);
    runToEnd(run);
  }
  const spans = spanLedger(run);
  sendJson(res, 200, {
    mode,
    status: run.status,
    cycles: run.cycle,
    attempts: run.state.attempts,
    score: run.state.score,
    totalMs: spans.reduce((sum, s) => sum + s.ms, 0),
    retryMs: spans.filter(s => s.retry).reduce((sum, s) => sum + s.ms, 0),
    spans,
  });
}

export function createStaticServer() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }
    if (url.pathname === '/version') {
      sendJson(res, 200, {
        name: PACKAGE.name,
        version: PACKAGE.version,
        commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
      });
      return;
    }
    if (url.pathname === '/api/run') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      handleApiRun(url, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = STATIC_FILES.get(url.pathname);
      if (asset) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'public, max-age=300',
          'content-type': asset[0],
        }).end(req.method === 'HEAD' ? undefined : asset[1]);
        return;
      }
    }
    res.writeHead(404, SECURITY_HEADERS).end('not found');
  });
}

export async function startProduction({ port = Number(process.env.PORT) || 3000 } = {}) {
  const server = createStaticServer();
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  const close = () => new Promise(resolve => server.close(resolve));
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, close } = await startProduction();
  console.log(`Loop Line lab listening on ${server.address().port}`);
  const shutdown = async () => { await close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
