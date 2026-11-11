// js/promo-suggestions.js
// ============================================================================
//  PROMO SUGGESTIONS — the Studio tab's "Suggest products" panel
//
//  One click asks Claude Code, running on the marketing PC, to research the
//  products to feature in a week's FREE Studio slots using the Kapruka MCP,
//  Ninja sales, every past post's sales outcome and the week's occasions /
//  weather. The team approves picks, then clicks a free slot and the post
//  lands on the Studio calendar through the normal addExtraContent() path
//  (so the 3-posts-a-day cap and every existing rule still apply).
//
//  WHY A LOCAL SERVICE: this page runs in the browser from Cloudflare, and a
//  web page cannot start programs. The Post -> Sales Monitor app on the
//  marketing PC (http://127.0.0.1:5300, start.bat) runs `claude -p` and keeps
//  the learning record. If it is not running, the panel says so and nothing
//  else breaks. Override the address with
//    localStorage.setItem('promoServiceUrl', 'http://127.0.0.1:5300')
//
//  LEARNING LOOP: every suggestion that goes into a slot is tracked. When the
//  post goes out, the monitor reads Ninja sales for the next 5 days and marks
//  it lifted / normal / no sale. Those outcomes, plus every other product
//  post's, are what Claude is told sells before it suggests the next week.
//
//  Depends on globals from js/supabase-api.js: getStudioCalendarForRange,
//  addExtraContent, getFixedWeeklySlotType, FIXED_WEEKLY_SLOT_TYPES,
//  DAILY_POSTS_PER_DAY, localDateString, fixedSlotWeekStart.
// ============================================================================
(function () {
  const SERVICE = (localStorage.getItem('promoServiceUrl') || 'http://127.0.0.1:5300').replace(/\/$/, '') + '/api/promo';
  const POLL_MS = 3000;
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TIER_LABEL = { winner: 'Proven seller', lookalike: 'Looks like a winner', novel: 'New & unusual' };
  const OUTCOME_LABEL = {
    likely: ['Lifted sales', 'good'], normal: ['Sold, no lift', 'mid'], no_sale: ['No sale', 'bad'],
    waiting: ['Waiting for the post', 'mut'], no_post_found: ['No post found', 'bad'], open: ['Too early to judge', 'mut']
  };

  const state = { weekStart: null, slots: [], rows: [], items: [], run: null, polling: null, online: null, learnings: null };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const fmtDate = iso => { const d = new Date(`${iso}T00:00:00`); return `${DAY[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`; };
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return localDateString(d); };
  const money = v => (v ? `Rs ${Number(v).toLocaleString('en')}` : '');

  async function api(path, opts = {}) {
    const res = await fetch(SERVICE + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------------------------------------------------------------- slots
  // Free = the daily cap minus booked posts, minus any fixed weekly slot
  // (App Promotion Wed / Corporate Fri) the week still owes, so a promo pick
  // can never take the place a weekly quota needs. Past days have no room.
  function computeSlots(weekStart, rows) {
    const today = localDateString();
    const covered = new Set();
    rows.forEach(r => { const def = getFixedWeeklySlotType(r); if (def) covered.add(def.key); });
    const out = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const dow = new Date(`${date}T00:00:00`).getDay();
      const booked = rows.filter(r => r.date === date && r.booking_status !== 'empty');
      const reserved = FIXED_WEEKLY_SLOT_TYPES.filter(d => d.days.includes(dow) && !covered.has(d.key));
      const free = date < today ? 0 : Math.max(0, DAILY_POSTS_PER_DAY - booked.length - reserved.length);
      out.push({ date, weekday: DAY[dow], free, booked, reserved: reserved.map(d => d.name), past: date < today });
    }
    return out;
  }

  async function loadSlots() {
    const end = addDays(state.weekStart, 6);
    state.rows = await getStudioCalendarForRange(state.weekStart, end);
    state.slots = computeSlots(state.weekStart, state.rows);
  }

  // A promo post must never be counted as a fixed weekly post (App Promotion /
  // Corporate are matched by keyword in the details), so reword those words.
  function safeDetails(text) {
    let t = text;
    const swaps = [[/\bcorporate\b/gi, 'office'], [/\blinked\s*-?\s*in\b/gi, 'professional'],
      [/\bmobile\s*app\b/gi, 'Kapruka'], [/\bapp\s*(promo\w*|download\w*|install\w*|campaign)\b/gi, 'online order']];
    swaps.forEach(([re, w]) => { t = t.replace(re, w); });
    return getFixedWeeklySlotType({ content_details: t }) ? t.replace(/app|corporate/gi, '') : t;
  }

  function detailsFor(item) {
    const lines = [
      `[Promo pick] ${item.name} (${item.code})${item.price ? ' — ' + money(item.price) : ''}`,
      `Hook: ${item.angle || ''}`,
      `Why promote: ${item.reason || ''}`,
      `Evidence: ${(item.evidence || []).join(' ')}`,
      `${TIER_LABEL[item.tier] || item.tier} · ${item.intent === 'self' ? 'Self-purchase' : 'Gift'} · ${item.format || 'Post'}`
    ];
    return safeDetails(lines.join('\n'));
  }

  // ---------------------------------------------------------------- render
  function renderSlots() {
    const box = $('promoSlots');
    if (!box) return;
    const total = state.slots.reduce((n, s) => n + s.free, 0);
    $('promoFreeCount').textContent = total;
    $('promoSuggestBtn').disabled = !state.online || total === 0 || !!state.run && state.run.status === 'running';
    $('promoSuggestBtn').textContent = total
      ? `✨ Suggest products for the ${Math.min(total, 15)} free slot${total === 1 ? '' : 's'}`
      : 'No free slots this week';
    box.innerHTML = state.slots.map(s => {
      const cells = [];
      s.booked.forEach(r => cells.push(`<div class="ps-cell taken" title="${esc(r.content_details || '')}">${esc((r.content_details || r.page_name || 'Booked').slice(0, 38))}</div>`));
      s.reserved.forEach(n => cells.push(`<div class="ps-cell reserved">Kept for ${esc(n)}</div>`));
      for (let i = 0; i < s.free; i++) cells.push('<div class="ps-cell free">Free</div>');
      return `<div class="ps-day${s.past ? ' past' : ''}"><div class="ps-dayhead">${fmtDate(s.date)}<span>${s.free} free</span></div>${cells.join('')}</div>`;
    }).join('');
  }

  function renderContext() {
    const run = state.run;
    const box = $('promoContext');
    if (!box) return;
    if (!run || !run.context) { box.innerHTML = ''; return; }
    const c = run.context;
    const occ = (c.occasions || []).filter(o => o.kind === 'major').map(o => `${esc(o.name)} (${fmtDate(o.date)})`).join(', ');
    box.innerHTML = `
      <div class="ps-chip ${c.mode === 'occasion' ? 'occ' : ''}">${c.mode === 'occasion' ? '🎉 Occasion week: ' + occ : '📅 Regular week, no major occasion'}</div>
      ${c.weather ? `<div class="ps-chip">🌦 ${esc(c.weather.note)}</div>` : ''}
      ${c.payday ? `<div class="ps-chip">💰 ${esc(c.payday)}</div>` : ''}
      ${run.sales_asof ? `<div class="ps-chip">Sales data to ${fmtDate(run.sales_asof)}</div>` : ''}
      ${run.week_note ? `<p class="ps-note">${esc(run.week_note)}</p>` : ''}`;
  }

  function renderProgress() {
    const box = $('promoProgress');
    const run = state.run;
    if (!box) return;
    if (!run || run.status !== 'running') {
      box.hidden = true;
      if (run && run.status === 'error') { box.hidden = false; box.innerHTML = `<div class="ps-error">The run failed: ${esc(run.error)}</div>`; }
      return;
    }
    box.hidden = false;
    const steps = run.progress || [];
    const searches = steps.filter(s => s.startsWith('Searched')).length;
    const checks = steps.filter(s => s.startsWith('Checked')).length;
    box.innerHTML = `<div class="ps-running"><span class="ps-spin"></span> Claude is researching ${run.n} picks:
      ${searches} Kapruka searches, ${checks} products checked so far. This takes about 5 to 15 minutes.</div>
      <ol class="ps-steps">${steps.slice(-8).map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
  }

  function outcomeHtml(o) {
    if (!o) return '';
    const [label, cls] = OUTCOME_LABEL[o.state] || [o.state, 'mut'];
    const extra = o.state === 'likely' || o.state === 'normal' || o.state === 'no_sale'
      ? ` · sold ${o.after} vs ${Math.round((o.expected || 0) * 10) / 10} normal${o.credited ? ` · +${o.credited} credited` : ''}` : (o.note ? ` · ${esc(o.note)}` : '');
    return `<div class="ps-outcome ${cls}">Result: ${label}${extra}</div>`;
  }

  function slotChips(item) {
    return state.slots.filter(s => s.free > 0).map(s =>
      `<button type="button" class="ps-slot${s.date === item.best_day ? ' best' : ''}" data-act="place" data-id="${esc(item.id)}" data-date="${s.date}">
        ${fmtDate(s.date)} <small>${s.free} free${s.date === item.best_day ? ' · suggested' : ''}</small></button>`).join('')
      || '<span class="ps-mut">No free slots left this week. Pick another week above.</span>';
  }

  function itemCard(it) {
    const st = it.status;
    const actions = st === 'suggested'
      ? `<button class="ps-btn ok" data-act="approve" data-id="${esc(it.id)}">✓ Approve</button>
         <button class="ps-btn no" data-act="reject" data-id="${esc(it.id)}">✕ Reject</button>`
      : st === 'approved'
        ? `<div class="ps-pick">Pick a slot: ${slotChips(it)}</div><button class="ps-link" data-act="undo" data-id="${esc(it.id)}">Undo approval</button>`
        : st === 'scheduled'
          ? `<div class="ps-done">✅ In the Studio calendar on ${fmtDate(it.slot_date)}</div>${outcomeHtml(it.outcome)}`
          : `<div class="ps-mut">Rejected</div><button class="ps-link" data-act="undo" data-id="${esc(it.id)}">Undo</button>`;
    const s = it.sales || {};
    return `<div class="ps-card ${st}">
      ${it.image ? `<a href="${esc(it.url)}" target="_blank" rel="noopener"><img src="${esc(it.image)}" alt="" loading="lazy"></a>` : '<div class="ps-noimg"></div>'}
      <div class="ps-body">
        <div class="ps-tags"><span class="ps-tag t-${esc(it.tier)}">${esc(TIER_LABEL[it.tier] || it.tier)}</span>
          <span class="ps-tag ${it.intent === 'self' ? 'self' : 'gift'}">${it.intent === 'self' ? '🛍 Self-purchase' : '🎁 Gift'}</span>
          <span class="ps-tag cat">${esc(it.group)}</span><span class="ps-tag cat">${esc(it.format || 'Post')}</span></div>
        <a class="ps-name" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name)}</a>
        <div class="ps-meta">${money(it.price)} · ${esc(it.code)} · ${s.u60 ? `${s.u60} sold in 60 days` : 'no sales in 60 days'}${it.best_day ? ` · best day ${fmtDate(it.best_day)}` : ''}</div>
        <div class="ps-hook">“${esc(it.angle)}”</div>
        <div class="ps-why"><b>Why promote it</b><p>${esc(it.reason)}</p>
          <ul>${(it.evidence || []).map(e => `<li>${esc(e)}</li>`).join('')}${it.why_now ? `<li>This week: ${esc(it.why_now)}</li>` : ''}</ul></div>
        <div class="ps-actions">${actions}</div>
      </div></div>`;
  }

  function renderItems() {
    const box = $('promoItems');
    if (!box) return;
    const week = state.items.filter(i => i.week_start === state.weekStart);
    const carry = state.items.filter(i => i.week_start !== state.weekStart && i.status === 'approved');
    if (!week.length && !carry.length) {
      box.innerHTML = state.online
        ? '<p class="ps-mut">No suggestions for this week yet. Press the button above.</p>' : '';
      return;
    }
    const order = { approved: 0, suggested: 1, scheduled: 2, rejected: 3 };
    week.sort((a, b) => (order[a.status] - order[b.status]) || (a.best_day || '').localeCompare(b.best_day || ''));
    const mix = { gift: 0, self: 0 }, cats = new Set();
    week.filter(i => i.status !== 'rejected').forEach(i => { mix[i.intent === 'self' ? 'self' : 'gift']++; cats.add(i.group); });
    box.innerHTML = `
      <div class="ps-mix">${week.length} suggestions · ${mix.gift} gift / ${mix.self} self-purchase · ${cats.size} categories ·
        ${week.filter(i => i.status === 'approved').length} approved, ${week.filter(i => i.status === 'scheduled').length} in slots</div>
      ${carry.length ? `<h4 class="ps-h4">Approved earlier, not placed yet</h4><div class="ps-grid">${carry.map(itemCard).join('')}</div>` : ''}
      <div class="ps-grid">${week.map(itemCard).join('')}</div>
      ${state.run && state.run.dropped && state.run.dropped.length ? `<details class="ps-dropped"><summary>${state.run.dropped.length} picks dropped or flagged by the checks</summary><ul>${state.run.dropped.map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}`;
  }

  function renderLearnings() {
    const box = $('promoLearnings');
    const lr = state.learnings;
    if (!box || !lr || !lr.ok) { if (box) box.innerHTML = ''; return; }
    const table = (name, rows) => `<table class="ps-table"><tr><th>${esc(name)}</th><th>Posts</th><th>Lifted sales</th><th>Extra units / post</th><th></th></tr>
      ${rows.map(r => `<tr><td>${esc(r.value)}</td><td>${r.posts}</td><td>${r.likely_rate}%</td><td>${r.credited_per_post}</td>
        <td class="v-${r.verdict.replace(/ /g, '-')}">${r.verdict === 'working' ? 'Working' : r.verdict === 'weak' ? 'Not working' : r.verdict === 'mixed' ? 'Mixed' : 'Too few posts'}</td></tr>`).join('')}</table>`;
    const s = lr.suggestions;
    box.innerHTML = `
      <p class="ps-mut">Learned from ${lr.judged_posts} judged product posts. A post "lifted sales" when the product sold at least double
        its normal rate in the 5 days after. By chance that happens ${lr.false_alarm_rate}% of the time, so a type of post is working only
        when it clearly beats that. Claude reads this before every suggestion run.</p>
      <div class="ps-stats"><div><b>${s.total}</b>suggested</div><div><b>${(s.by_status.scheduled || 0)}</b>put in slots</div>
        <div><b>${s.judged}</b>posted &amp; judged</div><div><b>${s.likely}</b>lifted sales</div><div><b>${s.credited}</b>extra units</div></div>
      <div class="ps-tables">${['Category', 'Occasion or everyday', 'Sales before the post', 'Price', 'Post format', 'Day of week']
        .map(k => table(k, lr.dimensions[k] || [])).join('')}</div>`;
  }

  function renderAll() { renderSlots(); renderContext(); renderProgress(); renderItems(); }

  // ---------------------------------------------------------------- actions
  async function refreshItems() {
    const data = await api(`/suggestions?week=${state.weekStart}`);
    state.items = data.items || [];
    const latest = await api(`/runs/latest?week=${state.weekStart}`);
    state.run = latest.run;
    if (state.run && state.run.status === 'running') startPolling(state.run.id);
  }

  async function checkService() {
    const el = $('promoServiceStatus');
    try {
      const h = await api('/health');
      state.online = !!h.claude;
      el.className = 'ps-status ' + (h.claude ? 'on' : 'off');
      el.textContent = h.claude ? `● Claude ready on this PC (${h.model}) · sales data to ${h.sales_asof || '?'}`
        : '● The service is running but Claude Code was not found on this PC';
    } catch (e) {
      state.online = false;
      el.className = 'ps-status off';
      el.innerHTML = '● Not connected. Start the <b>Post → Sales monitor</b> on the marketing PC (double-click start.bat in PostSalesMonitor), then press Refresh. If Chrome asks to allow local network access, allow it.';
    }
  }

  async function loadWeek() {
    $('promoWeekLabel').textContent = `${fmtDate(state.weekStart)} – ${fmtDate(addDays(state.weekStart, 6))}`;
    try {
      await loadSlots();
    } catch (e) {
      $('promoSlots').innerHTML = `<div class="ps-error">Could not read the Studio calendar: ${esc(e.message)}</div>`;
    }
    await checkService();
    if (state.online) {
      try { await refreshItems(); } catch (e) { console.error(e); }
    } else {
      state.items = []; state.run = null;
    }
    renderAll();
  }

  function startPolling(runId) {
    clearInterval(state.polling);
    state.polling = setInterval(async () => {
      try {
        state.run = await api(`/runs/${runId}`);
        renderProgress();
        if (state.run.status !== 'running') {
          clearInterval(state.polling);
          state.polling = null;
          await refreshItems();
          renderAll();
        }
      } catch (e) { console.error(e); }
    }, POLL_MS);
  }

  async function suggest() {
    await loadSlots();
    const slots = state.slots.filter(s => s.free > 0).map(s => ({ date: s.date, weekday: s.weekday, free: s.free }));
    if (!slots.length) { renderSlots(); return; }
    const studioCodes = state.rows.map(r => r.product_code).filter(Boolean);
    const btn = $('promoSuggestBtn');
    btn.disabled = true;
    try {
      state.run = await api('/runs', { method: 'POST', body: { week_start: state.weekStart, slots, studio_codes: studioCodes } });
      renderProgress();
      startPolling(state.run.id);
    } catch (e) {
      alert('Could not start the suggestion run: ' + e.message);
      btn.disabled = false;
    }
  }

  async function place(id, date) {
    const item = state.items.find(i => i.id === id);
    if (!item) return;
    await loadSlots();
    const slot = state.slots.find(s => s.date === date);
    if (!slot || slot.free <= 0) { alert(`${fmtDate(date)} has no free slot any more. Pick another day.`); renderAll(); return; }
    try {
      const saved = await addExtraContent({
        date, department: 'Digital Marketing', page_name: 'Kapruka FB', format: item.format || 'Post',
        priority: 'Low', content_details: detailsFor(item), reference_links: item.url || '',
        created_by: 'Promo suggestions (Claude)', product_code: item.code
      });
      await api(`/suggestions/${id}/schedule`, { method: 'POST', body: { slot_date: date, studio_id: saved.studio_id || null } });
      await loadSlots();
      await refreshItems();
      renderAll();
      if (typeof loadStudioCalendar === 'function') loadStudioCalendar(true);
    } catch (e) {
      alert('Could not place it: ' + e.message);
    }
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, id } = b.dataset;
    try {
      if (act === 'approve') await api(`/suggestions/${id}/decide`, { method: 'POST', body: { status: 'approved' } });
      else if (act === 'reject') await api(`/suggestions/${id}/decide`, { method: 'POST', body: { status: 'rejected' } });
      else if (act === 'undo') await api(`/suggestions/${id}/decide`, { method: 'POST', body: { status: 'suggested' } });
      else if (act === 'place') { b.disabled = true; await place(id, b.dataset.date); return; }
      await refreshItems();
      renderItems();
    } catch (err) { alert(err.message); }
  }

  async function toggleLearnings() {
    const d = $('promoLearnWrap');
    if (!d.open || state.learnings) return;
    try { state.learnings = await api('/learnings'); } catch (e) { $('promoLearnings').innerHTML = `<div class="ps-error">${esc(e.message)}</div>`; return; }
    renderLearnings();
  }

  function defaultWeek() {
    // Next week's Monday: posts are planned ahead, not on the day.
    return addDays(fixedSlotWeekStart(localDateString()), 7);
  }

  window.initPromoSuggestions = function () {
    const root = $('promoPanel');
    if (!root || root.dataset.ready) return;
    root.dataset.ready = '1';
    state.weekStart = defaultWeek();
    $('promoPrev').onclick = () => { state.weekStart = addDays(state.weekStart, -7); loadWeek(); };
    $('promoNext').onclick = () => { state.weekStart = addDays(state.weekStart, 7); loadWeek(); };
    $('promoRefresh').onclick = () => loadWeek();
    $('promoSuggestBtn').onclick = suggest;
    root.addEventListener('click', onClick);
    $('promoLearnWrap').addEventListener('toggle', toggleLearnings);
    loadWeek();
  };

  // Exposed for the harness/tests only.
  window.__promoTest = { computeSlots, safeDetails, detailsFor, itemCard, state, renderAll };
})();
