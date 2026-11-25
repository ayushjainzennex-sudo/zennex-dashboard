// A node without Vite: serves the built dashboard (dist/) and the API, and runs the background work.
// Start with `npm run node` (builds first) or `npm run node:start` (uses the existing build).
// Settings come from .env: DATABASE_URL / DATABASE_TOKEN (shared database), NODE_NAME, PORT (default 4173),
// HOST (default 0.0.0.0, i.e. reachable on the network) and PUBLIC_URL (the address other devices use).
import {createServer} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {extname, join, normalize, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {apiMiddleware, startScheduler, stopScheduler} from './api.js';
import {setPort, NODE_NAME, VERSION, nodeUrl} from './cluster.js';
import {cloud} from './db.js';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT) || 4173, HOST = process.env.HOST || '0.0.0.0';
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json'};

if (!existsSync(join(dist, 'index.html'))) console.warn('[dashboard] no dist/ build found: the API runs, but the page will not load. Run `npm run node` (it builds first).');

function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html'); // single-page app
  if (!existsSync(file)) { res.writeHead(404); return res.end('Not built yet.'); }
  res.writeHead(200, {'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.includes(join(dist, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-cache'});
  createReadStream(file).pipe(res);
}

const api = apiMiddleware();
const server = createServer((req, res) => api(req, res, () => serveStatic(req, res)));
server.listen(PORT, HOST, () => {
  setPort(PORT, /^(127\.|localhost$|::1$)/.test(HOST));
  console.log(`[dashboard] node "${NODE_NAME}" (${VERSION}) on ${nodeUrl()} · ${cloud ? 'shared cloud database' : 'local database file'}`);
  startScheduler();
});
server.on('error', err => { console.error(`[dashboard] cannot listen on ${HOST}:${PORT}: ${err.message}`); process.exit(1); });
const quit = () => { stopScheduler(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
