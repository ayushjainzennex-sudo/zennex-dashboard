// Glass support (after Vadik Matveev's liquid glass switcher).
//
// Glass elements use
//   backdrop-filter: blur(8px) url(#…) saturate(150%)
// where the url() filter bends the blurred page near the element's edge. Each size and corner shape needs its
// own displacement map. Only Chromium renders url() inside backdrop-filter, so the class "lg-refract" turns it
// on there; other browsers get blur + tint.
//
// Keeping it cheap:
//  - one SVG filter per size, shared by every element of that size (e.g. all buttons in a table row)
//  - maps are saved as PNGs in the browser's Cache Storage, so a reload reuses them instead of redrawing
//  - a map is only made once the element is on screen, in idle time, and only its rim is computed
//  - glass inside another glass panel gets no map (its backdrop is the flat panel, nothing to bend; the CSS
//    drops its blur too)
//  - while the page scrolls, the bending pauses on everything except the top bar and overlays ("lg-moving")
//  - on low-end devices or with Data Saver only the top bar, overlays and tab switchers bend ("lg-lite")
//  - resizes are debounced, and unused filters and images are released
//
// Also: "scrolled" on <html> once the page has moved (the top bar turns into a floating panel), and
// "lg-solid" for anyone who asked their system for less transparency.

const NS = 'http://www.w3.org/2000/svg';
const OVERLAY = '.modal,.palette,.toast';
const PANEL = OVERLAY + ',.sidebar,.topbar,.card,.channel-card,.kpi,.hero,.projection,.explain,.budget,.period,.db-status';
// The glass surfaces: overlays, the top bar and the segmented-control pill (cards and controls are solid).
const SEL = OVERLAY + ',.topbar,.seg';
const KEEP_LITE = OVERLAY + ',.topbar,.seg';   // still bends in lite mode
const BAND = .16;   // refracting rim width, as a share of the element's shorter side (clamped to 8–32px)
const PULL = .9;    // at the very edge, how far inwards the page is pulled, as a share of the rim width
const CURVE = 2.2;  // how steeply the bending rises towards the edge
const VERSION = `v2-${BAND}-${PULL}-${CURVE}`;   // changes when the map formula does, so old saved maps are ignored
const MAX_FILTERS = 150;

const bandOf = (w, h) => Math.max(8, Math.min(32, Math.min(w, h) * BAND));

// Signed distance to a rounded rectangle centred on 0 (negative inside) and the outward direction there.
// `p` is the corner's exponent: 2 for a circular corner, 4 for CSS `corner-shape: squircle`.
function edge(px, py, hw, hh, r, p) {
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
  let nx, ny, d;
  if (qx > 0 && qy > 0) {
    d = Math.pow(Math.pow(qx, p) + Math.pow(qy, p), 1 / p) - r;
    const gx = Math.pow(qx, p - 1), gy = Math.pow(qy, p - 1), gl = Math.hypot(gx, gy) || 1;
    nx = gx / gl; ny = gy / gl;
  }
  else if (qx > qy) { d = qx - r; nx = 1; ny = 0; }
  else { d = qy - r; nx = 0; ny = 1; }
  return [d, nx * Math.sign(px || 1), ny * Math.sign(py || 1)];
}

// Draws the map as a PNG blob. Only the rim is computed; the middle is flat grey (no bending).
function makeMap(w, h, r, p) {
  const hw = w / 2, hh = h / 2, band = bandOf(w, h);
  const img = new ImageData(w, h), m = Math.ceil(band + r + 2), d8 = img.data;
  for (let i = 0; i < d8.length; i += 4) { d8[i] = d8[i + 1] = d8[i + 2] = 128; d8[i + 3] = 255; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y >= m && y < h - m && x === m) x = Math.max(m, w - m);   // skip the flat middle of the row
    const i = (y * w + x) * 4;
    const [d, nx, ny] = edge(x + .5 - hw, y + .5 - hh, hw, hh, r, p), into = -d;
    const cover = Math.min(1, Math.max(0, .5 + into));            // anti-aliased edge
    const k = cover ? Math.pow(Math.max(0, 1 - Math.max(0, into) / band), CURVE) * cover : 0;
    d8[i] = 128 - nx * k * 127; d8[i + 1] = 128 - ny * k * 127;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(img, 0, 0);
    return c.convertToBlob({type:'image/png'});
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(img, 0, 0);
  return new Promise((ok, fail) => c.toBlob(b => b ? ok(b) : fail(), 'image/png'));
}

