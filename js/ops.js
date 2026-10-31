/* Drop Off — operations console. Reads the whole network (ops RLS) and intervenes through ops_* server functions. */
(function () {
  const D = window.DO, html = D.html, S = D.store, F = D.fmt, U = D.ui;
  const { Icon, VIcon, Chip, Btn, MapView, Timeline, PhotoView, SigView, Toggle } = D;
  const act = S.act;
  const O = () => U.ops;
  const T = () => U.tmpOf.ops;
  const set = (patch) => { Object.assign(U.ops, patch); D.rerender(); };
  const open = (did) => set({ tab: 'deliveries', sel: did });
  const ok = (msg) => ({ dev: 'global', ok: msg });
  const MIN = 60000;

  /* alerts are derived from live data, never stored separately */
  function alerts() {
    const s = S.state, out = [];
    s.deliveries.forEach((d) => {
      if (d.status === 'searching' && !d.eligibleOnline) out.push({ kind: 'bad', title: 'No driver available', body: S.cls(d.cls).label + ' needed at ' + d.pickup.area + ' · ' + F.mins((Date.now() - d.createdAt) / MIN) + ' waiting', d });
      else if (d.status === 'searching' && Date.now() - d.createdAt > 10 * MIN) out.push({ kind: 'warn', title: 'Still looking for a driver', body: 'Open for ' + F.mins((Date.now() - d.createdAt) / MIN), d });
      if (d.flags.includes('vehicle_issue')) out.push({ kind: 'bad', title: 'Vehicle problem · handover needed', body: (S.rider(d.riderId) || {}).name + ' reported a breakdown', d });
      if (d.flags.includes('pin_mismatch') && D.ACTIVE.includes(d.status)) out.push({ kind: 'bad', title: 'Delivery PIN mismatch', body: d.proof.drop.attempts + ' wrong PIN attempts at ' + d.dropoff.area, d });
      if (d.flags.includes('ops_flag')) out.push({ kind: 'warn', title: 'Flagged', body: d.flagNote || 'Needs attention', d });
      if (d.late) out.push({ kind: 'warn', title: 'Running late', body: 'Past the promised time of ' + F.time(d.promisedAt), d });
      if (d.unreachable && ['arrived', 'awaiting_confirmation'].includes(d.status)) out.push({ kind: 'warn', title: 'Recipient not answering', body: d.unreachable.calls + ' calls logged', d });
      if (d.status === 'failed' && !d.resolution) out.push({ kind: 'bad', title: 'Failed · vendor deciding', body: d.failReason, d });
      if (d.status === 'disputed') out.push({ kind: 'bad', title: 'Dispute open', body: 'Review the proof and decide', d });
    });
    s.notifications.filter((n) => n.aud === 'ops' && /^SOS/.test(n.title) && Date.now() - n.ts < 6 * 3600000).forEach((n) => out.unshift({ kind: 'bad', title: n.title, body: n.body + ' · ' + F.ago(n.ts), d: n.did && S.delivery(n.did) }));
    s.tickets.filter((t) => !['resolved', 'closed'].includes(t.status) && !(t.did && S.delivery(t.did) && S.delivery(t.did).status === 'disputed')).forEach((t) => out.push({ kind: 'info', title: 'Support case ' + t.id, body: t.title + ' · ' + D.TICKET[t.status], d: t.did && S.delivery(t.did), ticket: t }));
    s.verifications.filter((v) => ['submitted', 'under_review'].includes(v.status)).forEach((v) => out.push({ kind: (v.riskFlags || []).length ? 'warn' : 'info', title: (v.subject === 'rider' ? 'Rider' : 'Business') + ' verification', body: v.name + ' · ' + D.VERIFY[v.status].label + ((v.riskFlags || []).length ? ' · risk flag' : ''), ver: v }));
    s.payments.filter((p) => p.needsReview).forEach((p) => out.unshift({ kind: 'bad', title: 'Payment needs review', body: (p.reviewReason || '') + ' · ' + F.ugx(p.amount), pay: p }));
    s.payments.filter((p) => p.direction === 'disbursement' && p.approval === 'awaiting_approval' && p.status === 'pending' && !p.needsReview).forEach((p) => out.push({ kind: 'warn', title: 'Cash-out to approve', body: F.ugx(p.amount) + ' · ' + ((p.riderId && (S.rider(p.riderId) || {}).name) || (p.vendorId && (S.vendor(p.vendorId) || {}).name) || ''), pay: p }));
    return out;
  }

  const Nav = () => {
    const a = alerts().length;
    const cases = S.state.tickets.filter((t) => !['resolved', 'closed'].includes(t.status)).length;
    const ver = S.state.verifications.filter((v) => ['submitted', 'under_review'].includes(v.status)).length;
    const t = (k, l, cnt) => html`<button aria-current=${O().tab === k ? 'page' : null} onClick=${() => set({ tab: k })}>${l}${cnt ? html`<span class="cnt">${cnt}</span>` : null}</button>`;
    return html`<div class="ops-top"><span style="display:flex;gap:8px;align-items:center"><${D.Logo} s="26" /><b class="display" style="font-size:17px">Drop Off <span style="color:var(--mari)">Ops</span></b></span>
      <nav class="ops-nav" aria-label="Ops sections">${t('live', 'Live', a)}${t('deliveries', 'Deliveries')}${t('network', 'Network')}${t('verify', 'Verification', ver)}${t('payments', 'Payments', S.state.payments.filter((p) => p.needsReview || (p.direction === 'disbursement' && p.approval === 'awaiting_approval' && p.status === 'pending')).length)}${t('disputes', 'Support & disputes', cases)}${t('messages', 'SMS outbox')}${t('audit', 'Audit log')}${t('config', 'Config')}</nav>
      <span style="margin-left:auto;font-size:13px;color:#B5C6BF;display:flex;gap:10px;align-items:center"><span><span style=${'display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:' + (D.api.realtime === 'live' ? '#3DD68C' : '#FFB71B')}></span>${D.api.realtime === 'live' ? 'Live' : 'Polling'} · ${S.me().name}</span><button class="btn sm white" onClick=${() => D.run('signout', () => D.api.signOut(), { dev: 'global' })}>Sign out</button></span></div>`;
  };

  /* ---------------- live ---------------- */
  const Live = () => {
    const s = S.state;
    const active = s.deliveries.filter((d) => D.ACTIVE.includes(d.status));
    const day = new Date().toDateString();
    const today = s.deliveries.filter((d) => new Date(d.createdAt).toDateString() === day);
    const online = s.riders.filter((r) => r.online && r.verified);
    const al = alerts();
    const ev = [];
    s.deliveries.forEach((d) => d.events.forEach((e) => ev.push({ ...e, did: d.id })));
    ev.sort((a, b) => b.ts - a.ts);
    return html`<div class="ops-main">
      <div class="ops-h"><div><h2>Live operations</h2><div class="cap">Every delivery, driver and alert from the database · updates when anything changes</div></div></div>
      <div class="kpis">
        <div class="kpi"><div class="l">Active deliveries</div><div class="v">${active.length}</div><div class="s">${today.length} created today</div></div>
        <div class=${'kpi' + (active.some((d) => d.status === 'searching') ? ' watch' : '')}><div class="l">Finding a driver</div><div class="v">${active.filter((d) => d.status === 'searching').length}</div><div class="s">${active.filter((d) => d.status === 'searching' && !d.eligibleOnline).length} with no driver online</div></div>
        <div class=${'kpi' + (al.some((x) => x.kind === 'bad') ? ' alert' : '')}><div class="l">Needs attention</div><div class="v">${al.length}</div><div class="s">${al.filter((x) => x.kind === 'bad').length} critical</div></div>
        <div class="kpi"><div class="l">Delivered today</div><div class="v">${s.deliveries.filter((d) => ['delivered', 'disputed'].includes(d.status) && new Date(d.statusAt).toDateString() === day).length}</div><div class="s">${s.deliveries.filter((d) => d.status === 'failed' && new Date(d.statusAt).toDateString() === day).length} failed</div></div>
        <div class="kpi"><div class="l">Drivers online</div><div class="v">${online.length}</div><div class="s">${online.filter((r) => r.activeUuid).length} on a job · ${online.filter((r) => r.loc).length} sharing GPS</div></div>
      </div>
      <div class="ops-cols">
        <section class="ops-card" style="flex:2 1 520px"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><h3>Live map</h3><div class="pills" style="font-size:12px"><span class="chip ok">Free</span><span class="chip pine">On a job</span><span class="chip info">Finding driver</span></div></div>
          <div style="border-radius:16px;overflow:hidden"><${MapView} all=${true} width=${760} height=${430} selected=${O().sel} onDelivery=${open} onRider=${(rid) => { const r = S.rider(rid); if (r.activeId) open(r.activeId); else set({ tab: 'network', netTab: 'riders' }); }} label="Live map of drivers and deliveries" /></div>
          <div class="cap">Drivers appear only while they share GPS from their phone. Click a route or a driver to open it.</div></section>
        <section class="ops-card" style="flex:1 1 320px;max-height:600px;overflow:auto"><h3>Needs attention · ${al.length}</h3>
          ${al.map((a) => html`<button class=${'alert-item ' + a.kind} style="border:0;text-align:left;cursor:pointer" onClick=${() => a.pay ? set({ tab: 'payments', payView: 'provider', pf: 'action', psel: a.pay.id }) : a.d ? open(a.d.id) : a.ver ? set({ tab: 'verify', vsel: a.ver.id }) : set({ tab: 'disputes' })}>
            <span style="display:flex;justify-content:space-between;gap:8px"><b>${a.title}</b>${a.d ? html`<span class="mono" style="font-size:12px">${a.d.id}</span>` : null}</span><span style="font-size:13px;color:var(--ink2)">${a.body}</span></button>`)}
          ${!al.length ? html`<div class="empty">All clear. Nothing needs ops right now.</div>` : null}</section>
      </div>
      <section class="ops-card"><h3>Event stream</h3><div class="feed" style="max-height:260px">${ev.slice(0, 50).map((e) => html`<button class="feed-item" style="border:0;background:none;text-align:left;cursor:pointer" onClick=${() => open(e.did)}><span class="t">${F.dayTime(e.ts)}</span><span><b class="mono" style="font-size:11px">${e.did}</b> ${e.label} <span class="cap">· ${e.actor ? e.actor.name : ''}</span></span></button>`)}${!ev.length ? html`<div class="empty">No events yet.</div>` : null}</div></section>
    </div>`;
  };

  /* ---------------- deliveries ---------------- */
  const GROUPS = { all: null, searching: ['searching'], active: D.ACTIVE.filter((x) => x !== 'searching'), delivered: ['delivered'], failed: ['failed'], cancelled: ['cancelled'], disputed: ['disputed'], flagged: 'flag' };
  const Deliveries = () => {
    const o = O(), t = T();
    const q = o.q.toLowerCase();
    const since = { any: 0, today: new Date().setHours(0, 0, 0, 0), week: Date.now() - 7 * 864e5 }[t.when || 'any'];
    const match = (d) => !q || [d.id, (S.vendor(d.vendorId) || {}).name, d.recipient.name, d.recipient.phone, d.riderId ? (S.rider(d.riderId) || {}).name : '', d.riderId ? (S.rider(d.riderId) || {}).plate : '', d.dropoff.area, d.pickup.area].join(' ').toLowerCase().includes(q);
    const inGroup = (d, g) => g === 'all' ? true : g === 'flagged' ? d.flags.length > 0 || d.late : GROUPS[g].includes(d.status);
    const list = S.state.deliveries.filter((d) => inGroup(d, o.filter) && d.createdAt >= since && match(d));
    const sel = o.sel && S.delivery(o.sel);
    return html`<div class="ops-main">
      <div class="ops-h"><h2>Deliveries</h2><input class="search" style="flex:1 1 260px;max-width:420px" aria-label="Search deliveries" placeholder="Search ID, vendor, recipient, phone, driver, plate, area" value=${o.q} onInput=${(e) => set({ q: e.target.value })} /></div>
      <div class="pills">${Object.keys(GROUPS).map((g) => html`<button class="pill" aria-pressed=${o.filter === g ? 'true' : 'false'} onClick=${() => set({ filter: g })}>${g[0].toUpperCase() + g.slice(1)} · ${S.state.deliveries.filter((d) => inGroup(d, g)).length}</button>`)}<span style="width:12px"></span>${[['any', 'Any date'], ['today', 'Today'], ['week', '7 days']].map(([k, l]) => html`<button class="pill" aria-pressed=${(t.when || 'any') === k ? 'true' : 'false'} onClick=${() => { t.when = k; D.rerender(); }}>${l}</button>`)}</div>
      <div class="ops-cols">
        <section class="ops-card" style="flex:3 1 560px"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Vendor</th><th>Route</th><th>Vehicle</th><th>Status</th><th>Driver</th><th class="num">Price</th><th>Updated</th></tr></thead><tbody>
          ${list.map((d) => html`<tr class=${'click' + (o.sel === d.id ? ' sel' : '')} onClick=${() => set({ sel: d.id })}><td class="mono">${d.id}${d.flags.length || d.late ? html` <span title="Needs attention" style="color:var(--bad)">●</span>` : null}</td><td>${(S.vendor(d.vendorId) || {}).name}</td><td>${d.pickup.area} → ${d.dropoff.area}</td><td>${S.cls(d.cls).label}</td><td><${Chip} status=${d.status} /></td><td>${d.riderId ? (S.rider(d.riderId) || {}).name : '—'}</td><td class="num">${F.num(d.price.total)}</td><td style="white-space:nowrap">${F.dayTime(d.statusAt)}</td></tr>`)}
          ${!list.length ? html`<tr><td colspan="8"><div class="empty">No deliveries match this filter.</div></td></tr>` : null}</tbody></table></div></section>
        ${sel ? html`<${Drawer} d=${sel} />` : html`<section class="drawer" style="flex:2 1 380px"><div class="empty">Select a delivery to see its timeline, proof and actions.</div></section>`}
      </div></div>`;
  };

  const Drawer = ({ d }) => {
    if (T().for !== d.id) U.tmpOf.ops = { for: d.id, when: T().when };
    const tt = T();
    const r = d.riderId && S.rider(d.riderId);
    const v = S.vendor(d.vendorId) || { name: '—', methods: [] };
    const canAssign = d.status === 'searching';
    const canReassign = ['assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching'].includes(d.status);
    const cands = canAssign || canReassign ? S.candidates(d, { includeOffline: true, anyEligible: true }).filter((c) => !c.busy) : [];
    const ticket = d.disputeTicket && S.state.tickets.find((x) => x.id === d.disputeTicket);
    const pp = d.proof.pickup, dp = d.proof.drop;
    return html`<section class="drawer" style="flex:2 1 400px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><div class="mono" style="font-size:18px">${d.id}</div><div class="cap">${v.name} · ${F.dayTime(d.createdAt)}${d.isDemo ? ' · demo data' : ''}</div></div><div style="display:flex;gap:6px;align-items:center"><${Chip} status=${d.status} /><button class="iconbtn mist" aria-label="Close" onClick=${() => set({ sel: null })}><${Icon} n="x" s="18" /></button></div></div>
      ${d.flags.length || d.late ? html`<div class="pills">${d.flags.map((f) => html`<span class="chip bad">${f.replace('_', ' ')}</span>`)}${d.late ? html`<span class="chip mari">late</span>` : null}</div>` : null}
      <div style="border-radius:14px;overflow:hidden"><${MapView} d=${d} width=${420} height=${200} label=${'Map for ' + d.id} /></div>
      <div class="tbl-wrap"><table class="tbl" style="font-size:13px"><tbody>
        <tr><td class="cap">Pickup</td><td>${d.pickup.name}${D.PRE_PICKUP.includes(d.status) && d.pickupPin ? html` · PIN <span class="mono">${d.pickupPin}</span>` : null}</td></tr>
        <tr><td class="cap">Drop-off</td><td>${d.dropoff.name} · ${d.recipient.name} · ${F.phoneMask(d.recipient.phone)}</td></tr>
        <tr><td class="cap">Package</td><td>${d.pkg.desc} · ${(S.sizeOf(d.pkg.size) || {}).label} · ${d.pkg.weight} kg${d.pkg.value ? ' · value ' + F.ugx(d.pkg.value) : ''}</td></tr>
        <tr><td class="cap">Vehicle</td><td>${S.cls(d.cls).label}${d.widened ? ' (widened)' : ''}${r ? ' · ' + r.name + ' · ' + r.plate : ''}${r && r.loc ? ' · GPS ' + F.ago(r.loc.updatedAt) : r ? ' · no GPS' : ''}</td></tr>
        <tr><td class="cap">Payment</td><td>${F.ugx(d.price.total)} · ${S.methodLabel(v, d.payment.method)} · ${d.payment.status.replace('_', ' ')}${d.payment.simulated ? ' (sandbox)' : ''}${d.earning ? ' · driver ' + F.ugx(d.earning) : ''}</td></tr>
        ${d.status === 'searching' ? html`<tr><td class="cap">Matching</td><td>${d.eligibleOnline || 0} eligible driver${d.eligibleOnline === 1 ? '' : 's'} online and free</td></tr>` : null}
      </tbody></table></div>

      ${canAssign || canReassign ? html`<div style="display:flex;flex-direction:column;gap:8px"><b>${canAssign ? 'Assign a driver' : 'Reassign driver'}</b>
        ${canReassign && ['picked_up', 'in_transit', 'approaching'].includes(d.status) ? html`<div class="banner mari" style="font-size:12.5px">The package is already picked up. The new driver meets ${r ? r.name : 'the driver'} at their last known location for a handover.</div>` : null}
        <div class="tbl-wrap"><table class="tbl" style="font-size:13px"><thead><tr><th>Driver</th><th>Vehicle</th><th>To pickup</th><th class="num">Score</th><th></th></tr></thead><tbody>
          ${cands.slice(0, 8).map((c) => html`<tr><td>${c.rider.name}${c.offline ? html` <span class="cap">(offline)</span>` : null}</td><td>${S.cls(c.rider.cls).label}</td><td>${c.eta == null ? html`<span class="cap">No GPS</span>` : F.mins(c.eta)}</td><td class="num">${c.score}</td><td><${Btn} kind="sm ink" busy=${D.busy('o-as' + c.rider.id)} onClick=${() => D.run('o-as' + c.rider.id, () => (canAssign ? act.opsAssign(d.id, c.rider.id) : act.opsReassign(d.id, c.rider.id, tt.reason || 'Ops decision')), ok((canAssign ? 'Assigned to ' : 'Reassigned to ') + c.rider.name))}>${canAssign ? 'Assign' : 'Reassign'}<//></td></tr>`)}
          ${!cands.length ? html`<tr><td colspan="5" class="cap">No eligible free driver. Approve an application in Verification or ask a driver to come online.</td></tr>` : null}</tbody></table></div>
        ${canReassign ? html`<input class="search" aria-label="Reason for reassigning" placeholder="Reason (optional)" value=${tt.reason || ''} onInput=${(e) => { tt.reason = e.target.value; }} />` : null}</div>` : null}

      ${pp.photo || dp.photo || d.pkg.photo ? html`<div style="display:flex;flex-direction:column;gap:8px"><b>Proof review</b><div class="row2">
        <div>${pp.photo ? html`<${PhotoView} photo=${pp.photo} h=${90} label="Pickup photo" />` : d.pkg.photo ? html`<${PhotoView} photo=${d.pkg.photo} h=${90} label="Vendor's package photo" />` : html`<div class="photo" style="height:90px"></div>`}<div class="cap">${pp.photo ? 'Pickup · PIN ' + (pp.pinOk ? '✓' : '—') + (pp.ts ? ' · ' + F.time(pp.ts) : '') : 'Vendor photo'}</div></div>
        <div>${dp.photo ? html`<${PhotoView} photo=${dp.photo} h=${90} label="Delivery photo" />` : html`<div class="photo" style="height:90px"></div>`}<div class="cap">Handover${dp.ts ? ' · ' + F.time(dp.ts) : ''}</div></div></div>
        ${dp.ts ? html`<div class="cap">PIN ${dp.pinOk ? '✓ by the ' + (dp.pinBy || 'rider') : '✗'} · received by ${dp.receiverName || d.recipient.name} · ${dp.distM != null ? 'GPS ' + dp.distM + ' m from pin' : 'no GPS fix'} · signature:</div><${SigView} value=${dp.signature} required=${d.sigRequired} />` : null}</div>` : null}

      ${d.status === 'disputed' && ticket ? html`<div class="alert-item bad"><b>Dispute ${ticket.id} · ${ticket.title}</b><span style="font-size:13px">${ticket.note || 'No details given.'} · opened by the ${ticket.by}</span>
        <input class="search" aria-label="Decision note" placeholder="Note to the vendor (optional)" value=${tt.dnote || ''} onInput=${(e) => { tt.dnote = e.target.value; }} />
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm ink" onClick=${() => D.run('o-res', () => act.resolveTicket(ticket.id, 'refund_full', tt.dnote), ok('Full refund issued · driver liable for half'))}>Refund ${F.ugx(d.payment.amount)}</button><button class="btn sm white" onClick=${() => D.run('o-res', () => act.resolveTicket(ticket.id, 'refund_half', tt.dnote), ok('Partial refund issued'))}>Refund 50%</button><button class="btn sm white" onClick=${() => D.run('o-res', () => act.resolveTicket(ticket.id, 'reject', tt.dnote || 'Proof shows the package intact at handover'), ok('Claim rejected'))}>Reject claim</button></div></div>` : null}

      ${d.status === 'failed' && !d.resolution ? html`<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm ink" onClick=${() => D.run('o-re', () => act.reattempt(d.id), ok('Reattempt started'))}>Reattempt delivery</button><button class="btn sm white" onClick=${() => D.run('o-ret', () => act.returnToVendor(d.id), ok('Return to vendor arranged'))}>Return to vendor</button></div>` : null}

      <div style="display:flex;flex-direction:column;gap:8px"><b>Intervene</b>
        <input class="search" aria-label="Reason or note" placeholder="Reason or note (needed to cancel or fail)" value=${tt.note || ''} onInput=${(e) => { tt.note = e.target.value; D.rerender(); }} />
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn sm white" onClick=${() => D.run('o-flag', () => act.opsFlag(d.id, tt.note), ok(d.flags.includes('ops_flag') ? 'Flag cleared' : 'Delivery flagged'))}><${Icon} n="flag" s="15" />${d.flags.includes('ops_flag') ? 'Clear flag' : 'Flag'}</button>
          ${D.PRE_PICKUP.includes(d.status) || (d.status === 'failed' && !d.resolution) ? html`<button class="btn sm danger" onClick=${() => D.run('o-cancel', () => act.opsCancel(d.id, tt.note), ok('Cancelled · reserved amount released'))}>Cancel delivery</button>` : null}
          ${['picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation'].includes(d.status) ? html`<button class="btn sm danger" onClick=${() => D.run('o-fail', () => act.opsFail(d.id, tt.note), ok('Marked as failed'))}>Mark failed</button>` : null}
          ${D.ACTIVE.includes(d.status) ? html`<button class="btn sm white" onClick=${() => D.run('o-pin', () => act.opsResendPin(d.id), ok('Delivery PIN re-sent to the recipient (SMS outbox)'))}><${Icon} n="lock" s="15" />Resend PIN</button>` : null}
          <button class="btn sm white" onClick=${() => D.run('o-call', () => act.call(d.id, 'ops', 'vendor'), ok('Call to ' + v.name + ' logged · ' + (v.phone || '')))}><${Icon} n="phone" s="15" />Vendor</button>
          ${r ? html`<button class="btn sm white" onClick=${() => D.run('o-call', () => act.call(d.id, 'ops', 'rider'), ok('Call to ' + r.name + ' logged · ' + (r.phone || '')))}><${Icon} n="phone" s="15" />Driver</button>` : null}
        </div></div>
      <div><b>Timeline · ${d.events.length} events</b><div style="margin-top:8px;max-height:360px;overflow:auto"><${Timeline} events=${d.events} /></div></div>
    </section>`;
  };

  /* ---------------- network ---------------- */
  const Network = () => {
    const o = O(), s = S.state, t = T();
    const q = (t.nq || '').toLowerCase();
    const riders = s.riders.filter((r) => !q || (r.name + r.plate + (r.cls || '') + r.phone + (r.email || '')).toLowerCase().includes(q));
    const vendors = s.vendors.filter((v) => !q || (v.name + v.category + (v.email || '') + v.phone).toLowerCase().includes(q));
    const suspend = (pid, name, isSusp) => D.run('o-susp' + pid, async () => {
      if (!isSusp && (t.sreason || '').trim().length < 3) throw new D.UserError('Type a reason in the box above before suspending ' + name + '.');
      await act.setAccountStatus(pid, isSusp ? 'active' : 'suspended', isSusp ? null : t.sreason);
    }, ok(isSusp ? name + ' reactivated' : name + ' suspended'));
    return html`<div class="ops-main">
      <div class="ops-h"><h2>Network</h2><input class="search" style="flex:1 1 240px;max-width:380px" aria-label="Search network" placeholder="Search names, plates, phones, e-mails" value=${t.nq || ''} onInput=${(e) => { t.nq = e.target.value; D.rerender(); }} /><input class="search" style="flex:1 1 200px;max-width:300px" aria-label="Suspension reason" placeholder="Reason, needed to suspend" value=${t.sreason || ''} onInput=${(e) => { t.sreason = e.target.value; }} /></div>
      <div class="pills">${[['riders', 'Riders & drivers'], ['vehicles', 'Vehicles'], ['vendors', 'Vendors']].map(([k, l]) => html`<button class="pill" aria-pressed=${o.netTab === k ? 'true' : 'false'} onClick=${() => set({ netTab: k })}>${l}</button>`)}</div>
      ${o.netTab === 'riders' ? html`<section class="ops-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Vehicle</th><th>Status</th><th class="num">Rating</th><th class="num">Trips</th><th class="num">Balance</th><th>Online</th><th>Account</th></tr></thead><tbody>
        ${riders.map((r) => html`<tr><td><b>${r.name}</b><div class="cap">${r.phone}${r.email ? ' · ' + r.email : ''}</div></td><td>${r.cls ? S.cls(r.cls).label : '—'} · <span class="mono">${r.plate}</span></td><td>${!r.verified ? html`<button class="chip mari" style="border:0;cursor:pointer" onClick=${() => set({ tab: 'verify' })}>${D.VERIFY[r.verification].label}</button>` : r.activeId ? html`<button class="chip pine" style="border:0;cursor:pointer" onClick=${() => open(r.activeId)}>On ${r.activeId}</button>` : r.online ? html`<span class="chip ok">Free</span>` : html`<span class="chip grey">Offline</span>`}</td><td class="num">${r.rating.toFixed(2)}</td><td class="num">${F.num(r.trips)}</td><td class="num">${F.num(r.balance)}</td>
          <td>${r.verified ? html`<${Toggle} on=${r.online} label=${'Online status for ' + r.name} onClick=${() => D.run('o-on' + r.id, () => act.setOnline(r.id, !r.online), ok(r.name + (r.online ? ' set offline' : ' set online')))} />` : null}</td>
          <td>${r.accountStatus === 'suspended' ? html`<button class="btn sm" onClick=${() => suspend(r.profileId, r.name, true)}>Reactivate</button>` : html`<button class="btn sm white" disabled=${!!r.activeId} onClick=${() => suspend(r.profileId, r.name, false)}>Suspend</button>`}</td></tr>`)}
        ${!riders.length ? html`<tr><td colspan="8"><div class="empty">No drivers match.</div></td></tr>` : null}</tbody></table></div></section>` : null}
      ${o.netTab === 'vehicles' ? html`<section class="ops-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Plate</th><th>Vehicle</th><th>Class</th><th class="num">Max load</th><th>Driver</th><th>Logbook no.</th><th>Docs</th></tr></thead><tbody>
        ${riders.filter((r) => r.vehicle).map((r) => html`<tr><td class="mono">${r.plate}</td><td>${r.make} · ${r.color}</td><td><span style="display:inline-flex;gap:6px;align-items:center"><${VIcon} c=${r.cls} s="18" />${S.cls(r.cls).label}</span></td><td class="num">${F.num(S.cls(r.cls).maxKg)} kg</td><td>${r.name}</td><td>${r.vehicle.registrationNo || '—'}</td><td><span class=${'chip ' + D.VERIFY[r.vehicle.verification].tone}>${D.VERIFY[r.vehicle.verification].label}</span></td></tr>`)}
      </tbody></table></div></section>` : null}
      ${o.netTab === 'vendors' ? html`<section class="ops-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Business</th><th>Category</th><th class="num">Wallet</th><th>Credit (used / limit)</th><th class="num">Deliveries</th><th>Verification</th><th>Account</th></tr></thead><tbody>
        ${vendors.map((v) => { const ds = s.deliveries.filter((d) => d.vendorId === v.id); return html`<tr><td><b>${v.name}</b><div class="cap">${v.owner} · ${v.phone}${v.email ? ' · ' + v.email : ''}</div></td><td>${v.category}</td><td class="num">${F.num(v.wallet)}</td>
          <td>${v.verified ? html`<span style="display:flex;gap:6px;align-items:center">${F.k(v.credit.used)} / <input class="num-in" aria-label=${'Credit limit for ' + v.name} value=${v.credit.limit} onChange=${(e) => D.run('o-cr' + v.id, () => act.setCredit(v.id, e.target.value), ok('Credit limit updated for ' + v.name))} /></span>` : '—'}</td>
          <td class="num">${ds.length}</td><td><span class=${'chip ' + D.VERIFY[v.verification].tone}>${D.VERIFY[v.verification].label}</span></td>
          <td>${v.accountStatus === 'suspended' ? html`<button class="btn sm" onClick=${() => suspend(v.ownerId, v.name, true)}>Reactivate</button>` : html`<button class="btn sm white" onClick=${() => suspend(v.ownerId, v.name, false)}>Suspend</button>`}</td></tr>`; })}
        ${!vendors.length ? html`<tr><td colspan="7"><div class="empty">No vendors match.</div></td></tr>` : null}</tbody></table></div></section>` : null}
    </div>`;
  };

  /* ---------------- verification ---------------- */
  const DocLink = ({ doc }) => {
    const url = D.api.mediaUrl({ bucket: doc.bucket, path: doc.path });
    return html`<div class="list-row"><${Icon} n="upload" /><span class="grow"><span class="t1" style="display:block;font-size:14px">${D.DOC_KINDS[doc.kind]}</span><span class="t2">${doc.fileName} · ${doc.size ? Math.round(doc.size / 1024) + ' KB' : ''} · ${F.dayTime(new Date(doc.createdAt).getTime())}</span></span>${url ? html`<a class="btn sm white" href=${url} target="_blank" rel="noopener">Open</a>` : html`<span class="cap">${url === undefined ? 'Preparing…' : 'File not available'}</span>`}</div>`;
  };
  const Verify = () => {
    const o = O(), t = T();
    const f = t.vf || 'queue';
    const list = S.state.verifications.filter((v) => f === 'all' || (f === 'queue' ? ['submitted', 'under_review'].includes(v.status) : v.status === f));
    const sel = S.state.verifications.find((v) => v.id === o.vsel) || list[0];
    const subj = sel && (sel.riderId ? S.rider(sel.riderId) : S.vendor(sel.vendorId));
    const decide = (decision, label) => D.run('o-vr', async () => { await act.reviewVerification(sel.id, decision, t.vnote); t.vnote = ''; }, ok(label));
    return html`<div class="ops-main"><div class="ops-h"><div><h2>Verification</h2><div class="cap">Documents are reviewed by hand. No automated government identity check is connected.</div></div></div>
      <div class="pills">${[['queue', 'To review'], ['pending', 'Not submitted'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['suspended', 'Suspended'], ['all', 'All']].map(([k, l]) => html`<button class="pill" aria-pressed=${f === k ? 'true' : 'false'} onClick=${() => { t.vf = k; D.rerender(); }}>${l} · ${S.state.verifications.filter((v) => k === 'all' || (k === 'queue' ? ['submitted', 'under_review'].includes(v.status) : v.status === k)).length}</button>`)}</div>
      <div class="ops-cols">
        <section class="ops-card" style="flex:2 1 420px"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Applicant</th><th>Type</th><th>Status</th><th class="num">Docs</th><th>Updated</th></tr></thead><tbody>
          ${list.map((v) => html`<tr class=${'click' + (sel && sel.id === v.id ? ' sel' : '')} onClick=${() => set({ vsel: v.id })}><td><b>${v.name}</b></td><td>${v.subject === 'rider' ? 'Rider / driver' : 'Business'}</td><td><span class=${'chip ' + D.VERIFY[v.status].tone}>${v.infoRequested ? 'Info requested' : D.VERIFY[v.status].label}</span></td><td class="num">${v.documents.length}</td><td style="white-space:nowrap">${F.dayTime(v.updatedAt)}</td></tr>`)}
          ${!list.length ? html`<tr><td colspan="5"><div class="empty">Nothing in this list.</div></td></tr>` : null}</tbody></table></div></section>
        ${sel ? html`<section class="drawer" style="flex:2 1 400px">
          <div style="display:flex;justify-content:space-between;gap:8px"><div><div style="font-size:18px;font-weight:700">${sel.name}</div><div class="cap">${sel.subject === 'rider' ? 'Rider / driver' : 'Business'} · applied ${F.day(sel.createdAt)}${sel.submittedAt ? ' · submitted ' + F.dayTime(sel.submittedAt) : ''}</div></div><span class=${'chip ' + D.VERIFY[sel.status].tone}>${D.VERIFY[sel.status].label}</span></div>
          ${subj ? html`<div class="tbl-wrap"><table class="tbl" style="font-size:13px"><tbody>${sel.riderId ? html`<tr><td class="cap">Contact</td><td>${subj.phone} · ${subj.email || ''}</td></tr><tr><td class="cap">Vehicle</td><td>${subj.cls ? S.cls(subj.cls).label : '—'} · ${subj.make} · ${subj.color} · <span class="mono">${subj.plate}</span></td></tr><tr><td class="cap">Driving permit</td><td>${subj.licenseNo || '—'}</td></tr><tr><td class="cap">Logbook no.</td><td>${(subj.vehicle || {}).registrationNo || '—'}</td></tr>` : html`<tr><td class="cap">Contact</td><td>${subj.owner} · ${subj.phone} · ${subj.email || ''}</td></tr><tr><td class="cap">Category</td><td>${subj.category}</td></tr><tr><td class="cap">Address</td><td>${subj.address || '—'}</td></tr><tr><td class="cap">Registration · TIN</td><td>${subj.registrationNo || '—'} · ${subj.tin || '—'}</td></tr>`}</tbody></table></div>` : null}
          ${sel.person ? html`<b>Identity (KYC)</b><div class="tbl-wrap"><table class="tbl" style="font-size:13px"><tbody>
            <tr><td class="cap">Name on account</td><td>${sel.person.name}</td></tr>
            <tr><td class="cap">NIN</td><td class="mono">${sel.person.nin || html`<span class="cap">Not entered</span>`}</td></tr>
            <tr><td class="cap">Date of birth</td><td>${sel.person.dob || html`<span class="cap">Not entered</span>`}</td></tr>
            <tr><td class="cap">Phone</td><td>${sel.person.phone || '—'} ${sel.person.phoneVerified ? html`<span class="chip ok">OTP verified</span>` : html`<span class="chip mari">Not verified</span>`}</td></tr>
            <tr><td class="cap">Signed up with</td><td>${sel.person.method}</td></tr></tbody></table></div>
            <div class="cap">Check: the name and NIN match the National ID, the selfie matches the ID photo${sel.riderId ? ', and the plate matches the logbook' : ''}. Drop Off does not verify NINs with NIRA automatically.</div>` : null}
          ${(sel.riskFlags || []).length ? html`<div class="alert-item bad"><b>Risk flags</b><span style="font-size:13px">${sel.riskFlags.map((f) => f === 'duplicate_nin' ? 'This NIN is also on another Drop Off account.' : f.replace(/_/g, ' ')).join(' ')}</span></div>` : null}
          <b>Documents</b><div class="card pad0">${sel.documents.map((doc) => html`<${DocLink} doc=${doc} />`)}${!sel.documents.length ? html`<div class="empty">No documents uploaded yet.</div>` : null}</div>
          ${sel.note ? html`<div class="banner info"><span><b>Last note:</b> ${sel.note}</span></div>` : null}
          <textarea class="input" rows="2" aria-label="Note to the applicant" placeholder="Note to the applicant (required to reject, request info or suspend)" value=${t.vnote || ''} onInput=${(e) => { t.vnote = e.target.value; }}></textarea>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${sel.status === 'submitted' ? html`<button class="btn sm white" onClick=${() => decide('start_review', 'Marked as under review')}>Start review</button>` : null}
            ${sel.status !== 'verified' ? html`<button class="btn sm ink" onClick=${() => decide('approve', sel.name + ' approved')}>Approve</button>` : null}
            ${sel.status !== 'verified' ? html`<button class="btn sm white" onClick=${() => decide('request_info', 'More information requested')}>Request information</button>` : null}
            ${sel.status !== 'rejected' && sel.status !== 'verified' ? html`<button class="btn sm white" onClick=${() => decide('reject', 'Application rejected')}>Reject</button>` : null}
            ${sel.status !== 'suspended' ? html`<button class="btn sm danger" onClick=${() => decide('suspend', sel.name + ' suspended')}>Suspend</button>` : html`<button class="btn sm ink" onClick=${() => decide('approve', sel.name + ' reinstated')}>Reinstate</button>`}
          </div>
          <div class="cap">Every decision is written to the audit log and the applicant is notified.</div>
        </section>` : null}
      </div></div>`;
  };

  /* ---------------- payments ---------------- */
  const payParty = (p) => p.riderId ? (S.rider(p.riderId) || {}).name : p.vendorId ? (S.vendor(p.vendorId) || {}).name : '—';
  const PAYF = { action: (p) => p.needsReview || (p.direction === 'disbursement' && p.approval === 'awaiting_approval' && p.status === 'pending'), open: (p) => ['pending', 'initiated'].includes(p.status),
    failed: (p) => p.status === 'failed', collections: (p) => p.direction === 'collection', payouts: (p) => p.direction === 'disbursement', all: () => true };
  const PayDrawer = ({ p }) => {
    const t = T();
    const awaiting = p.direction === 'disbursement' && p.approval === 'awaiting_approval' && p.status === 'pending';
    return html`<section class="drawer" style="flex:2 1 380px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><div style="font-size:18px;font-weight:700">${F.ugx(p.amount)} · ${p.direction === 'disbursement' ? 'Cash-out' : p.purpose === 'topup' ? 'Top-up' : 'Delivery ' + (p.did || '')}</div>
        <div class="cap">${payParty(p)}${p.by ? ' · requested by ' + p.by : ''} · ${F.dayTime(p.createdAt)}</div></div><div style="display:flex;gap:6px;align-items:center"><${D.PayChip} p=${p} /><button class="iconbtn mist" aria-label="Close" onClick=${() => set({ psel: null })}><${Icon} n="x" s="18" /></button></div></div>
      ${p.needsReview ? html`<div class="alert-item bad"><b>Needs review</b><span style="font-size:13px">${p.reviewReason}</span></div>` : null}
      <div class="tbl-wrap"><table class="tbl" style="font-size:13px"><tbody>
        <tr><td class="cap">Method</td><td>${D.payments.methodLabel(p.method)} ${p.msisdn || ''}</td></tr>
        <tr><td class="cap">Provider</td><td>${p.provider}${p.simulated ? ' (sandbox, no real money)' : ''} · ref <span class="mono">${p.providerRef || '—'}</span></td></tr>
        ${p.accountName ? html`<tr><td class="cap">Account holder</td><td>${p.accountName}</td></tr>` : null}
        ${p.failureReason ? html`<tr><td class="cap">Failure</td><td>${p.failureReason}</td></tr>` : null}
        <tr><td class="cap">Payment ID</td><td class="mono" style="font-size:11px">${p.id}</td></tr>
      </tbody></table></div>
      ${awaiting || p.needsReview ? html`<textarea class="input" rows="2" aria-label="Decision note" placeholder="Note (required to reject or clear a flag; the requester sees rejection notes)" value=${t.pnote || ''} onInput=${(e) => { t.pnote = e.target.value; }}></textarea>` : null}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${awaiting ? html`<${Btn} kind="sm ink" busy=${D.busy('o-pa')} onClick=${() => D.run('o-pa', async () => { await act.reviewPayout(p.id, true, t.pnote); t.pnote = ''; }, ok('Cash-out approved and sent'))}>Approve & send<//>
          <${Btn} kind="sm white" busy=${D.busy('o-pr')} onClick=${() => D.run('o-pr', async () => { await act.reviewPayout(p.id, false, t.pnote); t.pnote = ''; }, ok('Cash-out rejected · balance returned'))}>Reject<//>` : null}
        ${p.needsReview && !awaiting ? html`<${Btn} kind="sm white" busy=${D.busy('o-pc')} onClick=${() => D.run('o-pc', async () => { await act.clearPaymentReview(p.id, t.pnote); t.pnote = ''; }, ok('Flag cleared'))}>Clear flag<//>` : null}
        ${p.status === 'pending' && !awaiting ? html`<${Btn} kind="sm white" busy=${D.busy('o-ps')} onClick=${() => D.run('o-ps', () => act.initiatePayment(p.id), ok('Sent to the provider'))}>Send to provider<//>` : null}
        ${p.did && S.delivery(p.did) ? html`<button class="btn sm white" onClick=${() => open(p.did)}>Open ${p.did}</button>` : null}
      </div>
      <div><b>Provider log · ${p.events.length}</b><div class="feed" style="margin-top:8px;max-height:320px">${p.events.slice().reverse().map((e) => html`<div class="feed-item"><span class="t">${F.dayTime(e.ts)}</span><span><b>${e.kind.replace(/_/g, ' ')}</b>${e.from || e.to ? html` <span class="cap">${e.from || '·'} → ${e.to || '·'}</span>` : null}<div class="cap">${Object.entries(e.detail || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' · ')}</div></span></div>`)}</div></div>
    </section>`;
  };
  const ProviderPayments = () => {
    const o = O(), s = S.state, t = T();
    const f = o.pf || 'action';
    const q = (o.txQ || '').toLowerCase();
    const list = s.payments.filter((p) => p.direction !== 'internal' && PAYF[f](p) && (!q || (p.id + (p.providerRef || '') + (p.msisdn || '') + (p.did || '') + (payParty(p) || '')).toLowerCase().includes(q)));
    const sel = o.psel && S.payment(o.psel);
    const today = new Date().setHours(0, 0, 0, 0);
    const ext = s.payments.filter((p) => p.direction !== 'internal');
    const sum = (arr) => arr.reduce((a, p) => a + p.amount, 0);
    const lc = t.ledger;
    return html`
      <div class="kpis">
        <div class="kpi"><div class="l">Collected today</div><div class="v">${F.k(sum(ext.filter((p) => p.direction === 'collection' && p.status === 'successful' && p.updatedAt >= today)))}</div><div class="s">Confirmed by the provider</div></div>
        <div class=${'kpi' + (ext.some(PAYF.open) ? ' watch' : '')}><div class="l">Waiting on provider</div><div class="v">${ext.filter(PAYF.open).length}</div><div class="s">Prompts and transfers in flight</div></div>
        <div class=${'kpi' + (ext.some(PAYF.action) ? ' alert' : '')}><div class="l">Needs ops</div><div class="v">${ext.filter(PAYF.action).length}</div><div class="s">Approvals and flagged payments</div></div>
        <div class="kpi"><div class="l">Cash-outs today</div><div class="v">${F.k(sum(ext.filter((p) => p.direction === 'disbursement' && p.status === 'successful' && p.updatedAt >= today)))}</div><div class="s">${ext.filter((p) => p.direction === 'disbursement' && p.status === 'failed').length} failed (reversed)</div></div>
        <div class=${'kpi' + (lc && !lc.ok ? ' alert' : '')}><div class="l">Ledger check</div><div class="v" style="font-size:20px">${lc ? (lc.ok ? '✓ Balanced' : '✗ ' + (lc.walletMismatches.length + lc.paymentMismatches.length) + ' issues') : '—'}</div><div class="s"><button class="linkbtn" style="padding:0;font-size:12px" onClick=${() => D.run('o-lc', async () => { t.ledger = await act.ledgerCheck(); }, ok('Ledger checked'))}>${lc ? 'Run again · ' + F.time(new Date(lc.checkedAt).getTime()) : 'Run check'}</button></div></div>
      </div>
      <div class="pills">${[['action', 'Needs action'], ['open', 'In flight'], ['failed', 'Failed'], ['collections', 'Collections'], ['payouts', 'Cash-outs'], ['all', 'All']].map(([k, l]) => html`<button class="pill" aria-pressed=${f === k ? 'true' : 'false'} onClick=${() => set({ pf: k })}>${l} · ${ext.filter(PAYF[k]).length}</button>`)}</div>
      <div class="ops-cols">
        <section class="ops-card" style="flex:3 1 520px"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Party</th><th>Type</th><th>Method</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
          ${list.slice(0, 200).map((p) => html`<tr class=${'click' + (o.psel === p.id ? ' sel' : '')} onClick=${() => set({ psel: p.id })}><td style="white-space:nowrap">${F.dayTime(p.createdAt)}</td><td>${payParty(p)}</td><td>${p.direction === 'disbursement' ? 'Cash-out' : p.purpose === 'topup' ? 'Top-up' : 'Delivery ' + (p.did || '')}${p.needsReview ? html` <span style="color:var(--bad)" title="Needs review">●</span>` : null}</td><td>${D.payments.methodLabel(p.method)}${p.simulated ? html` <span class="cap">sandbox</span>` : null}</td><td><${D.PayChip} p=${p} /></td><td class="num">${F.num(p.amount)}</td></tr>`)}
          ${!list.length ? html`<tr><td colspan="6"><div class="empty">${f === 'action' ? 'Nothing needs ops. Large cash-outs and flagged payments appear here.' : 'No payments match.'}</div></td></tr>` : null}</tbody></table></div></section>
        ${sel ? html`<${PayDrawer} p=${sel} />` : html`<section class="drawer" style="flex:2 1 360px"><div class="empty">Select a payment to see the provider log and decide on approvals.</div></section>`}
      </div>`;
  };
  const Payments = () => {
    const o = O(), s = S.state;
    const view = o.payView || 'provider';
    const q = (o.txQ || '').toLowerCase();
    const name = (t) => t.party === 'vendor' ? (S.vendor(t.partyId) || {}).name : t.party === 'rider' ? (S.rider(t.partyId) || {}).name : 'Drop Off';
    const list = s.transactions.filter((t) => (o.txFilter === 'all' || t.party === o.txFilter) && (!q || (t.id + t.label + (t.method || '') + (t.did || '') + (name(t) || '')).toLowerCase().includes(q)));
    const sum = (f) => s.transactions.filter(f).reduce((a, t) => a + t.amount, 0);
    const sandbox = (s.settings.payment_provider || 'sandbox') === 'sandbox';
    return html`<div class="ops-main">
      <div class="ops-h"><div><h2>Payments</h2><div class="cap">Provider: <b>${s.settings.payment_provider || 'sandbox'}</b>${sandbox ? ' · sandbox, no real money moves' : ''} · money moves only when the provider confirms</div></div><input class="search" style="flex:1 1 240px;max-width:380px" aria-label="Search payments" placeholder="Search ID, reference, phone, delivery, party" value=${o.txQ} onInput=${(e) => set({ txQ: e.target.value })} /></div>
      <div class="pills">${[['provider', 'Mobile money & card'], ['ledger', 'Wallet ledger']].map(([k, l]) => html`<button class="pill" aria-pressed=${view === k ? 'true' : 'false'} onClick=${() => set({ payView: k })}>${l}</button>`)}</div>
      ${view === 'provider' ? html`<${ProviderPayments} />` : html`
      <div class="kpis">
        <div class="kpi"><div class="l">Captured from vendors</div><div class="v">${F.k(-sum((t) => t.type === 'charge' && t.status === 'paid'))}</div><div class="s">UGX · completed deliveries</div></div>
        <div class="kpi"><div class="l">Reserved (in progress)</div><div class="v">${F.k(-sum((t) => t.type === 'charge' && t.status === 'held'))}</div><div class="s">Captured on delivery or refunded</div></div>
        <div class="kpi"><div class="l">Driver earnings</div><div class="v">${F.k(sum((t) => t.party === 'rider' && t.type === 'earning'))}</div><div class="s">${F.k(s.riders.reduce((a, r) => a + r.balance, 0))} awaiting payout</div></div>
        <div class="kpi"><div class="l">Commission</div><div class="v">${F.k(sum((t) => t.type === 'commission'))}</div><div class="s">Platform revenue</div></div>
        <div class="kpi"><div class="l">Refunds</div><div class="v">${F.k(sum((t) => t.type === 'refund'))}</div><div class="s">Cancellations, failures, disputes</div></div>
      </div>
      <div class="pills">${[['all', 'All'], ['vendor', 'Vendors'], ['rider', 'Drivers'], ['platform', 'Platform']].map(([k, l]) => html`<button class="pill" aria-pressed=${o.txFilter === k ? 'true' : 'false'} onClick=${() => set({ txFilter: k })}>${l}</button>`)}</div>
      <section class="ops-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Time</th><th>Party</th><th>Type</th><th>Label</th><th>Method</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
        ${list.slice(0, 200).map((t) => html`<tr class=${t.did ? 'click' : ''} onClick=${() => t.did && open(t.did)}><td class="mono" style="font-size:12px">${t.id}</td><td style="white-space:nowrap">${F.dayTime(t.ts)}</td><td>${name(t)}${t.wallet === 'credit' ? ' · credit' : ''}</td><td>${t.type}</td><td>${t.label}</td><td>${t.method || ''}</td><td>${t.status}</td><td class="num" style=${t.amount > 0 ? 'color:var(--ok)' : ''}>${t.amount > 0 ? '+' : '−'}${F.num(Math.abs(t.amount))}</td></tr>`)}
        ${!list.length ? html`<tr><td colspan="8"><div class="empty">No transactions match.</div></td></tr>` : null}</tbody></table></div></section>`}
    </div>`;
  };

  /* ---------------- support & disputes ---------------- */
  const Disputes = () => {
    const s = S.state, t = T();
    const f = t.tf || 'open';
    const list = s.tickets.filter((x) => f === 'all' || (f === 'open' ? !['resolved', 'closed'].includes(x.status) : x.status === f));
    return html`<div class="ops-main"><div class="ops-h"><h2>Support & disputes</h2></div>
      <div class="pills">${[['open', 'Open'], ['in_review', 'In review'], ['waiting_for_user', 'Waiting for user'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => html`<button class="pill" aria-pressed=${f === k ? 'true' : 'false'} onClick=${() => { t.tf = k; D.rerender(); }}>${l}</button>`)}</div>
      <section class="ops-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Case</th><th>Delivery</th><th>Type</th><th>From</th><th>Details</th><th>Opened</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map((x) => { const d = x.did && S.delivery(x.did); const disputed = d && d.status === 'disputed' && d.disputeTicket === x.id; return html`<tr><td class="mono">${x.id}</td><td>${d ? html`<button class="linkbtn" style="padding:0" onClick=${() => open(d.id)}>${d.id}</button>` : '—'}</td><td>${x.title}</td><td>${x.by}</td><td style="max-width:260px">${x.note || '—'}${x.resolutionNote ? html`<div class="cap">Reply: ${x.resolutionNote}</div>` : null}</td><td style="white-space:nowrap">${F.dayTime(x.createdAt)}</td><td><span class=${'chip ' + (['resolved', 'closed'].includes(x.status) ? 'ok' : 'mari')}>${x.resolution && x.resolution !== 'resolved' ? x.resolution.replace('_', ' ') : D.TICKET[x.status]}</span></td>
          <td>${['resolved', 'closed'].includes(x.status) ? (x.status === 'resolved' ? html`<button class="btn sm white" onClick=${() => D.run('o-tk' + x.id, () => act.updateTicket(x.id, 'closed'), ok('Case closed'))}>Close</button>` : null)
            : disputed ? html`<button class="btn sm ink" onClick=${() => open(d.id)}>Review proof</button>`
            : html`<span style="display:flex;gap:6px;flex-wrap:wrap"><input class="search" style="width:170px" aria-label="Reply to the customer" placeholder="Reply to the customer" value=${t['n' + x.id] || ''} onInput=${(e) => { t['n' + x.id] = e.target.value; }} />${x.status === 'open' ? html`<button class="btn sm white" onClick=${() => D.run('o-tk' + x.id, () => act.updateTicket(x.id, 'in_review', t['n' + x.id]), ok('Case in review'))}>Take</button>` : null}<button class="btn sm white" onClick=${() => D.run('o-tk' + x.id, () => act.updateTicket(x.id, 'waiting_for_user', t['n' + x.id]), ok('Waiting for the customer'))}>Ask user</button><button class="btn sm ink" onClick=${() => D.run('o-tk' + x.id, () => act.resolveTicket(x.id, 'resolved', t['n' + x.id] || 'Resolved by ops'), ok('Case ' + x.id + ' resolved · customer notified'))}>Resolve</button></span>`}</td></tr>`; })}
        ${!list.length ? html`<tr><td colspan="8"><div class="empty">No support cases here.</div></td></tr>` : null}</tbody></table></div></section></div>`;
  };

  /* ---------------- SMS outbox & audit ---------------- */
  const Messages = () => {
    const t = T();
    const q = (t.mq || '').toLowerCase();
    const list = S.state.sms.filter((n) => !q || (n.body + (n.phone || '') + (n.did || '')).toLowerCase().includes(q));
    return html`<div class="ops-main"><div class="ops-h"><div><h2>SMS outbox</h2><div class="cap">${S.state.settings.sms_mode === 'live' ? "Live: queued messages are sent by Africa's Talking through the sms-dispatch function." : 'Simulated: recipient messages are recorded but not sent. Set sms_mode to "live" with Africa\'s Talking configured (sms-dispatch function) to send them.'}</div></div><input class="search" style="flex:1 1 240px;max-width:380px" aria-label="Search messages" placeholder="Search phone, delivery or text" value=${t.mq || ''} onInput=${(e) => { t.mq = e.target.value; D.rerender(); }} /></div>
      <section class="ops-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>To</th><th>Delivery</th><th>Message</th><th>Status</th></tr></thead><tbody>
        ${list.map((n) => html`<tr class=${n.did ? 'click' : ''} onClick=${() => n.did && open(n.did)}><td style="white-space:nowrap">${F.dayTime(n.ts)}</td><td class="mono" style="white-space:nowrap">${n.phone}</td><td class="mono">${n.did || '—'}</td><td style="max-width:520px">${n.body}</td><td><span class="chip grey">${n.smsStatus}</span></td></tr>`)}
        ${!list.length ? html`<tr><td colspan="5"><div class="empty">No messages.</div></td></tr>` : null}</tbody></table></div></section></div>`;
  };

  const Audit = () => {
    const t = T();
    const q = (t.aq || '').toLowerCase();
    const list = S.state.audit.filter((a) => !q || (a.type + (a.actor || '') + (a.targetId || '') + JSON.stringify(a.meta || {})).toLowerCase().includes(q));
    return html`<div class="ops-main"><div class="ops-h"><div><h2>Audit log</h2><div class="cap">Registrations, verification decisions, bookings, assignments, payments and every ops action · latest 200</div></div><input class="search" style="flex:1 1 240px;max-width:380px" aria-label="Search audit log" placeholder="Search event, person or target" value=${t.aq || ''} onInput=${(e) => { t.aq = e.target.value; D.rerender(); }} /></div>
      <section class="ops-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Target</th><th>Details</th></tr></thead><tbody>
        ${list.map((a) => { const d = a.deliveryId && S.delivery(a.deliveryId); return html`<tr class=${d ? 'click' : ''} onClick=${() => d && open(d.id)}><td style="white-space:nowrap">${F.dayTime(a.ts)}</td><td class="mono" style="font-size:12px">${a.type}</td><td>${a.actor || '—'}${a.role ? html` <span class="cap">(${a.role})</span>` : null}</td><td>${a.target || ''} ${a.targetId && a.targetId.length < 20 ? a.targetId : d ? d.id : ''}</td><td class="cap" style="max-width:420px">${Object.entries(a.meta || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' · ')}</td></tr>`; })}
        ${!list.length ? html`<tr><td colspan="5"><div class="empty">No audit entries match.</div></td></tr>` : null}</tbody></table></div></section></div>`;
  };

  /* ---------------- config ---------------- */
  const Config = () => {
    const s = S.state;
    const num = (c, f) => html`<input class="num-in" aria-label=${S.cls(c).label + ' ' + f} value=${(s.pricing[c] || {})[f]} onChange=${(e) => D.run('o-pr', () => act.updatePricing(c, f, e.target.value), ok(S.cls(c).label + ' ' + f + ' updated · new quotes use it now'))} />`;
    const st = s.settings;
    const sample = D.PLACES.find((p) => p.id === 'kisementi'), sample2 = D.PLACES.find((p) => p.id === 'kabalagala');
    return html`<div class="ops-main"><div class="ops-h"><div><h2>Pricing, vehicles, areas & rules</h2><div class="cap">Changes apply instantly to new vendor quotes and the website estimator. Existing bookings keep their price. Every change is audited.</div></div></div>
      <section class="ops-card"><h3>Pricing (UGX)</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Class</th><th class="num">Base</th><th class="num">Per km</th><th class="num">Minimum</th><th class="num">Fragile</th><th class="num">Express</th><th class="num">Commission %</th><th class="num">Kisementi → Kabalagala</th></tr></thead><tbody>
        ${D.CLASS_ORDER.map((c) => { const ex = sample && sample2 ? S.quote({ pickup: sample, dropoff: sample2, cls: c }) : { total: 0 }; return html`<tr><td><b>${S.cls(c).label}</b></td><td class="num">${num(c, 'base')}</td><td class="num">${num(c, 'perKm')}</td><td class="num">${num(c, 'min')}</td><td class="num">${num(c, 'fragile')}</td><td class="num">${num(c, 'express')}</td><td class="num">${num(c, 'commission')}</td><td class="num">${F.num(ex.total)}</td></tr>`; })}</tbody></table></div></section>
      <div class="ops-cols">
        <section class="ops-card" style="flex:3 1 480px"><h3>Vehicle classes</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Class</th><th>Package sizes</th><th class="num">Max load (kg)</th><th>Drivers</th><th>Live</th></tr></thead><tbody>
          ${s.classes.map((c) => html`<tr><td><span style="display:inline-flex;gap:6px;align-items:center"><${VIcon} c=${c.id} s="18" /><b>${c.label}</b></span></td><td>${D.SIZES.filter((z) => z.eligible.includes(c.id)).map((z) => z.label).join(', ')}</td><td class="num"><input class="num-in" aria-label=${c.label + ' max load'} value=${c.maxKg} onChange=${(e) => D.run('o-cl', () => act.updateClass(c.id, { maxKg: +e.target.value }), ok(c.label + ' max load updated'))} /></td><td>${s.riders.filter((r) => r.cls === c.id && r.verified).length} (${s.riders.filter((r) => r.cls === c.id && r.online).length} online)</td><td><${Toggle} on=${c.enabled} label=${c.label + ' enabled'} onClick=${() => D.run('o-cl', () => act.updateClass(c.id, { enabled: !c.enabled }), ok(c.label + (c.enabled ? ' disabled' : ' enabled')))} /></td></tr>`)}</tbody></table></div></section>
        <section class="ops-card" style="flex:2 1 320px"><h3>Service areas</h3>${s.zones.map((z) => html`<div class="list-row"><span class="grow"><span class="t1" style="display:block">${z.name}</span><span class="t2">${z.note} · ${D.PLACES.filter((p) => p.zone === z.id).length} places</span></span><${Toggle} on=${z.enabled} label=${z.name + ' live'} onClick=${() => D.run('o-z', () => act.toggleZone(z.id), ok(z.name + (z.enabled ? ' closed' : ' opened')))} /></div>`)}
          <div class="cap">Closing an area blocks new drop-offs there.</div></section>
      </div>
      <section class="ops-card"><h3>Delivery rules</h3>
        <div class="list-row"><span class="grow"><span class="t1" style="display:block">Enforce arrival geofence</span><span class="t2">When on, drivers with a GPS fix can't confirm arrival further than ${st.geofence_m} m from the address.</span></span><${Toggle} on=${!!st.enforce_geofence} label="Enforce arrival geofence" onClick=${() => D.run('o-set', () => act.setSetting('enforce_geofence', !st.enforce_geofence), ok('Geofence ' + (st.enforce_geofence ? 'off' : 'on')))} /></div>
        ${[['geofence_m', 'Arrival radius (m)'], ['approach_radius_m', '"Approaching" radius (m)'], ['unreachable_wait_min', 'Wait for unreachable recipient (min)'], ['payout_approval_threshold', 'Cash-outs above this need ops approval (UGX)'], ['payment_expiry_min', 'Mobile money prompt expires after (min)']].map(([k, l]) => html`<div class="list-row"><span class="grow t1">${l}</span><input class="num-in" aria-label=${l} value=${st[k]} onChange=${(e) => D.run('o-set', () => { const v = Math.round(+e.target.value); if (!(v >= 0)) throw new D.UserError('Enter a positive number.'); return act.setSetting(k, v); }, ok(l + ' updated'))} /></div>`)}
        <div class="list-row"><span class="grow"><span class="t1" style="display:block">Tracking link prefix</span><span class="t2">Sent to recipients by SMS, followed by the delivery's secret token.</span></span><input class="search" style="width:280px" aria-label="Tracking link prefix" value=${st.tracking_base_url} onChange=${(e) => D.run('o-set', () => act.setSetting('tracking_base_url', e.target.value.trim()), ok('Tracking link updated'))} /></div>
      </section></div>`;
  };

  D.OpsApp = () => {
    const tab = O().tab;
    const C = { live: Live, deliveries: Deliveries, network: Network, verify: Verify, payments: Payments, disputes: Disputes, messages: Messages, audit: Audit, config: Config }[tab] || Live;
    return html`<div class="ops"><${Nav} /><${C} /></div>`;
  };
})();
