const SEVERITY = {
  oos_events_high: 5,
  heading_desc_mismatch: 4,
  poor_image_quality: 4,
  name_incomplete: 3,
  single_image_important: 3,
  minimal_description_important: 3,
  description_illegible_chunk: 2,
};
const SEV_COLOR = { 5: "#d92d20", 4: "#ff6b35", 3: "#ffb800", 2: "#8a8a8a" };

let FLAGS = {};
let activeFlag = null;
let currentCategory = "";

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function init() {
  FLAGS = await api("/api/flags");
  renderFlagChips();

  document.getElementById("catSel").addEventListener("change", (e) => {
    currentCategory = e.target.value; load();
  });

  await loadCategories();
  await load();
}

function renderFlagChips() {
  const wrap = document.getElementById("flagChips");
  wrap.innerHTML = "";
  const allChip = document.createElement("div");
  allChip.className = "chip active";
  allChip.textContent = "All issues";
  allChip.addEventListener("click", () => { activeFlag = null; refreshChipState(); load(); });
  wrap.appendChild(allChip);
  Object.entries(FLAGS).forEach(([key, meta]) => {
    const c = document.createElement("div");
    c.className = "chip";
    c.dataset.flag = key;
    c.textContent = meta.label;
    c.addEventListener("click", () => { activeFlag = key; refreshChipState(); load(); });
    wrap.appendChild(c);
  });
}

function refreshChipState() {
  document.querySelectorAll(".chip").forEach(c => {
    const isAll = !c.dataset.flag;
    c.classList.toggle("active", activeFlag ? c.dataset.flag === activeFlag : isAll);
  });
}