// ---- saved maps (Cache Storage; skipped where it isn't available) ----
let store;
const openStore = () => store ||= ('caches' in self ? caches.open('lg-maps').catch(() => null) : Promise.resolve(null));
const reqFor = key => `/__lg/${VERSION}/${key}.png`;
async function loadBlob(key, w, h, r, p) {
  const c = await openStore();
  const hit = c && await c.match(reqFor(key)).catch(() => null);
  if (hit) return hit.blob();
  const blob = await makeMap(w, h, r, p);
  c?.put(reqFor(key), new Response(blob, {headers:{'content-type':'image/png'}})).catch(() => {});
  return blob;
}
// drop maps from older versions, and keep the store to a few hundred sizes
async function tidyStore() {
  const c = await openStore(); if (!c) return;
  const keys = await c.keys();
  const cur = keys.filter(r => r.url.includes(`/__lg/${VERSION}/`));
  const drop = [...keys.filter(r => !cur.includes(r)), ...cur.slice(0, Math.max(0, cur.length - 400))];
  drop.forEach(r => c.delete(r));
}

// ---- shared filters: one per size key ----
let defs, seq = 0;
const filters = new Map();   // key → {ready: Promise<id>, el, url, users: Set}

function acquire(key, w, h, r, p) {
  let f = filters.get(key);
  if (!f) {
    f = {users:new Set()};
    f.ready = loadBlob(key, w, h, r, p).then(async blob => {
      const url = f.url = URL.createObjectURL(blob);
      const i = new Image(); i.src = url; await i.decode();   // until it's decoded the filter would render nothing
      const el = f.el = document.createElementNS(NS, 'filter');
      el.id = 'lg' + (++seq);
      for (const [k, v] of Object.entries({x:0, y:0, width:w, height:h, filterUnits:'userSpaceOnUse', primitiveUnits:'userSpaceOnUse', 'color-interpolation-filters':'sRGB'})) el.setAttribute(k, v);
      el.innerHTML = `<feImage href="${url}" x="0" y="0" width="${w}" height="${h}" result="map"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${(bandOf(w, h) * PULL * 2).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"/>`;
      defs.appendChild(el);
      return el.id;
    });
    f.ready.catch(() => filters.delete(key));
  }
  filters.delete(key); filters.set(key, f);   // most recently used goes last
  return f;
}

function release(key, el) {
  const f = filters.get(key);
  if (!f) return;
  f.users.delete(el);
  for (const [k, g] of filters) {   // oldest first
    if (filters.size <= MAX_FILTERS) break;
    if (g.users.size || !g.el) continue;
    g.el.remove(); URL.revokeObjectURL(g.url); filters.delete(k);
  }
}

// ---- elements ----
const state = new WeakMap();   // element → {key, visible, dirty}
let ro, io, lite = false;

function draw(el) {
  const s = state.get(el);
  if (!s || !el.isConnected) return;
  s.dirty = false;
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h) return;
  const cs = getComputedStyle(el);
  const r = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2);
  const p = /squircle|superellipse\(\s*2\s*\)/.test(cs.getPropertyValue('corner-top-left-shape')) ? 4 : 2;
  const key = [w, h, Math.round(r * 2) / 2, p].join('-');
  if (s.key === key) return;
  if (s.key) release(s.key, el);
  s.key = key;
  const f = acquire(key, w, h, r, p);
  f.users.add(el);
  f.ready.then(id => {
    if (s.key !== key || !el.isConnected) return;
    el.style.setProperty('--lg-map', `url(#${id})`);
    el.classList.add('lg-on');
  }, () => {});
}

