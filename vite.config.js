import { defineConfig } from 'vite';

const publicHost = (() => { try { return process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : null; } catch { return null; } })();
const allowedHosts = ['.trycloudflare.com', ...(publicHost ? [publicHost] : [])];

// The API, SQLite database and 60-minute batch updater run inside Vite's dev/preview server.
// They are loaded only here, not at the top of this file: `vite build` (e.g. on Vercel) must not open the database.
const mount = async server => {
  const {apiMiddleware, startScheduler, stopScheduler} = await import('./server/api.js');
  const {setPort} = await import('./server/cluster.js');
  server.middlewares.use(apiMiddleware());
  // The node's address for the Nodes page (port known once the server listens).
  const hs = server.httpServer, port = () => { const a = hs?.address(); if (a && typeof a === 'object') setPort(a.port, /^(127\.|::1$|::ffff:127\.)/.test(a.address)); };
  hs?.listening ? port() : hs?.once('listening', port);
  startScheduler();
  server.httpServer?.once('close', stopScheduler);
};

export default defineConfig({
  build: {outDir:'dist', emptyOutDir:true},
  // CORS is handled by the API itself (server/api.js), so Vite must not answer preflight requests first.
  // Besides this PC's own names, only tunnel addresses may be used (protects against DNS rebinding).
  server: {watch: {ignored: ['**/data/**']}, cors: false, allowedHosts},
  preview: {cors: false, allowedHosts},
  plugins:[{name:'youtube-dashboard-api', configureServer:mount, configurePreviewServer:mount}]
});
