// Self-update from GitHub. A node installed with `git clone` checks its branch's upstream every 30 minutes and
// reports how far behind it is (shown on the Nodes page). Updating = fast-forward pull, `npm install` when the
// dependencies changed, a fresh build, and a restart (scripts/restart.mjs starts the same command again once
// this process has exited). Any failed step rolls the code back to the commit it was on.
// It never touches a copy with local edits or local commits, and never runs on a dev server (`npm run dev`).
// Uses only Node built-ins (no database), so it can be tested on its own.
import {execFile, exec, spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const execFileP = promisify(execFile), execP = promisify(exec);
const CHECK_EVERY = 30 * 60e3;
// Git must never wait for a password prompt in the background.
const ENV = {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'};

export const update = {
  state: 'unknown',   // unknown | unavailable | current | available | updating | failed | restarting
  reason: null,       // why updates are unavailable, or why the last one failed
  branch: null, upstream: null, commit: null, latest: null, latestMessage: null,
  behind: 0, ahead: 0, dirty: false, checkedAt: null, updatedAt: null, step: null,
  lastError: null     // the last failed update (kept until an update succeeds)
};
let dev = false, lastCheck = 0, onRestart = () => {}, opts = {root, run: null};
export const setDevServer = v => { dev = !!v; };
export const onBeforeRestart = fn => { onRestart = fn; };
// For tests: run git/npm in another folder, or with a fake command runner.
export const _configure = o => { opts = {...opts, ...o}; };
export const updateState = () => ({...update, dev});

const git = async (...args) => (opts.run ? opts.run('git', args) : (await execFileP('git', args, {cwd: opts.root, env: ENV, timeout: 120e3, windowsHide: true})).stdout).trim();
const shell = async cmd => opts.run ? opts.run('sh', [cmd]) : (await execP(cmd, {cwd: opts.root, env: ENV, timeout: 600e3, windowsHide: true, maxBuffer: 20e6})).stdout;

// Looks at GitHub (git fetch) and updates `update`. Cheap enough to call every half hour.
export async function check(force = false) {
  if (!force && Date.now() - lastCheck < CHECK_EVERY && update.state !== 'unknown') return updateState();
  if (update.state === 'restarting' || (applying && !force)) return updateState();
  lastCheck = Date.now();
  Object.assign(update, {checkedAt: new Date().toISOString()});
  if (!opts.run && !existsSync(join(opts.root, '.git'))) return unavailable('This copy was not installed with git clone, so it can’t update itself. Update it by hand.');
  try {
    update.branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    try { update.upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); }
    catch { return unavailable(`The branch "${update.branch}" isn’t linked to a GitHub branch.`); }
    const [remote, ...rest] = update.upstream.split('/');
    await git('fetch', '--quiet', remote, rest.join('/'));
    update.commit = await git('rev-parse', '--short', 'HEAD');
    update.latest = await git('rev-parse', '--short', '@{u}');
    update.latestMessage = await git('log', '-1', '--format=%s', '@{u}');
    update.behind = Number(await git('rev-list', '--count', 'HEAD..@{u}'));
    update.ahead = Number(await git('rev-list', '--count', '@{u}..HEAD'));
    update.dirty = (await git('status', '--porcelain', '--untracked-files=no')).length > 0;
    update.state = update.behind ? 'available' : 'current';
    update.reason = null;
  } catch (err) {
    update.state = 'unavailable';
    update.reason = 'Could not check GitHub: ' + firstLine(err);
  }
  return updateState();
}
function unavailable(reason) { Object.assign(update, {state: 'unavailable', reason}); return updateState(); }
const firstLine = err => String(err.stderr || err.message || err).trim().split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? 'unknown error';

// Why this copy can't be updated automatically right now, or null when it can.
export function blocker() {
  if (dev) return 'This is a development server (npm run dev); update it by hand.';
  if (update.state === 'unavailable') return update.reason;
  if (update.ahead) return `This copy has ${update.ahead} commit${update.ahead === 1 ? '' : 's'} that aren’t on GitHub; update it by hand.`;
  if (update.dirty) return 'This copy has edited files; update it by hand (or undo the edits).';
  return null;
}

let applying = null;
// Installs the newest version and restarts. Returns {ok, message}.
export function apply() {
  return applying ??= (async () => {
    await check(true);
    if (!update.behind) return {ok: true, message: 'Already up to date.'};
    const stop = blocker();
    if (stop) return {ok: false, message: stop};
    const from = await git('rev-parse', 'HEAD');
    update.state = 'updating';
    try {
      update.step = 'Downloading';
      await git('merge', '--ff-only', '@{u}');
      const changed = (await git('diff', '--name-only', from, 'HEAD')).split('\n');
      if (changed.some(f => /^package(-lock)?\.json$/.test(f))) { update.step = 'Installing packages'; await shell('npm install --no-audit --no-fund'); }
      update.step = 'Building the page';
      await buildPage();
    } catch (err) {
      const reason = `Update failed while ${update.step.toLowerCase()}: ${firstLine(err)}`;
      try { await git('reset', '--hard', from); } catch {}
      Object.assign(update, {state: 'failed', reason, lastError: {at: new Date().toISOString(), message: reason}, step: null});
      lastCheck = 0; // the next check recomputes the state; lastError stays visible
      console.error('[dashboard] ' + reason + ' (rolled back)');
      return {ok: false, message: reason + ' The node stays on the version it had.'};
    }
    Object.assign(update, {state: 'restarting', step: 'Restarting', updatedAt: new Date().toISOString(), commit: update.latest, behind: 0, lastError: null});
    console.log(`[dashboard] updated to ${update.latest} (${update.latestMessage}); restarting`);
    restart();
    return {ok: true, message: 'Updated. The node is restarting and will be back in a few seconds.'};
  })().finally(() => { applying = null; });
}

// The page build must not be the Vercel one (VITE_REMOTE) on a node.
async function buildPage() {
  if (opts.run) return opts.run('build', []);
  const env = {...ENV}; delete env.VITE_REMOTE;
  await execFileP(process.execPath, [join(opts.root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {cwd: opts.root, env, timeout: 600e3, windowsHide: true, maxBuffer: 20e6});
}

// Starts scripts/restart.mjs (detached), which waits for this process to exit and then runs the same command again.
function restart() {
  if (opts.run) return opts.run('restart', []);
  const argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  spawn(process.execPath, [join(opts.root, 'scripts', 'restart.mjs'), String(process.pid), JSON.stringify(argv)], {cwd: opts.root, detached: true, stdio: 'ignore', windowsHide: true, env: process.env}).unref();
  setTimeout(() => {
    try { onRestart(); } catch {}
    setTimeout(() => process.exit(0), 1500).unref();
  }, 300);
}

// Called by the heartbeat. auto: the shared "install updates automatically" setting; busy: the node is mid-job.
export async function tick({auto, busy}) {
  await check();
  if (auto && update.state === 'available' && !busy && !blocker()) return apply();
}
