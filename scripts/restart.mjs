// Used by the self-updater (server/updater.js): waits for the old server process to exit (so its port and the
// database lock are free), then starts the same command again in the background, logging to data/server.log.
//   node scripts/restart.mjs <old pid> '<JSON array: command and arguments>'
import {spawn} from 'node:child_process';
import {mkdirSync, openSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [pid, argvJson] = process.argv.slice(2);
const argv = JSON.parse(argvJson ?? '[]');
if (!Array.isArray(argv) || !argv.length) process.exit(1);

const alive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
for (let i = 0; i < 120 && alive(Number(pid)); i++) await new Promise(r => setTimeout(r, 500));
await new Promise(r => setTimeout(r, 1000)); // let the OS release the port

mkdirSync(join(root, 'data'), {recursive: true});
const log = openSync(join(root, 'data', 'server.log'), 'a');
spawn(argv[0], argv.slice(1), {cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env}).unref();
