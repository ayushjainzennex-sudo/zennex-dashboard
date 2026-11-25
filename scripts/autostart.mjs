#!/usr/bin/env node
// Start the dashboard (npm run serve:lan → port 4173, also reachable from other devices on your network) when you sign in.
//   npm run autostart:install     npm run autostart:uninstall     npm run autostart:status
// Windows: Startup-folder shortcut (hidden window). macOS: LaunchAgent. Linux: XDG autostart entry.
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, networkInterfaces} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const log = join(root, 'data', 'server.log');
const action = process.argv[2] ?? 'status';
const LABEL = 'com.channelstudio.dashboard';
mkdirSync(join(root, 'data'), {recursive: true});

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {stdio: 'pipe', encoding: 'utf8', ...opts});
const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = s => "'" + s.replace(/'/g, `'\\''`) + "'";

const platforms = {
  win32: {
    file: join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'YouTube Dashboard.lnk'),
    install(file) {
      const vbs = join(root, 'scripts', 'start-hidden.vbs');
      const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${file.replace(/'/g, "''")}');$s.TargetPath="$env:WINDIR\\System32\\wscript.exe";$s.Arguments='"${vbs.replace(/'/g, "''")}"';$s.WorkingDirectory='${root.replace(/'/g, "''")}';$s.Save()`;
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      spawn(join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wscript.exe'), [vbs], {detached: true, stdio: 'ignore'}).unref();
    },
    uninstall(file) { rmSync(file, {force: true}); }
  },
  darwin: {
    file: join(homedir(), 'Library', 'LaunchAgents', LABEL + '.plist'),
    install(file) {
      mkdirSync(dirname(file), {recursive: true});
      // A login shell picks up Homebrew / nvm / fnm on PATH, which launchd does not provide.
      const shell = process.env.SHELL || '/bin/zsh';
      writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(shell)}</string><string>-lc</string><string>${xml('cd ' + sh(root) + ' && npm run serve:lan')}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`);
      const domain = 'gui/' + process.getuid();
      try { run('launchctl', ['bootout', domain, file]); } catch {}
      run('launchctl', ['bootstrap', domain, file]);
    },
    uninstall(file) {
      try { run('launchctl', ['bootout', 'gui/' + process.getuid(), file]); } catch {}
      rmSync(file, {force: true});
    }
  },
  linux: {
    file: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'channel-studio.desktop'),
    install(file) {
      mkdirSync(dirname(file), {recursive: true});
      const cmd = `cd ${sh(root)} && npm run serve:lan >> ${sh(log)} 2>&1`;
      writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Channel Studio dashboard\nExec=sh -lc ${sh(cmd)}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`);
      spawn('sh', ['-lc', cmd], {detached: true, stdio: 'ignore'}).unref();
    },
    uninstall(file) { rmSync(file, {force: true}); }
  }
};

const p = platforms[process.platform];
if (!p) { console.error(`Autostart is not supported on ${process.platform}. Run "npm run serve" manually.`); process.exit(1); }

if (action === 'install') {
  p.install(p.file);
  const lan = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:4173`);
  console.log(`Autostart installed (${p.file}).\nThe dashboard is starting now. In a few seconds open http://localhost:4173${lan.length ? '\nOn other devices on your network: ' + lan.join('  ') : ''}\nLog: ${log}`);
} else if (action === 'uninstall') {
  p.uninstall(p.file);
  console.log('Autostart removed.' + (process.platform === 'darwin' ? ' The server has been stopped.' : ' A server that is already running keeps going until you sign out or stop its node process.'));
} else {
  console.log(existsSync(p.file) ? `Autostart is installed: ${p.file}` : 'Autostart is not installed. Run: npm run autostart:install');
}
