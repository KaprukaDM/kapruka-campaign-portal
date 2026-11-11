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
  const LEVEL_LABEL = { root: 'Category', sub: 'Sub-category', subsub: 'Sub-sub-category' };
  const isCat = it => it.type === 'category';
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
    if (isCat(item)) {
      return safeDetails([
        `[Promo pick: ${LEVEL_LABEL[item.category_level] || 'Category'}] ${item.category_path}`,
        `Page: ${item.category_url}`,
        `Show: ${(item.examples || []).map(e => `${e.name} (${e.code})`).join(', ')}`,
        `Hook: ${item.angle || ''}`,
        `Why promote: ${item.reason || ''}`,
        `${TIER_LABEL[item.tier] || item.tier} · ${item.intent === 'self' ? 'Self-purchase' : 'Gift'} · ${item.format || 'Carousel'}`
      ].join('\n'));
    }
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

  // Three numbers per pick, short enough to read at a glance. Built from the
  // pick's own data (sales) and its evidence lines, so old items render too.
  function chips(it) {
    const out = [];
    const s = it.sales || {};
    if (isCat(it)) {
      if (it.category_products != null) out.push(`<span class="ps-chipn">${it.category_products} products</span>`);
      out.push(`<span class="ps-chipn${s.u60 ? '' : ' mut'}">Examples sold ${s.u60 || 0} / 60d</span>`);
      out.push('<span class="ps-chipn new">First category post</span>');
      return out.join('');
    }
    if (s.u60) {
      let t = '';
      if (s.p30) { const ch = Math.round(100 * (s.u30 - s.p30) / s.p30); t = ` ${ch >= 0 ? '↑' : '↓'}${Math.abs(ch)}%`; }
      out.push(`<span class="ps-chipn">${s.u60} sold / 60d${t}</span>`);
    } else {
      out.push('<span class="ps-chipn mut">No sales yet</span>');
    }
    const ev = (it.evidence || []).join(' ');
    const posted = ev.match(/Posted (\d+) time\(s\) before[^;]*; (\d+) of those lifted/);
    out.push(posted ? `<span class="ps-chipn">Posted ${posted[1]}×, lifted ${posted[2]}×</span>`
      : '<span class="ps-chipn new">Never posted</span>');
    const cat = (it.evidence || []).find(e => e.startsWith(`${it.group} posts lifted`));
    const pct = cat && cat.match(/([\d.]+)% of the time/);
    if (pct) out.push(`<span class="ps-chipn ${Number(pct[1]) >= 20 ? 'good' : 'weak'}">${esc(it.group)} posts lift ${Math.round(pct[1])}%</span>`);
    return out.join('');
  }

  // One sentence of "why", cut at a word. The full reasoning sits in the tooltip.
  function shortWhy(text) {
    const first = String(text || '').split(/(?<=[.!?])\s/)[0];
    return first.length > 120 ? first.slice(0, first.lastIndexOf(' ', 117)) + '…' : first;
  }

  function daySelect(it) {
    const free = state.slots.filter(s => s.free > 0);
    if (!free.length) return '<span class="ps-mut">No free day</span>';
    const pick = free.some(s => s.date === it.best_day) ? it.best_day : free[0].date;
    return `<select class="ps-day-sel" data-id="${esc(it.id)}" aria-label="Day for ${esc(it.name)}">
      ${free.map(s => `<option value="${s.date}"${s.date === pick ? ' selected' : ''}>${fmtDate(s.date)}${s.date === it.best_day ? ' ★' : ''}</option>`).join('')}
    </select>`;
  }

  function itemRow(it) {
    const st = it.status;
    let action;
    if (st === 'scheduled') {
      const o = it.outcome;
      const [label, cls] = o ? (OUTCOME_LABEL[o.state] || [o.state, 'mut']) : ['', ''];
      action = `<span class="ps-done">✅ ${fmtDate(it.slot_date)}</span>${o ? `<span class="ps-outcome ${cls}">${label}${o.credited ? ` +${o.credited}` : ''}</span>` : ''}`;
    } else if (st === 'rejected') {
      action = `<span class="ps-mut">Rejected</span> <button class="ps-link" data-act="undo" data-id="${esc(it.id)}">Undo</button>`;
    } else {
      action = `${daySelect(it)}
        <button class="ps-btn ok" data-act="add" data-id="${esc(it.id)}">Add</button>
        <button class="ps-btn no" data-act="reject" data-id="${esc(it.id)}" title="Reject">✕</button>`;
    }
    return `<tr class="ps-row ${st}">
      <td class="ps-img">${it.image ? `<a href="${esc(it.url)}" target="_blank" rel="noopener"><img src="${esc(it.image)}" alt="" loading="lazy"></a>` : ''}</td>
      <td class="ps-prod"><a class="ps-name" href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.name)}">${isCat(it) ? '📂 ' : ''}${esc(it.name)}</a>
        <div class="ps-meta">${isCat(it) ? `${esc(LEVEL_LABEL[it.category_level] || 'Category')} page · e.g. ${esc((it.examples || []).map(e => e.name).slice(0, 2).join(', '))}` : `${money(it.price)} · ${esc(it.group)}`}</div></td>
      <td class="ps-type">${isCat(it) ? `<span class="ps-tag cat-lvl">${esc(LEVEL_LABEL[it.category_level] || 'Category')}</span>` : ''}<span class="ps-tag t-${esc(it.tier)}">${esc(TIER_LABEL[it.tier] || it.tier)}</span>
        <span class="ps-tag ${it.intent === 'self' ? 'self' : 'gift'}">${it.intent === 'self' ? 'Self' : 'Gift'}</span></td>
      <td class="ps-whycell"><div class="ps-why1" title="${esc(it.reason)}">${esc(shortWhy(it.reason))}</div><div class="ps-chips">${chips(it)}</div></td>
      <td class="ps-act">${action}</td>
    </tr>`;
  }

  function renderItems() {
    const box = $('promoItems');
    if (!box) return;
    const week = state.items.filter(i => i.week_start === state.weekStart);
    if (!week.length) {
      box.innerHTML = state.online ? '<p class="ps-mut">No suggestions for this week yet. Press the button above.</p>' : '';
      return;
    }
    const order = { approved: 0, suggested: 0, scheduled: 1, rejected: 2 };
    week.sort((a, b) => (order[a.status] - order[b.status]) || (a.best_day || '').localeCompare(b.best_day || ''));
    const open = week.filter(i => i.status === 'suggested' || i.status === 'approved');
    const placed = week.filter(i => i.status === 'scheduled').length;
    const live = week.filter(i => i.status !== 'rejected');
    const self = live.filter(i => i.intent === 'self').length;
    box.innerHTML = `
      <div class="ps-listhead">
        <span class="ps-mix">${live.length} picks (${live.filter(isCat).length} category) · ${live.length - self} gift / ${self} self · ${new Set(live.map(i => i.group)).size} categories · ${placed} added</span>
        ${open.length ? `<button class="ps-btn ok" data-act="addall">Add all ${open.length} to their ★ days</button>` : ''}
      </div>
      <table class="ps-list"><tbody>${week.map(itemRow).join('')}</tbody></table>
      <p class="ps-mut ps-foot">★ = suggested day. Hover a reason for the full explanation.</p>`;
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
        created_by: 'Promo suggestions (Claude)', product_code: isCat(item) ? null : item.code
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

  async function addItem(id, date) {
    const item = state.items.find(i => i.id === id);
    if (item && item.status !== 'approved') {
      await api(`/suggestions/${id}/decide`, { method: 'POST', body: { status: 'approved' } });
      item.status = 'approved';
    }
    await place(id, date);
  }

  async function addAll() {
    const open = state.items.filter(i => i.week_start === state.weekStart && (i.status === 'suggested' || i.status === 'approved'));
    if (!open.length || !confirm(`Add ${open.length} posts to the Studio calendar on their suggested days?`)) return;
    await loadSlots();
    const left = Object.fromEntries(state.slots.map(s => [s.date, s.free]));
    let added = 0, skipped = 0;
    for (const it of open) {
      const day = left[it.best_day] > 0 ? it.best_day : Object.keys(left).find(d => left[d] > 0);
      if (!day) { skipped++; continue; }
      try { await addItem(it.id, day); left[day]--; added++; } catch (e) { skipped++; }
    }
    if (skipped) alert(`Added ${added}. ${skipped} could not be added (no free day left).`);
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, id } = b.dataset;
    b.disabled = true;
    try {
      if (act === 'add') {
        const sel = document.querySelector(`.ps-day-sel[data-id="${id}"]`);
        if (!sel) throw new Error('No free day left this week.');
        await addItem(id, sel.value);
        return;
      }
      if (act === 'addall') { await addAll(); await refreshItems(); renderAll(); return; }
      if (act === 'reject') await api(`/suggestions/${id}/decide`, { method: 'POST', body: { status: 'rejected' } });
      else if (act === 'undo') await api(`/suggestions/${id}/decide`, { method: 'POST', body: { status: 'suggested' } });
      await refreshItems();
      renderItems();
    } catch (err) { alert(err.message); b.disabled = false; }
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
  window.__promoTest = { computeSlots, safeDetails, detailsFor, itemRow, state, renderAll };
})();