function forget(el) {
  const s = state.get(el);
  if (!s) return;
  if (s.key) release(s.key, el);
  state.delete(el); ro.unobserve(el); io.unobserve(el);
}

// queues: overlays and resizes go on the next frame, first sightings wait for idle time
let soon = new Set(), later = new Set(), frame = 0, idle = 0;
const idleCb = (fn, o) => self.requestIdleCallback ? requestIdleCallback(fn, o) : setTimeout(fn, 60);
const run = q => q.forEach(e => e.isConnected ? draw(e) : forget(e));
function schedule(el, urgent) {
  if (urgent) { soon.add(el); frame ||= requestAnimationFrame(() => { frame = 0; const q = soon; soon = new Set(); run(q); }); }
  else { later.add(el); idle ||= idleCb(() => { idle = 0; const q = later; later = new Set(); run(q); }, {timeout:500}); }
}

const timers = new WeakMap();

export function installGlass() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-transparency: reduce)').matches;
  if (reduce) root.classList.add('lg-solid');

  const brands = navigator.userAgentData?.brands?.map(b => b.brand).join(' ') ?? '';
  if (!reduce && /Chromium|Google Chrome|Microsoft Edge/.test(brands)) {
    root.classList.add('lg-refract');
    lite = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4 || !!navigator.connection?.saveData;
    if (lite) root.classList.add('lg-lite');

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs); document.body.appendChild(svg);

    // size changes: redraw once the size settles (debounced), and only if the element is on screen
    ro = new ResizeObserver(entries => entries.forEach(({target:el}) => {
      const s = state.get(el); if (!s) return;
      if (!s.key) { if (s.visible) schedule(el, el.matches(OVERLAY)); return; }
      s.dirty = true;
      if (!s.visible) return;
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(() => s.dirty && schedule(el, true), 150));
    }));
    // on-screen tracking: bending only renders for visible elements, and maps are made on first sight
    io = new IntersectionObserver(entries => entries.forEach(({target:el, isIntersecting:on}) => {
      const s = state.get(el); if (!s) return;
      s.visible = on;
      el.classList.toggle('lg-vis', on);
      if (on && (!s.key || s.dirty)) schedule(el, false);
    }), {rootMargin:'150px'});

    const scan = node => {
      if (node.nodeType !== 1) return;
      (node.matches(SEL) ? [node] : node.querySelectorAll(SEL)).forEach(el => {
        if (state.has(el)) return;
        if (el.parentElement?.closest(PANEL)) return;   // glass on glass: nothing behind it to bend
        if (lite && !el.matches(KEEP_LITE)) return;
        const overlay = el.matches(OVERLAY);
        state.set(el, {key:null, visible:overlay, dirty:false});
        ro.observe(el);
        if (overlay) { el.classList.add('lg-vis'); schedule(el, true); }
        else io.observe(el);
      });
    };
    new MutationObserver(list => {
      for (const m of list) {
        m.addedNodes.forEach(scan);
        m.removedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          (n.matches(SEL) ? [n] : n.querySelectorAll(SEL)).forEach(forget);
        });
      }
    }).observe(document.body, {childList:true, subtree:true});
    scan(document.body);
    idleCb(() => tidyStore().catch(() => {}), {timeout:5000});

    // pause bending while anything scrolls (it can't be seen in motion and is the costliest part to repaint)
    let still;
    addEventListener('scroll', () => {
      root.classList.add('lg-moving');
      clearTimeout(still); still = setTimeout(() => root.classList.remove('lg-moving'), 160);
    }, {passive:true, capture:true});
  }

  let on = null;
  const check = () => { const s = scrollY > 8; if (s !== on) { on = s; root.classList.toggle('scrolled', s); } };
  addEventListener('scroll', check, {passive:true}); check();
}
