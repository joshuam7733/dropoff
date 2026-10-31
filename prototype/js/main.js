/* Drop Off — application shell.
   Launch: the logo animation plays while the session is restored in the background; then the signed-out
   experience or the app for the user's role (read from the database, never from the URL) appears. */
(function () {
  const D = window.DO, html = D.html, S = D.store, U = D.ui, A = D.api;
  const PAGE = window.DO_PAGE || 'app'; // site | app | track

  /* ---------------- launch animation ---------------- */
  // The splash leaves when the logo animation has finished (its last element ends ~1.8 s after it
  // first paints) and the app is ready, whichever is later. Reduced-motion users don't wait for it.
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animDone = new Promise((done) => {
    const tag = document.querySelector('#splash .sp-tag');
    if (!tag || reduced) { setTimeout(done, reduced ? 300 : 0); return; }
    tag.addEventListener('animationend', () => setTimeout(done, 200), { once: true });
    setTimeout(done, 2600); // safety net if animations don't run (background tab, old WebView)
  });
  function hideSplash() {
    const el = document.getElementById('splash');
    if (!el || el.dataset.out) return;
    el.dataset.out = '1';
    animDone.then(() => { el.classList.add('out'); setTimeout(() => el.remove(), 420); });
  }
  setTimeout(hideSplash, 3000); // never hold the user longer than this; screens show their own loading state

  /* ---------------- frames ---------------- */
  const Toasts = ({ dev }) => html`${(U.toasts[dev] || []).concat(U.toasts.global).map((t) => html`<div class=${'dtoast' + (t.kind === 'err' ? ' err' : '')} role="status" key=${t.id}><span style="flex:1">${t.title ? html`<b>${t.title}</b>` : null}${t.body}</span></div>`)}`;
  const Mobile = ({ dev, children, dark }) => html`<div class=${'appmode-screen mobile' + (dark ? ' dark-frame' : '')} data-dev=${dev}>${children}<${Toasts} dev=${dev} />${!A.online ? html`<div class="offline-bar">You're offline. Changes will fail until the connection is back.</div>` : null}</div>`;
  const Loading = ({ msg }) => html`<div class="appmode-screen mobile"><div class="app light"><div class="app-scroll" style="justify-content:center;align-items:center;text-align:center;gap:16px">
    ${msg ? html`<span class="ibox" style="width:56px;height:56px;background:var(--bad-soft);color:var(--bad)"><${D.Icon} n="alert" s="26" /></span><b style="font-size:17px">We couldn't load your account</b><div class="sub">${msg}</div><button class="btn md ink" style="width:auto;padding:0 24px" onClick=${() => A.refresh()}>Try again</button><button class="linkbtn" onClick=${() => A.signOut()}>Sign out</button>`
    : html`<div class="skel" style="width:70%;height:22px"></div><div class="skel" style="width:90%;height:120px"></div><div class="skel" style="width:90%;height:60px"></div>`}</div></div></div>`;

  let lastUser = null;
  const App = () => {
    if (PAGE === 'site') return html`<${D.SiteApp} />`;
    if (!A.ready) return html`<${Loading} />`;
    if (PAGE === 'track') return html`<${Mobile} dev="recipient"><${D.RecipientApp} /><//>`;
    if (A.recovery) return html`<${Mobile} dev="auth"><${D.ResetPassword} /><//>`;
    const me = S.me();
    if (!A.session) { lastUser = null; return html`<${Mobile} dev="auth" dark=${D.authAudience() === 'rider'}><${D.AuthApp} /><//>`; }
    if (!me) return html`<${Loading} msg=${A.loadError} />`;
    if (lastUser !== me.id) {
      lastUser = me.id;
      ['vendor', 'rider', 'recipient'].forEach((dev) => { U[dev].stack = []; U[dev].screen = dev === 'recipient' ? 'lookup' : 'home'; U[dev].params = {}; });
      U.ops.tab = 'live';
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (me.status === 'suspended') return html`<${Mobile} dev="global"><${D.Suspended} /><//>`;
    if (me.role === 'new') return html`<${Mobile} dev="auth" dark=${D.authAudience() === 'rider'}><${D.Onboarding} /><//>`;
    if (me.role === 'ops') return html`<div class="ops-wrap ops-page"><${D.OpsApp} /><div class="global-toasts">${U.toasts.global.map((t) => html`<div class=${'gtoast' + (t.kind === 'err' ? ' err' : '')} role="status" key=${t.id}>${t.title ? html`<b>${t.title}: </b>` : null}${t.body}</div>`)}</div></div>`;
    if (me.role === 'vendor') return html`<${Mobile} dev="vendor"><${D.VendorApp} /><//>`;
    if (me.role === 'rider') return html`<${Mobile} dev="rider" dark=${true}><${D.RiderApp} /><//>`;
    return html`<${Mobile} dev="recipient"><${D.RecipientApp} /><//>`;
  };

  // Android hardware back: pop the in-app stack of whichever experience is showing.
  D.androidBack = () => {
    const me = S.me();
    const dev = !A.session || (me && me.role === 'new') ? 'auth' : me && me.role === 'vendor' ? 'vendor' : me && me.role === 'rider' ? 'rider' : me && me.role === 'recipient' ? 'recipient' : null;
    if (dev && U[dev].stack.length) { D.back(dev); return true; }
    return false;
  };

  window.addEventListener('resize', () => D.rerender());
  window.addEventListener('hashchange', () => { if (!A.session) { D.authStart(); D.rerender(); } });
  D.authStart();
  D.mount(document.getElementById('app'), App);

  (async () => {
    if (PAGE === 'site') { hideSplash(); return; }
    await A.init();
    if (PAGE === 'track') {
      const tok = new URLSearchParams(location.search).get('t');
      if (tok) D.recipientOpenToken(tok);
    }
    hideSplash();
    D.rerender();
  })();
})();