async function loadCategories() {
  const cats = await api("/api/categories");
  const sel = document.getElementById("catSel");
  const prev = sel.value;
  sel.innerHTML = '<option value="">All categories</option>';
  cats.forEach(c => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
  if (cats.includes(prev)) sel.value = prev;
}

async function load() {
  const params = new URLSearchParams();
  if (currentCategory) params.set("category", currentCategory);
  if (activeFlag) params.set("flag", activeFlag);
  const data = await api(`/api/products?${params.toString()}`);

  if (!data.total_scanned) {
    document.getElementById("batchInfo").textContent = "No scans ingested yet.";
    document.getElementById("list").innerHTML = '<div class="empty">No data yet — run the daily scan to populate this dashboard.</div>';
    document.getElementById("summary").innerHTML = "";
    document.getElementById("recheck").innerHTML = "";
    return;
  }

  document.getElementById("batchInfo").textContent =
    `${data.total_scanned} pages scanned, ${data.count} have a real issue`;

  renderSummary(data);
  renderRecheck(data.recheck_items);
  renderList(data.items);
}

function renderSummary(data) {
  const wrap = document.getElementById("summary");
  wrap.innerHTML = "";
  const stat = (n, l, extraClass) => {
    const d = document.createElement("div");
    d.className = "stat" + (extraClass ? " " + extraClass : "");
    d.innerHTML = `<div class="n">${n}</div><div class="l">${l}</div>`;
    return d;
  };
  wrap.appendChild(stat(data.count, "pages with an open issue"));
  wrap.appendChild(stat(data.marked_done, "issues marked done"));
  wrap.appendChild(stat(data.verified_fixed, "confirmed fixed by re-scan", "stat-good"));
  wrap.appendChild(stat(data.needs_recheck, "marked done but still detected", data.needs_recheck ? "stat-bad" : ""));
  if (data.pending_review) {
    wrap.appendChild(stat(data.pending_review, "title/desc checks pending (no AI key set)"));
  }
}

function renderRecheck(items) {
  const wrap = document.getElementById("recheck");
  wrap.innerHTML = "";
  if (!items || !items.length) return;

  const box = document.createElement("div");
  box.className = "recheck-box";
  box.innerHTML = `<div class="recheck-title">⚠ Needs recheck — marked done, but the last scan still found the issue</div>`;
  items.forEach(it => {
    const row = document.createElement("div");
    row.className = "recheck-row";
    row.innerHTML = `
      <a href="${it.url}" target="_blank" rel="noopener">${escapeHtml(it.name)}</a>
      <span class="recheck-flag">${escapeHtml(it.label)}</span>
      <span class="recheck-when">marked done ${it.checked_at ? new Date(it.checked_at).toLocaleDateString() : ""}</span>
      <button type="button" class="recheck-reopen">Re-open</button>
    `;
    row.querySelector(".recheck-reopen").addEventListener("click", async () => {
      await api(`/api/checklist/${it.row_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag: it.flag, checked: false }),
      }).catch(() => {});
      load();
    });
    box.appendChild(row);
  });
  wrap.appendChild(box);
}

function renderList(items) {
  const list = document.getElementById("list");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<div class="empty">No flagged pages for this filter. 🎉</div>';
    return;
  }
  items.forEach(p => list.appendChild(renderProduct(p)));
}

function renderProduct(p) {
  const el = document.createElement("div");
  el.className = "product";

  const head = document.createElement("div");
  head.className = "product-head";
  const nIssues = p.flags.length + (p.needs_manual_review ? 1 : 0);
  head.innerHTML = `
    <span class="badge-count">${p.flags.length}</span>
    ${p.needs_manual_review ? '<span class="review-badge">review</span>' : ""}
    <span class="name">${escapeHtml(p.name || p.title || p.url)}</span>
    <span class="cat">${escapeHtml(p.category || "uncategorized")}</span>
    <span class="users">${p.active_users} users/28d &middot; ${p.impressions || 0} search impr/90d</span>
  `;
  head.addEventListener("click", () => el.classList.toggle("open"));
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "product-body";
  body.innerHTML = `<a class="url" href="${p.url}" target="_blank" rel="noopener">${p.url}</a>`;

  const issuesWrap = document.createElement("div");
  issuesWrap.style.marginTop = "10px";

  p.flags.forEach(flagKey => {
    const meta = FLAGS[flagKey] || { label: flagKey, why: "" };
    issuesWrap.appendChild(renderIssue(p, flagKey, meta.label, meta.why, p.flag_reasons[flagKey]));
  });
  if (p.needs_manual_review && !p.flags.includes("heading_desc_mismatch")) {
    issuesWrap.appendChild(renderIssue(
      p, "heading_desc_mismatch",
      "Heading/description not checked yet",
      "No AI key set up, so this one needs a human look.",
      "Quickly compare the H1 heading against the description text below."
    ));
  }
  body.appendChild(issuesWrap);

  const resolvedFlags = Object.entries(p.checklist)
    .filter(([flagKey, entry]) => entry && entry.checked && !entry.still_flagged);
  if (resolvedFlags.length) {
    const resolvedWrap = document.createElement("div");
    resolvedWrap.className = "resolved-wrap";
    resolvedFlags.forEach(([flagKey, entry]) => {
      const label = (FLAGS[flagKey] || {}).label || flagKey;
      const d = document.createElement("div");
      d.className = "resolved-line";
      d.textContent = `✓ ${label} — confirmed fixed by re-scan${entry.at ? " (marked done " + new Date(entry.at).toLocaleDateString() + ")" : ""}`;
      resolvedWrap.appendChild(d);
    });
    body.appendChild(resolvedWrap);
  }

  el.appendChild(body);
  return el;
}

function renderIssue(product, flagKey, label, why, reason) {
  const row = document.createElement("div");
  const entry = product.checklist[flagKey];
  const checked = !!(entry && entry.checked);
  const mismatch = checked && entry.still_flagged;
  row.className = "issue" + (checked ? " checked" : "") + (mismatch ? " mismatch" : "");

  const sev = SEVERITY[flagKey] || 2;
  const dot = document.createElement("div");
  dot.className = "severity-dot";
  dot.style.background = SEV_COLOR[sev] || "#8a8a8a";
  row.appendChild(dot);

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", async () => {
    await api(`/api/checklist/${product.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flag: flagKey, checked: cb.checked }),
    }).catch(() => {});
    load();
  });
  row.appendChild(cb);

  const text = document.createElement("div");
  text.innerHTML = `
    <div class="label">${escapeHtml(label)}</div>
    <div class="why">${escapeHtml(why || "")}</div>
    <div class="reason">${escapeHtml(reason || "")}</div>
    ${mismatch ? `<div class="still-flagged">⚠ Marked done ${entry.at ? "on " + new Date(entry.at).toLocaleDateString() : ""}, but still detected by the last scan — not actually fixed.</div>` : ""}
  `;
  row.appendChild(text);
  return row;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

init();
