const $ = id => document.getElementById(id);
const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

async function render() {
  const s = {dashboard: 'http://localhost:4173', enabled: true, ...(await chrome.storage.local.get(null))};
  $('done').textContent = s.done ?? '–';
  $('remaining').textContent = s.remaining ?? '–';
  if (document.activeElement !== $('url')) $('url').value = s.dashboard;
  $('enabled').checked = s.enabled;
  const paused = s.pausedUntil && Date.now() < s.pausedUntil;
  $('status').innerHTML = paused ? 'Paused until ' + new Date(s.pausedUntil).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : s.remaining === 0 ? '<span class="ok">All dates are exact.</span> Checked ' + ago(s.lastCheck)
    : 'Last checked ' + ago(s.lastCheck) + (s.lastSaved ? ' · last saved ' + ago(s.lastSaved) : '');
  $('error').textContent = s.error ?? '';
}

// A dashboard on another computer (e.g. http://192.168.1.16:4173) needs permission to talk to that address.
$('url').addEventListener('change', async e => {
  const value = (e.target.value.trim() || 'http://localhost:4173').replace(/\/+$/, '');
  try {
    const origin = new URL(value).origin + '/*';
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\*$/.test(origin) && !(await chrome.permissions.request({origins: [origin]}))) {
      await chrome.storage.local.set({error: 'Permission for ' + value + ' was not granted.'}); return render();
    }
    await chrome.storage.local.set({dashboard: value, error: ''});
  } catch { await chrome.storage.local.set({error: 'That address is not a valid URL.'}); }
  render();
});
$('enabled').addEventListener('change', e => chrome.storage.local.set({enabled: e.target.checked}));
$('run').addEventListener('click', async () => { $('run').disabled = true; $('run').textContent = 'Running…'; await chrome.runtime.sendMessage('run'); $('run').disabled = false; $('run').textContent = 'Run now'; render(); });
chrome.storage.onChanged.addListener(render);
render();
