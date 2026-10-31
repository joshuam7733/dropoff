/* Drop Off — shared UI layer: rendering loop, UI state, toasts, async runner and reusable components. */
(function () {
  const D = window.DO;
  const { h, render } = window.preact;
  const html = (D.html = window.htm.bind(h));
  const S = D.store, F = D.fmt;

  /* ---------------- UI state (per viewer, not part of the shared store) ---------------- */
  const U = (D.ui = {
    busy: {},
    toasts: { vendor: [], rider: [], recipient: [], ops: [], auth: [], global: [] },
    vendor: { screen: 'home', params: {}, stack: [] },
    rider: { screen: 'home', params: {}, stack: [] },
    recipient: { screen: 'track', params: {}, stack: [] },
    auth: { screen: 'welcome', params: {}, stack: [] },
    ops: { tab: 'live', sel: null, filter: 'all', q: '', netTab: 'riders', txFilter: 'all', txQ: '' },
    tmpOf: { vendor: {}, rider: {}, recipient: {}, ops: {}, auth: {} }
  });
  const persistUI = () => {};

  let raf = null, root = null, AppComp = null;
  D.mount = (el, Comp) => { root = el; AppComp = Comp; D.rerender(); };
  D.rerender = () => {
    if (raf) return;
    // requestAnimationFrame pauses in background panes and WebViews; a timer guarantees the render still happens.
    const run = () => { if (!raf) return; cancelAnimationFrame(raf.a); clearTimeout(raf.t); raf = null; if (root) render(html`<${AppComp} />`, root); persistUI(); };
    raf = { a: requestAnimationFrame(run), t: setTimeout(run, 60) };
  };
  S.subscribe(() => D.rerender());

  /* navigation inside a device */
  D.nav = (dev, screen, params) => {
    const s = U[dev];
    s.stack.push({ screen: s.screen, params: s.params });
    if (s.stack.length > 30) s.stack.shift();
    s.screen = screen; s.params = params || {};
    U.tmpOf[dev] = {};
    D.rerender();
    const sc = document.querySelector('[data-dev="' + dev + '"] .app-scroll');
    if (sc) sc.scrollTop = 0;
  };
  D.home = (dev, screen, params) => { const s = U[dev]; s.stack = []; s.screen = screen; s.params = params || {}; U.tmpOf[dev] = {}; D.rerender(); };
  D.back = (dev, fallback) => {
    const s = U[dev];
    const prev = s.stack.pop();
    if (prev) { s.screen = prev.screen; s.params = prev.params; } else { s.screen = fallback || 'home'; s.params = {}; }
    U.tmpOf[dev] = {};
    D.rerender();
  };

  /* toasts */
  let tid = 0;
  D.toast = (dev, body, kind, title) => {
    const list = U.toasts[dev] || U.toasts.global;
    const t = { id: ++tid, body, kind: kind || 'info', title };
    list.push(t);
    if (list.length > 2) list.shift();
    D.rerender();
    setTimeout(() => { const i = list.indexOf(t); if (i >= 0) { list.splice(i, 1); D.rerender(); } }, kind === 'err' ? 5200 : 3800);
  };
  // New notifications for the signed-in user arrive with each snapshot and show as toasts.
  S.onNotify((n) => {
    const role = S.me() && S.me().role;
    if (n.aud === 'rider' && n.kind === 'offer') return;
    const dev = role === 'vendor' ? 'vendor' : role === 'rider' ? 'rider' : 'global';
    D.toast(dev, n.body, n.kind === 'bad' ? 'err' : 'info', n.title);
  });

  /* async runner: loading state on the button, server errors as toasts */
  D.run = async (key, fn, o) => {
    const opts = o || {};
    if (U.busy[key]) return undefined;
    U.busy[key] = true; D.rerender();
    try {
      const out = await fn();
      if (opts.ok) D.toast(opts.dev || 'global', opts.ok, 'ok');
      return out == null ? true : out; // void server functions return null: still a success
    } catch (e) {
      D.toast(opts.dev || 'global', e.message || 'Something went wrong. Try again.', 'err');
      if (!(e instanceof D.UserError)) console.error(e);
      return undefined;
    } finally { delete U.busy[key]; D.rerender(); }
  };
  D.busy = (key) => !!U.busy[key];

  /* ---------------- icons ---------------- */
  const P = {
    home: 'M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z', box: 'M4 7.5 12 4l8 3.5v9L12 20l-8-3.5zM4 7.5l8 3.5 8-3.5M12 11v9', plus: 'M12 5v14M5 12h14',
    wallet: 'M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1V7zM4 7l11-3v3M16 13.5h.01', user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.5-4 4.5-5.5 8-5.5s6.5 1.5 8 5.5',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4', search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM16 16l4 4', chevR: 'M9 6l6 6-6 6', chevL: 'M15 6l-6 6 6 6', chevD: 'M6 9l6 6 6-6',
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z', msg: 'M4 5h16v11H9l-5 4z',
    pin: 'M12 21s7-6 7-11.5A7 7 0 0 0 5 9.5C5 15 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2',
    check: 'M5 12.5l4.5 4.5L19 7.5', camera: 'M4 8h3.5L9 5.5h6L16.5 8H20v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', shield: 'M12 3.5 19 6v6c0 4.5-3 7.5-7 8.5-4-1-7-4-7-8.5V6zM9 12l2 2 4-4',
    x: 'M6 6l12 12M18 6 6 18', share: 'M12 15V4M8 8l4-4 4 4M5 13v7h14v-7', help: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
    receipt: 'M6 3.5h12v17l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6', lock: 'M5 10h14v10H5zM8 10V7.5a4 4 0 0 1 8 0V10', bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6z',
    alert: 'M12 4 21 19.5H3zM12 10v4M12 17h.01', power: 'M12 3.5v8M7 6.5a7.5 7.5 0 1 0 10 0', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', sign: 'M4 20h16M6 16l9.5-9.5 2.5 2.5L8.5 18.5H6z',
    building: 'M4 20V5h10v15M14 9h6v11M7.5 8.5h3M7.5 12h3M7.5 15.5h3M3 20h18', card: 'M3 5.5h18v13H3zM3 10h18M7 15h4', arrowUp: 'M12 19V5M6 11l6-6 6 6', arrowDown: 'M17 7 7 17M7 9v8h8', arrowOut: 'M7 17 17 7M9 7h8v8',
    nav: 'M12 3l7 17-7-4-7 4z', turnL: 'M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v2', upright: 'M12 20V4M7 9l5-5 5 5', glass: 'M8 3.5h8l-.5 6a3.5 3.5 0 0 1-7 0zM12 13v7M9 20.5h6',
    flag: 'M5 21V4h11l-2 4 2 4H5', refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', upload: 'M7 3.5h7l4 4v13H7zM14 3.5v4h4M12.5 17v-6M10 13.5l2.5-2.5 2.5 2.5', star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
    users: 'M9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 19c1-3.5 3.3-5 6-5s5 1.5 6 5M16 5.5a3.5 3.5 0 0 1 0 6.5M18 14c1.6.6 2.6 2.2 3 5', settings: 'M4 6h16M7 12h10M10 18h4', forward: 'M5 5l7 7-7 7M12 5l7 7-7 7', send: 'M12 19V5M6 11l6-6 6 6'
  };
  D.Icon = ({ n, s, c, w, fill }) => html`<svg width=${s || 20} height=${s || 20} viewBox="0 0 24 24" fill=${fill || 'none'} stroke=${c || 'currentColor'} stroke-width=${w || 2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[n] || ''} /></svg>`;
  const VP = {
    boda: html`<circle cx="5.5" cy="16.5" r="3" /><circle cx="18.5" cy="16.5" r="3" /><path d="M5.5 16.5 9 10.5h5l4.5 6M12.5 10.5 11.5 7h3" />`,
    car: html`<path d="M3 16.5V12l2.2-4.5h9.6L18.5 12H21v4.5h-1.5M9 16.5h6M4.5 16.5H3" /><circle cx="7" cy="16.5" r="2" /><circle cx="17" cy="16.5" r="2" />`,
    minivan: html`<path d="M2.5 16.5v-8A1.5 1.5 0 0 1 4 7h11l4.5 5H21v4.5h-1.5M9 16.5h6M4.5 16.5h-2M2.5 11.5h17" /><circle cx="7" cy="16.5" r="2" /><circle cx="17" cy="16.5" r="2" />`,
    pickup: html`<path d="M2.5 16.5V11h9V7h5l3 4h2v5.5h-1.5M8.5 16.5h6.5M4.5 16.5h-2" /><circle cx="6.5" cy="16.5" r="2" /><circle cx="17" cy="16.5" r="2" />`,
    truck: html`<path d="M2 16.5V5.5h12v11M14 9h4l3.5 4v3.5h-1.5M8 16.5h7M4 16.5H2" /><circle cx="6" cy="16.5" r="2" /><circle cx="17.5" cy="16.5" r="2" />`
  };
  D.VIcon = ({ c, s, color }) => html`<svg width=${s || 24} height=${s || 24} viewBox="0 0 24 24" fill="none" stroke=${color || 'currentColor'} stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${VP[c]}</svg>`;
  D.Logo = ({ s, inv }) => html`<svg width=${s || 28} height=${s || 28} viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill=${inv ? '#0D2B23' : '#FFB71B'} /><path d="M16 5.5c-4.3 0-7.8 3.3-7.8 7.6 0 5.5 7.8 12.4 7.8 12.4s7.8-6.9 7.8-12.4c0-4.3-3.5-7.6-7.8-7.6z" fill=${inv ? '#FFB71B' : '#0D2B23'} /><path d="M12.6 11.6 16 15l3.4-3.4" fill="none" stroke=${inv ? '#0D2B23' : '#FFB71B'} stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

  /* ---------------- small components ---------------- */
  const Icon = D.Icon;
  D.Chip = ({ status, label }) => {
    const m = D.STATUS[status] || { label: status, tone: 'grey' };
    return html`<span class=${'chip ' + m.tone}>${m.tone === 'ok' ? html`<${Icon} n="check" s="12" w="3.2" />` : html`<span class="d"></span>`}${label || m.label}</span>`;
  };
  D.Progress = ({ status }) => {
    const seg = (D.STATUS[status] || {}).seg || 0;
    const live = ['in_transit', 'approaching', 'arrived', 'awaiting_confirmation', 'picked_up'].includes(status);
    return html`<div class="progress4" role="img" aria-label=${'Progress: ' + (D.STATUS[status] || {}).label}>${[1, 2, 3, 4].map((i) => html`<i class=${i < seg || (i === seg && !live) ? 'on' : i === seg && live ? 'cur' : ''}></i>`)}</div>`;
  };
  D.Btn = ({ kind, busy, disabled, onClick, children, cls, label, type }) => html`<button type=${type || 'button'} class=${'btn ' + (kind || '') + ' ' + (cls || '')} disabled=${disabled || busy} onClick=${onClick} aria-busy=${busy ? 'true' : 'false'}>${busy ? html`<span class="spin"></span>` : null}${busy && label ? label : children}</button>`;
  D.Back = ({ dev, fallback, dark }) => html`<button class=${'iconbtn' + (dark ? '' : ' ')} aria-label="Back" onClick=${() => D.back(dev, fallback)}><${Icon} n="chevL" s="22" /></button>`;
  D.Toggle = ({ on, onClick, label }) => html`<button class="toggle" role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${label} onClick=${onClick}></button>`;
  D.Avatar = ({ name, s, bg }) => html`<span style=${'width:' + (s || 44) + 'px;height:' + (s || 44) + 'px;border-radius:50%;background:' + (bg || '#E4EFEA') + ';color:#0D2B23;display:flex;align-items:center;justify-content:center;font-family:var(--f-display);font-weight:800;font-size:' + Math.round((s || 44) / 2.9) + 'px;flex-shrink:0'}>${F.initials(name)}</span>`;
  D.Empty = ({ icon, title, body, action }) => html`<div class="empty"><div style="display:flex;justify-content:center;margin-bottom:8px;opacity:0.6"><${Icon} n=${icon || 'box'} s="30" /></div><div style="font-weight:700;color:var(--ink);font-size:15px">${title}</div><div style="margin-top:4px">${body}</div>${action ? html`<div style="margin-top:12px;display:flex;justify-content:center">${action}</div>` : null}</div>`;

  D.Timeline = ({ events, dark, max }) => {
    const ev = (events || []).slice().reverse().slice(0, max || 100);
    return html`<div class="timeline">${ev.map((e, i) => html`<div class="tl"><div class="rail"><i style=${e.type === 'delivered' ? 'background:var(--ok)' : /fail|wrong|cancel|dispute|no_driver|late|issue/.test(e.type) ? 'background:var(--bad)' : ''}></i>${i < ev.length - 1 ? html`<b></b>` : null}</div><div class="body"><div style="min-width:0"><div class="t1">${e.label}</div><div class="t2">${e.actor ? e.actor.name : ''}${e.lat != null ? ' · GPS ' + (+e.lat).toFixed(4) + ', ' + (+e.lng).toFixed(4) : ''}</div></div><span class="t2" style="white-space:nowrap">${F.time(e.ts)}</span></div></div>`)}</div>`;
  };

  /* PIN pad: four boxes + on-screen keypad (works on touch and mouse) */
  D.PinPad = ({ value, get, onChange, state, dark, reveal }) => {
    const v = value || '';
    // Read the live value so quick taps between renders never drop a digit.
    const press = (k) => { const cur = (get ? get() : v) || ''; if (k === 'del') onChange(cur.slice(0, -1)); else if (cur.length < 4) onChange(cur + k); };
    return html`<div style="display:flex;flex-direction:column;gap:10px">
      <div class="pinboxes" aria-label=${'PIN entered: ' + v.length + ' of 4 digits'}>${[0, 1, 2, 3].map((i) => html`<div class=${'pinbox ' + (state === 'bad' ? 'bad' : state === 'ok' ? 'ok' : i < v.length ? 'f' : i === v.length ? 'cur' : '')}>${v[i] ? (reveal === false ? '•' : v[i]) : ''}</div>`)}</div>
      <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => k === '' ? html`<span></span>` : html`<button type="button" aria-label=${k === 'del' ? 'Delete digit' : 'Digit ' + k} onClick=${() => press(k)}>${k === 'del' ? html`<${Icon} n="chevL" s="20" />` : k}</button>`)}</div>
    </div>`;
  };

  /* Photos live in private storage buckets; PhotoView signs a URL on demand. Nothing is drawn in place of a missing photo. */
  D.mediaSrc = (m) => (m && m.src ? m.src : m && m.path && D.api ? D.api.mediaUrl(m) : null);
  D.PhotoView = ({ photo, h: hh, label }) => {
    const height = hh || 110;
    const src = D.mediaSrc(photo);
    const stamp = photo && photo.ts ? html`<span style="position:absolute;left:8px;bottom:8px;font-size:10px;font-weight:700;color:#fff;background:rgba(13,43,35,0.8);padding:3px 7px;border-radius:999px">${F.time(photo.ts)}</span>` : null;
    if (src) return html`<div class="photo" style=${'height:' + height + 'px'}><img src=${src} alt=${label || 'Photo'} />${stamp}</div>`;
    return html`<div class="photo" style=${'height:' + height + 'px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:#5F6C67;font-size:12px;text-align:center;padding:6px'} role="img" aria-label=${label || 'Photo'}>
      <${Icon} n="camera" s="20" />${src === undefined ? 'Loading photo…' : photo ? 'Photo not available' : 'No photo'}${stamp}</div>`;
  };
  // Reads an image file (camera or gallery) and returns a compressed JPEG ready to upload.
  D.readImage = (file, max) => new Promise((ok, bad) => {
    if (!file || !/^image\//.test(file.type)) return bad(new D.UserError("That file isn't an image we can read. Try a JPG or PNG."));
    if (file.size > 15 * 1024 * 1024) return bad(new D.UserError('That photo is over 15 MB. Choose a smaller one.'));
    const fr = new FileReader();
    fr.onerror = () => bad(new D.UserError("We couldn't read that photo. Try again."));
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, (max || 1280) / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const src = c.toDataURL('image/jpeg', 0.8);
        ok({ src, blob: D.api.dataUrlToBlob(src), ts: Date.now() });
      };
      img.onerror = () => bad(new D.UserError("That file isn't an image we can read. Try a JPG or PNG."));
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
  D.PhotoCapture = ({ id, photo, onPhoto, dark, label, busy }) => {
    const pick = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) D.readImage(f).then(onPhoto, (err) => D.toast('global', err.message, 'err')); };
    return html`<div style="display:flex;gap:10px;align-items:stretch">
    ${photo ? html`<div style="width:120px;flex-shrink:0;position:relative" class="pop"><${D.PhotoView} photo=${photo} h=${100} label=${label} /><span style="position:absolute;right:-5px;top:-5px;width:24px;height:24px;border-radius:50%;background:var(--ok);color:#fff;display:flex;align-items:center;justify-content:center"><${Icon} n="check" s="13" w="3.4" /></span></div>` : null}
    <div style="flex:1;display:flex;flex-direction:column;gap:8px;justify-content:center">
      <label class=${'btn md ' + (photo ? 'ghost' : dark ? '' : 'ink')} for=${id + '-cam'} style="cursor:pointer" aria-busy=${busy ? 'true' : 'false'}>${busy ? html`<span class="spin"></span>` : html`<${Icon} n="camera" s="18" />`}${busy ? 'Uploading…' : photo ? 'Retake photo' : 'Take photo'}</label>
      <input id=${id + '-cam'} class="sr" type="file" accept="image/*" capture="environment" disabled=${busy} onChange=${pick} />
      <label class="linkbtn" style="text-align:center;cursor:pointer;font-size:13px" for=${id}>or upload from device</label>
      <input id=${id} class="sr" type="file" accept="image/*" disabled=${busy} onChange=${pick} />
    </div>
  </div>`;
  };

  /* Signature pad bound to a canvas through a ref callback */
  D.SignaturePad = ({ value, onChange }) => {
    const bind = (cv) => {
      if (!cv || cv._bound) return;
      cv._bound = true;
      const ctx = cv.getContext('2d');
      const fit = () => { const r = cv.getBoundingClientRect(); if (!r.width) return; const scale = r.width / cv.offsetWidth || 1; cv.width = cv.offsetWidth * 2; cv.height = cv.offsetHeight * 2; ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0D2B23'; void scale; };
      fit();
      if (typeof value === 'string' && value.startsWith('data:')) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, cv.offsetWidth, cv.offsetHeight); im.src = value; }
      let drawing = false, last = null, moved = false;
      const pos = (e) => { const r = cv.getBoundingClientRect(); const k = cv.offsetWidth / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
      cv.addEventListener('pointerdown', (e) => { drawing = true; moved = false; last = pos(e); cv.setPointerCapture(e.pointerId); });
      cv.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; moved = true; });
      const end = () => { if (drawing && moved) cv._onChange(cv.toDataURL('image/png')); drawing = false; };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      cv._clear = () => { ctx.clearRect(0, 0, cv.width, cv.height); cv._onChange(null); };
    };
    let canvasEl = null;
    return html`<div style="display:flex;flex-direction:column;gap:6px">
      <canvas class="sigpad" aria-label="Signature pad. Draw the recipient signature." ref=${(c) => { if (c) { c._onChange = onChange; canvasEl = c; bind(c); } }}></canvas>
      <div style="display:flex;justify-content:space-between;font-size:12px"><span class="cap">${value ? 'Signature captured' : 'Ask the recipient to sign above'}</span><button type="button" class="linkbtn" style="font-size:12px;padding:0" onClick=${() => canvasEl && canvasEl._clear && canvasEl._clear()}>Clear</button></div>
    </div>`;
  };
  D.SigView = ({ value, required }) => {
    if (!value) return html`<span class="cap">${required ? 'Missing' : 'Not required'}</span>`;
    const src = typeof value === 'string' ? value : D.mediaSrc(value);
    return src ? html`<img src=${src} alt="Signature" style="height:44px;max-width:150px;background:#fff;border-radius:6px" />` : html`<span class="cap">${src === undefined ? 'Loading…' : 'On file'}</span>`;
  };

  /* ---------------- live map (Leaflet + OpenStreetMap tiles) ----------------
     Real coordinates only: places, pickup/drop-off pins, the rider's last GPS fix, and anonymous driver
     supply per area. The line between stops is a straight guide; turn-by-turn comes from the phone's maps app. */
  const CFG = window.DO_CONFIG || {};
  // Default: OpenStreetMap's standard tiles (no key; fair-use policy, fine for development and pilots).
  // For production set DO_CONFIG.mapTiles to a commercial provider (MapTiler, Stadia, Mapbox…) with a key.
  // The dark style is the same tiles re-tinted in CSS (.lf-map.dark), so one provider covers both themes.
  const TILES = Object.assign({
    light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    dark: null,
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }, CFG.mapTiles || {});
  const KAMPALA = [0.3292, 32.5966];
  const DONE = ['delivered', 'cancelled', 'disputed'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ll = (p) => [p.lat, p.lng];
  const icon = (cls, inner, size) => window.L.divIcon({ className: 'lf ' + cls, html: inner || '', iconSize: size || [26, 26], iconAnchor: size ? [size[0] / 2, size[1] / 2] : [13, 13] });
  const VEH_SVG = (c) => '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    ({ boda: '<circle cx="5.5" cy="16.5" r="3"/><circle cx="18.5" cy="16.5" r="3"/><path d="M5.5 16.5 9 10.5h5l4.5 6M12.5 10.5 11.5 7h3"/>' }[c] ||
      '<path d="M3 16.5V12l2.2-4.5h9.6L18.5 12H21v4.5h-1.5M9 16.5h6M4.5 16.5H3"/><circle cx="7" cy="16.5" r="2"/><circle cx="17" cy="16.5" r="2"/>') + '</svg>';

  // Everything the map should draw, as plain data. A change in this signature is what triggers a redraw.
  function mapModel(p) {
    const s = S.state || { deliveries: [], riders: [] };
    const d = p.d, all = p.all;
    const r = p.rider || (d && d.riderId ? S.rider(d.riderId) : p.focusRider ? S.rider(p.focusRider) : null);
    const m = { pins: [], lines: [], riders: [], radar: [], supply: [], places: [], jobs: [] };
    if (d && !all) {
      const picked = ['picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation', 'delivered'].includes(d.status);
      if (S.geo.has(d.pickup)) m.pins.push({ k: 'pick', at: ll(d.pickup), faded: picked, label: d.pickup.name });
      if (S.geo.has(d.dropoff)) m.pins.push({ k: 'drop', at: ll(d.dropoff), label: d.dropoff.name });
      if (S.geo.has(d.pickup) && S.geo.has(d.dropoff)) m.lines.push({ k: picked ? 'route' : 'plan', pts: [ll(d.pickup), ll(d.dropoff)] });
      if (d.status === 'searching' && S.geo.has(d.pickup)) {
        m.radar.push(ll(d.pickup));
        S.candidates(d).filter((c) => c.rider.loc).slice(0, 6).forEach((c) => m.riders.push({ id: c.rider.id, at: ll(c.rider.loc), angle: c.rider.loc.angle, tone: 'idle', name: c.rider.name }));
      }
    }
    const showR = r && r.loc && !all && (!d || !DONE.includes(d.status));
    if (showR) {
      m.riders.push({ id: r.id, at: ll(r.loc), angle: r.loc.angle, tone: 'me', big: true, name: r.name, acc: r.loc.accuracy });
      if (d && d.leg) m.lines.push({ k: 'leg', pts: [ll(r.loc), ll(d.leg.kind === 'pickup' ? d.pickup : d.dropoff)] });
    }
    (p.extraPts || []).filter(S.geo.has).forEach((x) => m.jobs.push({ at: ll(x), label: x.name || '' }));
    if (all) {
      s.deliveries.filter((x) => D.ACTIVE.includes(x.status) && S.geo.has(x.pickup) && S.geo.has(x.dropoff)).forEach((x) => {
        m.lines.push({ k: p.selected === x.id ? 'sel' : 'net', id: x.id, pts: [ll(x.pickup), ll(x.dropoff)] });
        if (x.status === 'searching') m.jobs.push({ at: ll(x.pickup), id: x.id, label: x.id + ' · searching' });
      });
      const selRider = p.selected && S.delivery(p.selected) && S.delivery(p.selected).riderId;
      s.riders.filter((x) => x.verified && x.loc).forEach((x) => m.riders.push({ id: x.id, at: ll(x.loc), angle: x.loc.angle, name: x.name,
        tone: !x.online ? 'off' : x.activeId ? 'busy' : 'idle', sel: x.id === selRider }));
    }
    (p.supply || []).forEach((c) => m.supply.push({ at: [+c.lat, +c.lng], n: c.n, cls: c.cls }));
    if (p.places) D.PLACES.filter(S.geo.has).forEach((x) => m.places.push({ at: ll(x), label: x.name, area: x.area }));
    return m;
  }

  class LeafletMap extends window.preact.Component {
    componentDidMount() {
      if (!window.L || !this.el) return;
      const p = this.props;
      this.map = window.L.map(this.el, { zoomControl: false, attributionControl: true, scrollWheelZoom: true, zoomSnap: 0.5, minZoom: 6, maxZoom: 19 });
      window.L.control.zoom({ position: 'bottomright' }).addTo(this.map);
      this.map.attributionControl.setPrefix(false);
      window.L.tileLayer((p.dark && TILES.dark) || TILES.light, { attribution: TILES.attribution, subdomains: TILES.subdomains, maxZoom: 19 }).addTo(this.map);
      if (p.dark && !TILES.dark) this.el.classList.add('tint-dark');
      this.layer = window.L.layerGroup().addTo(this.map);
      const Fit = window.L.Control.extend({ onAdd: () => { const b = window.L.DomUtil.create('button', 'lf-fit'); b.type = 'button'; b.title = 'Fit the map to this delivery'; b.setAttribute('aria-label', 'Recentre map');
        b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="5"/></svg>';
        window.L.DomEvent.on(b, 'click', (e) => { window.L.DomEvent.stop(e); this.fit(true); }); return b; } });
      new Fit({ position: 'bottomright' }).addTo(this.map);
      this.map.setView(KAMPALA, 13);
      this.sync(true);
      // the frame can change size after mount (tabs, drawers); keep tiles filling the box
      if (window.ResizeObserver) { this.ro = new ResizeObserver(() => this.map && this.map.invalidateSize()); this.ro.observe(this.el); }
    }
    componentDidUpdate() { this.sync(false); }
    componentWillUnmount() { if (this.ro) this.ro.disconnect(); if (this.map) this.map.remove(); this.map = null; }
    shouldComponentUpdate(next) { return next.height !== this.props.height || next.dark !== this.props.dark || !!this.map; }
    fit(force) {
      const m = this.model;
      if (!this.map || !m) return;
      const pts = [...m.pins.map((x) => x.at), ...m.riders.filter((x) => x.big).map((x) => x.at), ...m.jobs.map((x) => x.at), ...(this.props.all ? m.riders.map((x) => x.at) : []),
        ...(this.props.all ? m.lines.flatMap((x) => x.pts) : []), ...(m.pins.length || m.riders.length ? [] : m.supply.map((x) => x.at))];
      if (!pts.length) { if (force) this.map.setView(KAMPALA, 13); return; }
      if (pts.length === 1) this.map.setView(pts[0], this.props.places || this.props.supply ? 13.5 : 15, { animate: force });
      else this.map.fitBounds(window.L.latLngBounds(pts), { padding: [36, 36], maxZoom: 16, animate: force });
    }
    sync(first) {
      if (!this.map) return;
      const p = this.props;
      const m = mapModel(p);
      const sig = JSON.stringify(m);
      const focus = (p.d ? p.d.id + ':' + p.d.status : '') + (p.focusRider || '') + (p.all ? 'all' : '') + (p.fitKey || '');
      if (sig === this.sig && focus === this.focus) return;
      this.model = m; this.sig = sig;
      const L = window.L, g = this.layer, dark = !!p.dark;
      g.clearLayers();
      m.places.forEach((x) => L.marker(x.at, { icon: icon('lf-place', '<i></i>', [12, 12]), keyboard: false }).bindTooltip('<b>' + esc(x.label) + '</b><br>' + esc(x.area), { direction: 'top' }).addTo(g));
      m.supply.forEach((x) => L.marker(x.at, { icon: icon('lf-supply', VEH_SVG(x.cls) + '<b>' + x.n + '</b>', [44, 26]), keyboard: false })
        .bindTooltip(x.n + ' ' + esc(S.cls(x.cls).label.toLowerCase()) + (x.n === 1 ? ' driver' : ' drivers') + ' free nearby', { direction: 'top' }).addTo(g));
      m.lines.forEach((x) => {
        const style = { plan: { color: dark ? '#FFB71B' : '#0D2B23', weight: 4, opacity: 0.85, dashArray: '2 9', lineCap: 'round' }, route: { color: dark ? '#FFB71B' : '#0D2B23', weight: 5, opacity: 0.9 },
          leg: { color: '#FFB71B', weight: 4, opacity: 1, dashArray: '1 8', lineCap: 'round' }, net: { color: '#0D2B23', weight: 3, opacity: 0.3 }, sel: { color: '#FFB71B', weight: 6, opacity: 1 } }[x.k];
        if (x.k === 'route' || x.k === 'sel') L.polyline(x.pts, { color: dark ? '#0B211B' : '#fff', weight: style.weight + 4, opacity: 0.9, interactive: false }).addTo(g);
        const line = L.polyline(x.pts, style).addTo(g);
        if (x.id && p.onDelivery) line.on('click', () => p.onDelivery(x.id));
      });
      m.radar.forEach((at) => L.marker(at, { icon: icon('lf-radar', '<i></i><i></i>', [120, 120]), interactive: false, keyboard: false }).addTo(g));
      m.jobs.forEach((x) => { const mk = L.marker(x.at, { icon: icon('lf-job', '<i></i>', [22, 22]) }).addTo(g); if (x.label) mk.bindTooltip(esc(x.label), { direction: 'top' }); if (x.id && p.onDelivery) mk.on('click', () => p.onDelivery(x.id)); });
      m.pins.forEach((x) => L.marker(x.at, { icon: x.k === 'pick' ? icon('lf-pick' + (x.faded ? ' faded' : ''), '<i></i>', [24, 24]) : icon('lf-drop', '<i></i>', [30, 30]), zIndexOffset: 500 })
        .bindTooltip((x.k === 'pick' ? 'Pickup · ' : 'Drop-off · ') + esc(x.label), { direction: 'top' }).addTo(g));
      m.riders.forEach((x) => {
        if (x.acc && x.acc < 400) L.circle(x.at, { radius: x.acc, color: '#FFB71B', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(g);
        const mk = L.marker(x.at, { icon: icon('lf-rider ' + x.tone + (x.big ? ' big' : '') + (x.sel ? ' sel' : ''), '<i style="transform:rotate(' + Math.round(x.angle || 0) + 'deg)"></i>', x.big ? [40, 40] : [28, 28]), zIndexOffset: 1000 })
          .bindTooltip(esc(x.name || 'Driver'), { direction: 'top' }).addTo(g);
        if (p.onRider) mk.on('click', () => p.onRider(x.id));
      });
      if (first || focus !== this.focus) this.fit(false);
      this.focus = focus;
    }
    render(p) {
      const h = p.all ? p.height || 430 : p.height || 360;
      if (!window.L) return html`<div class="map-wrap map-off" style=${'height:' + h + 'px'} role="img" aria-label=${p.label || 'Map'}><${Icon} n="pin" s="22" /><span>Map unavailable offline. Addresses and live status still update.</span></div>`;
      return html`<div class=${'map-wrap lf-map' + (p.dark ? ' dark' : '')} style=${'height:' + h + 'px'} role="region" aria-label=${p.label || 'Map'} ref=${(el) => { this.el = el; }}></div>`;
    }
  }
  D.MapView = (props) => html`<${LeafletMap} ...${props} />`;
  // Anonymous driver supply for the map, refreshed at most every 20 s while a map that asks for it is visible.
  let supply = { at: 0, data: [], busy: false };
  D.supply = () => {
    if (!S.state || supply.busy || Date.now() - supply.at < 20000) return supply.data;
    supply.busy = true;
    S.act.availableDrivers().then((d) => { supply = { at: Date.now(), data: d || [], busy: false }; D.rerender(); }, () => { supply = { ...supply, at: Date.now(), busy: false }; });
    return supply.data;
  };
  // Opens turn-by-turn navigation in the phone's maps app (Google Maps on Android, Apple Maps on iOS).
  D.navUrl = (p) => 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng + '&travelmode=driving';
})();
