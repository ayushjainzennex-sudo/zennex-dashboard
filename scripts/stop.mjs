#!/usr/bin/env node
// Stop every running dashboard server (dev on 5173, serve/serve:lan/autostart on 4173).
//   npm run stop
import {execFileSync} from 'node:child_process';

const PORTS = [4173, 5173];
const run = (cmd, args) => { try { return execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}); } catch { return ''; } };

const pids = new Set();
if (process.platform === 'win32') {
  for (const line of run('netstat', ['-ano', '-p', 'TCP']).split('\n').concat(run('netstat', ['-ano', '-p', 'TCPv6']).split('\n'))) {
    const m = line.trim().split(/\s+/);
    if (m[3] === 'LISTENING' && PORTS.some(p => m[1]?.endsWith(':' + p))) pids.add(m[4]);
  }
} else {
  for (const p of PORTS) run('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN']).split('\n').filter(Boolean).forEach(x => pids.add(x));
}
pids.delete(String(process.pid));

if (!pids.size) { console.log('No dashboard server is running.'); process.exit(0); }
for (const pid of pids) {
  if (process.platform === 'win32') run('taskkill', ['/PID', pid, '/T', '/F']);
  else try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  console.log(`Stopped process ${pid}.`);
}
console.log('All dashboard servers stopped.' + (process.platform === 'darwin' ? ' (Auto-start may restart it; use npm run autostart:uninstall to stop it for good.)' : ''));
