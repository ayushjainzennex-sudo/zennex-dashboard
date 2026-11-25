// Segmented controls (.seg): one pill slides under the pressed option.
//
// The pill moves on a spring rather than a fixed-length CSS transition, so it can be interrupted: click another
// option mid-slide and it turns towards the new one from wherever it is, keeping its speed. It stretches a
// little in the direction it's moving, more the faster it goes.
//
// The pill can also be dragged: press on the selected option and slide. It follows the pointer, takes the width
// of the option under it, and on release snaps to that option and selects it (a normal click on it). A press
// that doesn't move is an ordinary click.
//
// The pill is the ::before of .seg, styled in style.css from --sx/--sw (position and width), --sy/--sh, and
// --ss/--sv (stretch).

const state = new WeakMap();
const reduce = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : {matches:false};
const DRAG_START = 4;   // px of movement before a press becomes a drag

const get = seg => {
  let s = state.get(seg);
  if (!s) state.set(seg, s = {x:0, w:0, vx:0, vw:0, tx:0, tw:0, frame:0, placed:false, drag:null});
  return s;
};
const options = seg => [...seg.children].filter(b => b.tagName === 'BUTTON');

function write(seg, s) {
  const stretch = Math.min(.18, Math.abs(s.vx) / 4000);
  seg.style.setProperty('--sx', s.x.toFixed(2)+'px');
  seg.style.setProperty('--sw', s.w.toFixed(2)+'px');
  seg.style.setProperty('--ss', (1 + stretch).toFixed(4));
  seg.style.setProperty('--sv', (1 - stretch * .35).toFixed(4));
}

function snap(seg, s) { s.x = s.tx; s.w = s.tw; s.vx = s.vw = 0; write(seg, s); }

// Springs position and width towards their targets until both settle.
function animate(seg) {
  const s = get(seg);
  if (s.frame) return;
  let last = performance.now();
  const step = now => {
    const dt = Math.min(.032, (now - last) / 1000); last = now;
    const k = s.drag ? 900 : 380, c = s.drag ? 60 : 30;   // stiffer and calmer while following a finger
    s.vx += (-k * (s.x - s.tx) - c * s.vx) * dt; s.x += s.vx * dt;
    s.vw += (-k * (s.w - s.tw) - c * s.vw) * dt; s.w += s.vw * dt;
    const settled = !s.drag && Math.abs(s.x - s.tx) < .3 && Math.abs(s.vx) < 5 && Math.abs(s.w - s.tw) < .3 && Math.abs(s.vw) < 5;
    if (settled || !seg.isConnected) { snap(seg, s); s.frame = 0; return; }
    write(seg, s);
    s.frame = requestAnimationFrame(step);
  };
  s.frame = requestAnimationFrame(step);
}

// Moves the pill to the pressed option (springing there, or at once when `move` is false).
export function placeSeg(seg, move = true) {
  const on = seg.querySelector(':scope > [aria-pressed=true]');
  if (!on) { seg.style.setProperty('--sw', '0px'); return; }
  const s = get(seg);
  s.tx = on.offsetLeft; s.tw = on.offsetWidth;
  seg.style.setProperty('--sy', on.offsetTop+'px'); seg.style.setProperty('--sh', on.offsetHeight+'px');
  if (s.drag?.moved) return;   // mid-drag: the drag decides where it goes
  if (!move || !s.placed || reduce.matches) { if (!s.frame) snap(seg, s); else { s.x = s.tx; s.w = s.tw; } }
  else animate(seg);
  s.placed = true;
  seg.classList.add('seg-ready');
}

// ---- dragging ----
const localX = (seg, e) => e.clientX - seg.getBoundingClientRect().left - seg.clientLeft + seg.scrollLeft;
const under = (seg, s) => {
  const mid = s.x + s.w / 2, list = options(seg);
  return list.find(b => mid >= b.offsetLeft && mid < b.offsetLeft + b.offsetWidth)
    ?? list.reduce((a, b) => Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid) < Math.abs(a.offsetLeft + a.offsetWidth / 2 - mid) ? b : a);
};
let suppressClick = false;

function onDown(e) {
  if (active) onUp({pointerId:active.drag.id, type:'pointercancel'});   // a release we never saw: end that drag first
  const btn = e.target.closest?.('.seg > button[aria-pressed=true]');
  if (!btn || e.button !== 0 || btn.disabled) return;
  const seg = btn.parentElement, s = get(seg);
  if (!s.placed) return;
  s.drag = {id:e.pointerId, startX:e.clientX, grab:localX(seg, e) - s.x, moved:false, seg};
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
  addEventListener('blur', cancel);
  active = s;
}

let active = null;
const cancel = () => active && onUp({pointerId:active.drag.id, type:'pointercancel'});   // window lost focus mid-drag
function onMove(e) {
  const s = active;
  if (!s || e.pointerId !== s.drag.id) return;
  const {seg} = s.drag;
  if (!s.drag.moved) {
    if (Math.abs(e.clientX - s.drag.startX) < DRAG_START) return;
    s.drag.moved = true;
    try { seg.setPointerCapture(e.pointerId); } catch {}
    seg.classList.add('seg-dragging');
  }
  const list = options(seg), first = list[0], end = list.at(-1).offsetLeft + list.at(-1).offsetWidth;
  const over = under(seg, s);
  s.tw = over.offsetWidth;
  s.tx = Math.max(first.offsetLeft, Math.min(end - s.tw, localX(seg, e) - s.drag.grab));
  list.forEach(b => b.classList.toggle('seg-under', b === over));
  animate(seg);
}

function onUp(e) {
  const s = active;
  if (!s || e.pointerId !== s.drag.id) return;
  removeEventListener('pointermove', onMove);
  removeEventListener('pointerup', onUp);
  removeEventListener('pointercancel', onUp);
  removeEventListener('blur', cancel);
  active = null;
  const {seg, moved} = s.drag;
  if (!moved) { s.drag = null; return; }   // a plain click: let it through
  const target = under(seg, s);
  s.drag = null;
  seg.classList.remove('seg-dragging');
  options(seg).forEach(b => b.classList.remove('seg-under'));
  // the browser's own click after a drag would land on the wrong thing; swallow it, then select the option
  suppressClick = true; setTimeout(() => { suppressClick = false; });
  if (e.type === 'pointerup' && target.getAttribute('aria-pressed') !== 'true' && !target.disabled) target.click();
  placeSeg(seg);
}

export function installSeg() {
  if (typeof document === 'undefined') return;
  new MutationObserver(list => {
    const segs = new Set();
    for (const m of list) {
      if (m.type === 'attributes') { const seg = m.target.parentElement; if (seg?.classList.contains('seg')) segs.add(seg); }
      else for (const n of m.addedNodes) if (n.nodeType === 1) (n.classList.contains('seg') ? [n] : n.querySelectorAll('.seg')).forEach(x => placeSeg(x, false));
    }
    segs.forEach(x => placeSeg(x));
  }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['aria-pressed']});
  addEventListener('resize', () => document.querySelectorAll('.seg').forEach(x => placeSeg(x, false)));
  document.fonts?.ready.then(() => document.querySelectorAll('.seg').forEach(x => placeSeg(x, false)));
  document.querySelectorAll('.seg').forEach(x => placeSeg(x, false));
  addEventListener('pointerdown', onDown);
  addEventListener('click', e => { if (suppressClick && e.isTrusted) { e.preventDefault(); e.stopPropagation(); } }, true);
}
