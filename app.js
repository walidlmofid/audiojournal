import { h, $, uid, fmtClock, fmtLength, dayKey, fmtTime, fmtDay, fmtDayShort, fmtISODate, todayISO, fmtBytes, fold, icons } from "./util.js";
import * as db from "./db.js";
import { Recorder, supportedFormats } from "./recorder.js";
import { Tags, upgradeTags } from "./tags.js";

const APP_VERSION = "0.2.0";

// A recording looks like this:
//   marks  : [{ t, tag }]  parts — "B" or "I" from second t until the next mark
//   points : [{ t, tag }]  tags — a single point at second t
// (topics / labels are whole-recording tags from the first version; they are
//  still shown and searched, and can be removed in edit mode.)

const state = {
  recs: [],            // every recording (info only; the audio is loaded when played)
  tags: new Tags(),
  filter: { q: "", ids: [], untagged: false, locked: false },
  groups: [],          // what the list currently shows, grouped by day
  recording: null,     // the recording in progress, if any
};

const round1 = x => Math.round(x * 10) / 10;
// Marks are rounded down so they sit at (not after) the moment you tapped.
const floor1 = x => Math.floor(x * 10) / 10;
const byTime = (a, b) => a.t - b.t;

/* ------------------------------------------------------------------ */
/* Screens and sheets. The phone's back button closes the top one.    */
/* ------------------------------------------------------------------ */

const overlays = [];
let skipPop = 0;

// One history entry stands for "something is open". If a "go back" for a
// closed overlay is still on its way, the entry is reused and put back after.
function pushOverlay(o) {
  if (!overlays.length && !history.state?.overlay) history.pushState({ overlay: true }, "");
  overlays.push(o);
  document.body.classList.add("covered");
}

function closeOverlay(o, fromBackButton = false) {
  const i = overlays.indexOf(o);
  if (i < 0) return;
  overlays.splice(i, 1);
  o.close();
  if (!overlays.length) document.body.classList.remove("covered");
  if (!overlays.length && !fromBackButton) { skipPop++; history.back(); }
}

window.addEventListener("popstate", () => {
  if (skipPop) {
    skipPop--;
    if (overlays.length && !history.state?.overlay) history.pushState({ overlay: true }, "");
    return;
  }
  const top = overlays[overlays.length - 1];
  if (!top) return;
  if (top.canClose && !top.canClose()) { history.pushState({ overlay: true }, ""); return; }
  closeOverlay(top, true);
  if (overlays.length) history.pushState({ overlay: true }, "");
});

function openScreen(name, build, { onClose, canClose } = {}) {
  const el = $("#screen-" + name);
  const o = {
    el,
    canClose,
    close() { el.hidden = true; el.replaceChildren(); onClose?.(); },
  };
  el.replaceChildren();
  el.className = "screen";
  el.hidden = false;
  el.scrollTop = 0;
  pushOverlay(o);
  build(el, () => closeOverlay(o));
  return o;
}

function screenHeader(title, onBack, right) {
  return h("header", { class: "screen-head" },
    onBack ? h("button", { class: "icon-btn back", type: "button", "aria-label": "Back", svg: icons.back, onclick: onBack }) : h("span", { class: "head-spacer" }),
    h("div", { class: "screen-title" }, title),
    right || h("span", { class: "head-spacer" }));
}

function openSheet(build, { onClose } = {}) {
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
  const backdrop = h("div", { class: "sheet-backdrop" }, sheet);
  const o = { close() { backdrop.remove(); onClose?.(); } };
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeOverlay(o); });
  document.body.append(backdrop);
  pushOverlay(o);
  build(sheet, () => closeOverlay(o));
  return o;
}

function btn(text, onclick, cls = "") {
  return h("button", { class: "btn " + cls, type: "button", onclick }, text);
}

// Adds children to a sheet, skipping empty ones.
function fill(el, ...kids) {
  el.append(...kids.flat().filter(k => k != null && k !== false));
}

function confirmSheet({ title, body, ok = "OK", cancel = "Cancel", danger = false, typeToConfirm = null }) {
  return new Promise(resolve => {
    let answered = false;
    openSheet((s, close) => {
      const input = typeToConfirm
        ? h("input", { class: "input", placeholder: `Type “${typeToConfirm}”`, autocapitalize: "off", autocomplete: "off" })
        : null;
      const okBtn = btn(ok, () => {
        if (input && fold(input.value.trim()) !== fold(typeToConfirm)) {
          input.classList.remove("shake"); void input.offsetWidth; input.classList.add("shake"); input.focus();
          return;
        }
        answered = true; resolve(true); close();
      }, danger ? "danger" : "primary");
      fill(s,
        h("h3", {}, title),
        body ? (typeof body === "string" ? h("p", { class: "muted" }, body) : body) : null,
        input,
        h("div", { class: "sheet-actions" }, cancel ? btn(cancel, close) : null, okBtn));
    }, { onClose: () => { if (!answered) resolve(false); } });
  });
}

function promptSheet({ title, value = "", placeholder = "", ok = "Save" }) {
  return new Promise(resolve => {
    let answer = null;
    openSheet((s, close) => {
      const input = h("input", { class: "input", value, placeholder, autocomplete: "off", autocapitalize: "off", enterkeyhint: "done" });
      const submit = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } answer = v; close(); };
      input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
      fill(s, h("h3", {}, title), input, h("div", { class: "sheet-actions" }, btn("Cancel", close), btn(ok, submit, "primary")));
      setTimeout(() => input.focus(), 50);
    }, { onClose: () => resolve(answer) });
  });
}

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ */
/* Tags and the B / I buttons                                         */
/* ------------------------------------------------------------------ */

// Asks for a name and creates the tag. A tag that already exists is reused.
async function newTag() {
  const name = await promptSheet({ title: "New tag", placeholder: "e.g. just_chatting", ok: "Add" });
  if (!name) return null;
  const same = state.tags.tags().find(t => fold(t.name) === fold(name));
  if (same) { toast("You already have this tag."); return same; }
  const t = { id: uid(), kind: "label", name, parentId: null, order: Date.now(), createdAt: Date.now() };
  try { await db.put("tags", t); } catch (err) { toast("Could not save: " + err.message); return null; }
  state.tags.set([...state.tags.list, t]);
  return t;
}

// The buttons you tap while recording or listening: B / I start a part,
// a tag drops a point.
function markPad({ onPart, onPoint }) {
  const wrap = h("div", { class: "pad" });
  let active = null;
  const render = () => {
    wrap.replaceChildren(
      h("div", { class: "pad-row" }, state.tags.parts().map(t => h("button", {
        class: "pad-btn" + (t.id === active ? " active" : ""), type: "button", style: `--c:${t.color}`, "data-id": t.id,
        onclick: () => onPart(t.id),
      }, t.name))),
      h("div", { class: "pad-tags" },
        state.tags.tags().map(t => h("button", {
          class: "tag-btn", type: "button",
          onclick: e => {
            onPoint(t.id);
            const b = e.currentTarget;
            b.classList.add("flash");
            setTimeout(() => b.classList.remove("flash"), 350);
          },
        }, t.name)),
        h("button", { class: "tag-btn add", type: "button", onclick: async () => { if (await newTag()) render(); } }, "+ new tag")));
  };
  render();
  return {
    el: wrap,
    render,
    // Lights up the part that is running right now.
    setActive(id) {
      if (id === active) return;
      active = id;
      for (const b of wrap.querySelectorAll(".pad-btn")) b.classList.toggle("active", b.dataset.id === id);
    },
  };
}

// Parts of a recording: each mark starts a part that lasts until the next mark.
function segments(r, duration) {
  const d = duration || r.durationSec || 0;
  const ms = [...(r.marks || [])].sort(byTime);
  return ms.map((m, i) => ({ start: m.t, end: Math.max(m.t, i + 1 < ms.length ? ms[i + 1].t : d), tag: m.tag, mark: m }));
}

function partAt(r, t, duration) {
  let found = null;
  for (const s of segments(r, duration)) if (t >= s.start) found = s;
  return found;
}

// Starts a part at second t (unless that part is already running).
function addPart(r, t, id, duration) {
  const cur = partAt(r, t, duration);
  if (cur && state.tags.root(cur.tag)?.id === id) return false;
  if (cur && cur.start === t) cur.mark.tag = id;
  else r.marks = [...(r.marks || []), { t, tag: id }].sort(byTime);
  return true;
}

function addPoint(r, t, id) {
  r.points = [...(r.points || []), { t, tag: id }].sort(byTime);
}

// Coloured bars for the parts and dots for the tags, placed along a timeline.
function drawTimeline(r, dur, barLayer, dotLayer) {
  barLayer.replaceChildren();
  dotLayer.replaceChildren();
  if (!dur) return;
  const pct = x => Math.min(100, (x / dur) * 100);
  for (const s of segments(r, dur)) {
    barLayer.append(h("span", { style: `left:${pct(s.start)}%;width:${pct(s.end - s.start)}%;background:${state.tags.color(s.tag)}` }));
  }
  for (const p of r.points || []) dotLayer.append(h("span", { style: `left:${pct(p.t)}%` }));
}

function strip(r) {
  const bars = h("div", { class: "strip-bars" });
  const dots = h("div", { class: "strip-dots" });
  drawTimeline(r, r.durationSec || 0, bars, dots);
  return h("div", { class: "strip" }, dots, bars);
}

// The list of everything marked on a recording, in order of time.
function marksList(r, dur, { onJump, onRemove, empty } = {}) {
  const rows = [
    ...segments(r, dur).map(s => ({ t: s.start, tag: s.tag, part: true, len: dur ? s.end - s.start : 0, from: "marks", ref: s.mark })),
    ...(r.points || []).map(p => ({ t: p.t, tag: p.tag, from: "points", ref: p })),
  ].sort(byTime);
  // Whole-recording tags from the first version of the app.
  for (const id of r.topics || []) rows.push({ tag: id, part: true, from: "topics" });
  for (const id of r.labels || []) rows.push({ tag: id, from: "labels" });

  const box = h("div", { class: "marks" });
  if (!rows.length && empty) box.append(h("p", { class: "muted small" }, empty));
  for (const row of rows) {
    const timed = row.t != null;
    const time = timed ? fmtClock(row.t) : "all";
    box.append(h("div", { class: "mark-row " + (row.part ? "part" : "point"), style: `--c:${state.tags.color(row.tag)}` },
      onJump && timed
        ? h("button", { class: "mark-time", type: "button", title: "Play from here", onclick: () => onJump(row.t) }, "▶ " + time)
        : h("span", { class: "mark-time" }, time),
      h("span", { class: "mark-tag" }, row.part ? null : h("span", { class: "dot" }), state.tags.name(row.tag)),
      row.len ? h("span", { class: "mark-len" }, fmtLength(row.len)) : null,
      onRemove ? h("button", {
        class: "icon-btn", type: "button", "aria-label": "Remove",
        onclick: () => {
          r[row.from] = timed ? r[row.from].filter(x => x !== row.ref) : r[row.from].filter(x => x !== row.tag);
          onRemove();
        },
      }, "✕") : null));
  }
  return box;
}

/* ------------------------------------------------------------------ */
/* Library list, search and filters                                   */
/* ------------------------------------------------------------------ */

const isDue = r => r.lock && r.lock.until <= todayISO();
const isTagged = r => !!(r.marks?.length || r.points?.length || r.topics?.length || r.labels?.length);
const needsTagging = r => !r.lock && !isTagged(r);

// Does the recording have this part (B / I) or this tag anywhere?
function hasTag(r, id) {
  if (state.tags.isPart(id)) {
    const want = state.tags.descendants(id);
    return (r.marks || []).some(m => want.has(m.tag)) || (r.topics || []).some(i => want.has(i));
  }
  return (r.points || []).some(p => p.tag === id) || (r.labels || []).includes(id);
}

// Which parts and tags a recording has, without repeats.
function tagsOf(r) {
  const parts = new Set(), tags = new Set();
  for (const id of [...(r.marks || []).map(m => m.tag), ...(r.topics || [])]) {
    const root = state.tags.root(id);
    if (root) parts.add(root.id);
  }
  for (const id of [...(r.points || []).map(p => p.tag), ...(r.labels || [])]) if (state.tags.get(id)) tags.add(id);
  return { parts: [...parts], tags: [...tags] };
}

function haystack(r) {
  const when = [dayKey(r.startedAt), fmtDay(r.startedAt), fmtTime(r.startedAt)].join(" ");
  if (r.lock) return fold(when + " locked");
  const { parts, tags } = tagsOf(r);
  return fold([r.title, r.note, r.originalName, when, ...[...parts, ...tags].map(id => state.tags.name(id))].join(" "));
}

function matches(r) {
  const f = state.filter;
  if (f.untagged && !needsTagging(r)) return false;
  if (f.locked && !r.lock) return false;
  if (f.ids.length) {
    if (r.lock) return false;
    for (const id of f.ids) if (!hasTag(r, id)) return false;
  }
  if (f.q.trim()) {
    const hay = haystack(r);
    for (const tok of fold(f.q).split(/\s+/).filter(Boolean)) if (!hay.includes(tok)) return false;
  }
  return true;
}

function renderAll() {
  renderBanner();
  renderFilters();
  renderList();
}

function renderBanner() {
  const el = $("#banner");
  el.replaceChildren();
  if (db.isReadOnly()) {
    el.append(h("span", {}, "This data was saved by a newer version of the app. Nothing can be changed until you reload."),
      btn("Reload", () => location.reload(), "primary small"));
    el.hidden = false;
    return;
  }
  const due = state.recs.filter(isDue);
  if (due.length) {
    el.append(h("span", {}, `🔓 ${due.length} locked recording${due.length > 1 ? "s have" : " has"} reached the unlock date.`),
      btn("Decide", () => openLocked(due[0]), "primary small"));
    el.hidden = false;
    return;
  }
  el.hidden = true;
}

function renderFilters() {
  const f = state.filter;
  const chip = (content, on, onclick, color) =>
    h("button", { class: "fchip" + (on ? " on" : ""), type: "button", onclick, style: color ? `--c:${color}` : null }, content);
  const toggle = id => { f.ids = f.ids.includes(id) ? f.ids.filter(x => x !== id) : [...f.ids, id]; renderAll(); };
  $("#filters").replaceChildren(
    chip("Not tagged yet", f.untagged, () => { f.untagged = !f.untagged; renderAll(); }),
    ...state.tags.parts().map(t => chip([h("span", { class: "dot" }), t.name], f.ids.includes(t.id), () => toggle(t.id), t.color)),
    ...state.tags.tags().map(t => chip(t.name, f.ids.includes(t.id), () => toggle(t.id))),
    chip("🔒 Locked", f.locked, () => { f.locked = !f.locked; renderAll(); }),
  );
}

function filtersActive() {
  const f = state.filter;
  return !!(f.q.trim() || f.ids.length || f.untagged || f.locked);
}

function renderList() {
  const list = $("#list");
  const items = state.recs.filter(r => r.status !== "recording").filter(matches).sort((a, b) => b.startedAt - a.startedAt);
  const groups = [];
  for (const r of items) {
    const key = dayKey(r.startedAt);
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, ts: r.startedAt, items: [] });
    groups[groups.length - 1].items.push(r);
  }
  state.groups = groups;

  const total = items.reduce((s, r) => s + (r.durationSec || 0), 0);
  const all = state.recs.filter(r => r.status !== "recording").length;
  $("#summary").textContent = filtersActive() ? `${items.length} of ${all}` : all ? `${all} · ${fmtLength(total)}` : "";

  list.replaceChildren();
  if (!items.length) {
    list.append(all
      ? h("div", { class: "empty" }, h("p", {}, "Nothing matches."), btn("Clear search and filters", clearFilters))
      : h("div", { class: "empty" },
          h("p", { class: "empty-title" }, "No recordings yet"),
          h("p", { class: "muted" }, "Tap the lime button to record. Already have recordings on this phone? Import them."),
          btn("Import old recordings", () => $("#import-input").click(), "primary")));
    renderRail();
    return;
  }
  for (const g of groups) {
    const len = g.items.reduce((s, r) => s + (r.durationSec || 0), 0);
    list.append(h("section", { class: "day", "data-day": g.key },
      h("div", { class: "day-head" },
        h("span", {}, fmtDay(g.ts)),
        h("span", { class: "day-meta" }, `${g.items.length} · ${fmtLength(len)}`)),
      g.items.map(card)));
  }
  renderRail();
}

function clearFilters() {
  state.filter = { q: "", ids: [], untagged: false, locked: false };
  $("#search").value = "";
  renderAll();
}

// Tap the card to listen; tap the pencil to edit.
function card(r) {
  const time = h("div", { class: "card-time" }, fmtTime(r.startedAt));
  const len = h("div", { class: "card-len" }, fmtClock(r.durationSec));
  if (r.lock) {
    return h("div", { class: "card locked" + (isDue(r) ? " due" : ""), role: "button", tabindex: "0", onclick: () => openLocked(r) },
      time,
      h("div", { class: "card-body" },
        h("div", { class: "card-title" }, h("span", { class: "lock-ico", svg: icons.lock }),
          isDue(r) ? " Unlock date reached" : ` Locked until ${fmtISODate(r.lock.until)}`)),
      len);
  }
  const { parts, tags } = tagsOf(r);
  const chips = [
    ...parts.map(id => h("span", { class: "chip", style: `--c:${state.tags.color(id)}` }, state.tags.name(id))),
    ...tags.map(id => h("span", { class: "chip label" }, state.tags.name(id))),
  ];
  const shown = chips.slice(0, 4);
  if (chips.length > 4) shown.push(h("span", { class: "chip more" }, `+${chips.length - 4}`));
  const focus = state.filter.ids[0];
  return h("div", { class: "card", role: "button", tabindex: "0", onclick: () => openDetail(r.id, { focus }) },
    time,
    h("div", { class: "card-body" },
      h("div", { class: "card-title" + (r.title ? "" : " muted") }, r.title || "Untitled"),
      r.marks?.length || r.points?.length ? strip(r) : null,
      shown.length ? h("div", { class: "chips" }, shown) : null),
    h("div", { class: "card-side" },
      len,
      h("button", {
        class: "icon-btn edit-btn", type: "button", "aria-label": "Edit", title: "Edit", svg: icons.pencil,
        onclick: e => { e.stopPropagation(); openDetail(r.id, { edit: true, focus }); },
      })));
}

/* Time rail: a vertical bar on the right. Its height covers the whole time
   span of the list, so busy days and quiet weeks are visible at a glance.
   Drag it to jump to a date. */

const dayNum = key => { const [y, m, d] = key.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };

function renderRail() {
  const rail = $("#rail");
  const ticks = $("#rail-ticks");
  const g = state.groups;
  ticks.replaceChildren();
  if (g.length < 2) { rail.hidden = true; state.rail = null; return; }
  const max = dayNum(g[0].key), min = dayNum(g[g.length - 1].key), span = max - min || 1;
  state.rail = { max, min, span };
  for (const grp of g) {
    const secs = grp.items.reduce((s, r) => s + (r.durationSec || 0), 0);
    const w = 4 + Math.min(14, Math.sqrt(secs / 60) * 2.2);
    ticks.append(h("span", { class: "rail-tick", style: `top:${((max - dayNum(grp.key)) / span) * 100}%;width:${w}px` }));
  }
  // Month names along the rail.
  const first = new Date(g[g.length - 1].ts);
  let y = first.getFullYear(), m = first.getMonth() + 1;
  for (let i = 0; i < 600; i++) {
    if (m > 11) { m = 0; y++; }
    const n = Date.UTC(y, m, 1) / 864e5;
    if (n > max) break;
    const name = new Date(y, m, 1).toLocaleDateString("en-GB", { month: "short" }) + (m === 0 ? ` ${String(y).slice(2)}` : "");
    ticks.append(h("span", { class: "rail-month", style: `top:${((max - n) / span) * 100}%` }, name));
    m++;
  }
  rail.hidden = false;
  updateRailThumb();
}

function topHeight() {
  return $("#top").getBoundingClientRect().height;
}

function updateRailThumb() {
  if (!state.rail) return;
  const topH = topHeight();
  let key = null;
  for (const sec of document.querySelectorAll("#list .day")) {
    if (sec.getBoundingClientRect().bottom > topH + 8) { key = sec.dataset.day; break; }
  }
  if (!key) return;
  const { max, span } = state.rail;
  $("#rail-thumb").style.top = `${((max - dayNum(key)) / span) * 100}%`;
}

function railJump(clientY) {
  if (!state.rail) return;
  const box = $("#rail-ticks").getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
  const { max, span } = state.rail;
  const target = max - frac * span;
  let best = state.groups[0], bestDist = Infinity;
  for (const g of state.groups) {
    const d = Math.abs(dayNum(g.key) - target);
    if (d < bestDist) { best = g; bestDist = d; }
  }
  const sec = document.querySelector(`#list .day[data-day="${best.key}"]`);
  if (sec) window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - topHeight() + 1 });
  const bubble = $("#rail-bubble");
  bubble.textContent = fmtDayShort(best.ts);
  bubble.style.top = `${clientY - $("#rail").getBoundingClientRect().top}px`;
  bubble.hidden = false;
  updateRailThumb();
}

function bindRail() {
  const rail = $("#rail");
  let dragging = false, hideTimer;
  rail.addEventListener("pointerdown", e => {
    dragging = true;
    rail.setPointerCapture(e.pointerId);
    rail.classList.add("active");
    clearTimeout(hideTimer);
    railJump(e.clientY);
    e.preventDefault();
  });
  rail.addEventListener("pointermove", e => { if (dragging) railJump(e.clientY); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove("active");
    hideTimer = setTimeout(() => { $("#rail-bubble").hidden = true; }, 900);
  };
  rail.addEventListener("pointerup", end);
  rail.addEventListener("pointercancel", end);
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; updateRailThumb(); });
  }, { passive: true });
}

/* ------------------------------------------------------------------ */
/* Lock ("dangerous" recordings)                                       */
/* ------------------------------------------------------------------ */

function plusYear(iso) {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + 1}-${m}-${d}`;
}

// The first 1st of March at least a year away, and the one after.
function lockChoices() {
  const now = new Date();
  const yearAway = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  let y = yearAway.getFullYear();
  if (new Date(y, 2, 1) < yearAway) y++;
  return [`${y}-03-01`, `${y + 1}-03-01`];
}

function lockSheet(r) {
  return new Promise(resolve => {
    let locked = false;
    openSheet((s, close) => {
      const [a, b] = lockChoices();
      let choice = a;
      const custom = h("input", { class: "input", type: "date", min: dayKey(Date.now() + 864e5) });
      const options = h("div", { class: "lock-options" });
      const lockBtn = btn("", async () => {
        if (!choice || choice <= todayISO()) { toast("Pick a date in the future."); return; }
        r.lock = { until: choice, setAt: Date.now() };
        try { await db.saveRecording(r); } catch (err) { r.lock = null; toast("Could not save: " + err.message); return; }
        locked = true;
        close();
      }, "danger");
      const render = () => {
        options.replaceChildren(...[a, b].map(d => h("button", {
          class: "opt" + (choice === d ? " on" : ""), type: "button",
          onclick: () => { choice = d; custom.value = ""; render(); },
        }, fmtISODate(d))));
        lockBtn.textContent = choice ? `Lock until ${fmtISODate(choice)}` : "Pick a date";
      };
      custom.addEventListener("change", () => { choice = custom.value || null; render(); });
      fill(s,
        h("h3", {}, "Lock this recording"),
        h("p", { class: "muted" }, "Until that date you won't be able to play it, and its title, notes and tags stay hidden. When the date comes, you choose: unlock it, or lock it for one more year."),
        options,
        h("label", { class: "field-label" }, "Or another date"),
        custom,
        h("div", { class: "sheet-actions" }, btn("Cancel", close), lockBtn));
      render();
    }, { onClose: () => resolve(locked) });
  });
}

function openLocked(r) {
  openSheet((s, close) => {
    const due = isDue(r);
    fill(s,
      h("h3", {}, due ? "🔓 Unlock date reached" : "🔒 Locked"),
      h("p", { class: "muted" }, `Recorded ${fmtDay(r.startedAt)} at ${fmtTime(r.startedAt)} · ${fmtLength(r.durationSec)}`),
      h("p", {}, due
        ? `You locked this until ${fmtISODate(r.lock.until)}. Listen to it now, or lock it for one more year?`
        : `You decided not to listen to this before ${fmtISODate(r.lock.until)}.`),
      h("div", { class: "sheet-actions col" },
        due ? [
          btn("Unlock it", async () => { await unlock(r); close(); toast("Unlocked."); }, "primary"),
          btn(`Lock until ${fmtISODate(plusYear(r.lock.until))}`, async () => {
            r.lock.until = plusYear(r.lock.until);
            r.lock.extended = (r.lock.extended || 0) + 1;
            try { await db.saveRecording(r); } catch (err) { toast("Could not save: " + err.message); }
            renderAll();
            close();
            toast(`Locked until ${fmtISODate(r.lock.until)}.`);
          }),
          btn("Decide later", close),
        ] : [
          btn("Close", close, "primary"),
          btn("Remove the lock early…", async () => {
            close();
            const ok = await confirmSheet({
              title: "Remove the lock early?",
              body: `You set this lock on purpose, until ${fmtISODate(r.lock.until)}. To remove it anyway, type unlock.`,
              ok: "Remove lock", danger: true, typeToConfirm: "unlock",
            });
            if (ok) { await unlock(r); toast("Unlocked."); }
          }, "quiet"),
        ]));
  });
}

async function unlock(r) {
  const old = r.lock;
  r.lock = null;
  r.unlockedAt = Date.now();
  try { await db.saveRecording(r); } catch (err) { r.lock = old; toast("Could not save: " + err.message); }
  renderAll();
}

/* ------------------------------------------------------------------ */
/* One recording: listen (nothing can change) or edit                  */
/* ------------------------------------------------------------------ */

async function openDetail(id, { edit = false, focus = null } = {}) {
  const r = state.recs.find(x => x.id === id);
  if (!r) return;
  if (r.lock) { openLocked(r); return; }

  const blob = await db.getAudio(id).catch(() => null);
  const url = blob ? URL.createObjectURL(blob) : null;
  const audio = new Audio();
  audio.preload = "metadata";
  let editing = edit && !db.isReadOnly();
  let dur = r.durationSec || 0;
  let raf = 0;
  let saveTimer = null;
  let startAt = 0;
  const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

  const save = async () => {
    clearTimeout(saveTimer); saveTimer = null;
    try { await db.saveRecording(r); } catch (err) { toast("Could not save: " + err.message); }
  };
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); };

  openScreen("detail", (el, close) => {
    /* --- player --- */
    const playBtn = h("button", { class: "play-btn", type: "button", "aria-label": "Play", svg: icons.play });
    const cur = h("span", {}, "0:00");
    const total = h("span", {}, fmtClock(dur));
    const barLayer = h("div", { class: "seek-segs" });
    const dotLayer = h("div", { class: "seek-dots" });
    const progress = h("div", { class: "seek-progress" });
    const thumb = h("div", { class: "seek-thumb" });
    const seek = h("div", { class: "seek" }, barLayer, progress, dotLayer, thumb);
    const nowLine = h("div", { class: "now-line" });
    const speedBtn = h("button", { class: "small-btn", type: "button" }, "1×");

    const play = () => audio.play().catch(err => toast("Can't play: " + err.message));
    const playFrom = t => { audio.currentTime = t; play(); };
    playBtn.onclick = () => (audio.paused ? play() : audio.pause());
    const jump = d => { audio.currentTime = Math.max(0, Math.min(dur || Infinity, audio.currentTime + d)); tick(); };
    speedBtn.onclick = () => {
      const i = (SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length;
      audio.playbackRate = SPEEDS[i];
      speedBtn.textContent = SPEEDS[i] + "×";
    };

    const seekTo = clientX => {
      if (!dur) return;
      const b = seek.getBoundingClientRect();
      audio.currentTime = Math.min(1, Math.max(0, (clientX - b.left) / b.width)) * dur;
      tick();
    };
    let seeking = false;
    seek.addEventListener("pointerdown", e => { seeking = true; seek.setPointerCapture(e.pointerId); seekTo(e.clientX); });
    seek.addEventListener("pointermove", e => { if (seeking) seekTo(e.clientX); });
    seek.addEventListener("pointerup", () => { seeking = false; });
    seek.addEventListener("pointercancel", () => { seeking = false; });

    function tick() {
      const t = audio.currentTime || 0;
      const frac = dur ? Math.min(1, t / dur) : 0;
      progress.style.width = frac * 100 + "%";
      thumb.style.left = frac * 100 + "%";
      cur.textContent = fmtClock(t);
      const s = partAt(r, t, dur);
      pad.setActive(s ? state.tags.root(s.tag)?.id : null);
      nowLine.replaceChildren(s
        ? h("span", { style: `--c:${state.tags.color(s.tag)}` }, h("span", { class: "dot" }), "Now: ", h("b", {}, state.tags.name(s.tag)))
        : "");
    }
    const loop = () => { tick(); raf = requestAnimationFrame(loop); };

    audio.addEventListener("play", () => { playBtn.innerHTML = icons.pause; playBtn.setAttribute("aria-label", "Pause"); cancelAnimationFrame(raf); loop(); });
    audio.addEventListener("pause", () => { playBtn.innerHTML = icons.play; playBtn.setAttribute("aria-label", "Play"); cancelAnimationFrame(raf); tick(); });
    audio.addEventListener("ended", () => { cancelAnimationFrame(raf); tick(); });

    // Recordings made in the browser often don't say how long they are; the
    // length saved while recording is used, and the browser is nudged to
    // work it out so that jumping around works.
    let fixingDuration = false;
    audio.addEventListener("loadedmetadata", () => {
      if (audio.duration === Infinity) { fixingDuration = true; audio.currentTime = 1e101; return; }
      useDuration();
    });
    audio.addEventListener("durationchange", () => {
      if (fixingDuration && isFinite(audio.duration)) { fixingDuration = false; audio.currentTime = startAt; useDuration(); }
    });
    function useDuration() {
      if (isFinite(audio.duration) && audio.duration > 0) {
        if (!dur || Math.abs(audio.duration - dur) > 2) {
          dur = audio.duration;
          r.durationSec = round1(dur);
          if (!db.isReadOnly()) save();
        }
        total.textContent = fmtClock(dur);
        refresh();
      }
      if (startAt && !fixingDuration) audio.currentTime = startAt;
      tick();
    }

    /* --- B / I and tags --- */
    const now = () => floor1(audio.currentTime || 0);
    const pad = markPad({
      onPart: tag => {
        if (!addPart(r, now(), tag, dur)) { toast(`This part is already “${state.tags.name(tag)}”.`); return; }
        save(); refresh();
      },
      onPoint: tag => { addPoint(r, now(), tag); save(); refresh(); },
    });

    const listBox = h("div");
    function refresh() {
      drawTimeline(r, dur, barLayer, dotLayer);
      listBox.replaceChildren(marksList(r, dur, {
        onJump: playFrom,
        onRemove: editing ? () => { save(); refresh(); } : null,
        empty: editing
          ? "Nothing marked yet. Play the recording, then tap B or I when a part starts, and a tag at the moment it fits."
          : "Not tagged yet. Tap Edit to mark the B / I parts and add tags.",
      }));
      tick();
    }

    /* --- text --- */
    const title = h("input", { class: "title-input", value: r.title || "", placeholder: "Add a title", autocomplete: "off" });
    title.addEventListener("input", () => { r.title = title.value; saveSoon(); });
    const note = h("textarea", { class: "input note", rows: "3", placeholder: "Notes…" });
    note.value = r.note || "";
    note.addEventListener("input", () => { r.note = note.value; saveSoon(); });

    const info = [
      r.source === "import" ? `Imported from “${r.originalName}”` : r.recovered ? "Recorded in this app (recovered after an interruption)" : "Recorded in this app",
      (r.ext || "").toUpperCase(),
      fmtBytes(r.size),
    ].filter(Boolean).join(" · ");

    const player = h("div", { class: "player" },
      seek,
      h("div", { class: "times" }, cur, total),
      h("div", { class: "controls" },
        h("button", { class: "small-btn", type: "button", onclick: () => jump(-10) }, "−10s"),
        playBtn,
        h("button", { class: "small-btn", type: "button", onclick: () => jump(10) }, "+10s"),
        speedBtn),
      nowLine);

    const when = h("span", {}, fmtDayShort(r.startedAt), h("span", { class: "muted" }, " · " + fmtTime(r.startedAt)));
    const section = text => h("h4", { class: "section-title" }, text);

    // The same screen in two modes. Listening shows everything but changes
    // nothing; editing adds the buttons.
    function draw() {
      el.classList.toggle("editing", editing);
      const modeBtn = db.isReadOnly() ? null : btn(editing ? "Done" : "Edit", () => {
        editing = !editing;
        if (!editing && saveTimer) save();
        draw();
      }, "small" + (editing ? " primary" : ""));
      el.replaceChildren(
        screenHeader(when, close, modeBtn),
        h("div", { class: "screen-body" },
          editing ? h("div", { class: "edit-strip" }, "Editing · changes are saved as you make them") : null,
          editing ? title : h("h2", { class: "title-text" + (r.title ? "" : " muted") }, r.title || "Untitled"),
          !url ? h("p", { class: "warn" }, "The audio for this recording is missing on this phone.") : null,
          player,
          editing ? [section("Tap at the moment it starts"), pad.el] : null,
          section("Timeline"),
          listBox,
          editing ? [section("Notes"), note] : r.note ? [section("Notes"), h("p", { class: "note-text" }, r.note)] : null,
          editing ? h("div", { class: "danger-zone" },
            btn("🔒 Lock it (don't listen until later)", async () => {
              audio.pause();
              if (await lockSheet(r)) { close(); toast(`Locked until ${fmtISODate(r.lock.until)}.`); }
            }, "wide"),
            btn("Delete this recording…", () => deleteRec(r, close), "wide quiet danger-text")) : null,
          h("p", { class: "info" }, info)));
      pad.render();
      refresh();
    }
    draw();

    if (focus) {
      const want = state.tags.descendants(focus);
      const hit = [...(r.marks || []), ...(r.points || [])].sort(byTime).find(m => want.has(m.tag));
      if (hit && hit.t > 0) { startAt = hit.t; toast(`Starts at “${state.tags.name(focus)}”.`); }
    }
    if (url) audio.src = url;
  }, {
    onClose() {
      if (saveTimer) save();
      cancelAnimationFrame(raf);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (url) URL.revokeObjectURL(url);
      renderAll();
    },
  });
}

async function deleteRec(r, closeDetail) {
  const what = `${fmtDay(r.startedAt)} at ${fmtTime(r.startedAt)} · ${fmtLength(r.durationSec)}${r.title ? ` · “${r.title}”` : ""}`;
  const where = r.source === "import"
    ? "It is removed from this app. The original file stays in your phone's recorder app."
    : "This is the only copy — it is not backed up anywhere yet.";
  const ok = await confirmSheet({ title: "Delete this recording?", body: h("div", {}, h("p", {}, what), h("p", { class: "muted" }, where)), ok: "Delete", danger: true });
  if (!ok) return;
  try {
    await db.deleteRecording(r.id);
    state.recs = state.recs.filter(x => x !== r);
    closeDetail();
    toast("Deleted.");
  } catch (err) {
    toast("Could not delete: " + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

async function startRecording() {
  if (state.recording) return;
  if (db.isReadOnly()) { toast("Reload the app first (a newer version saved your data)."); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("This browser can't record audio."); return; }

  const now = Date.now();
  const rec = {
    id: uid(), v: 2, startedAt: now, durationSec: 0, mimeType: "", ext: "", size: 0,
    title: "", note: "", marks: [], points: [], lock: null,
    source: "app", status: "recording", createdAt: now, updatedAt: now,
  };
  const session = { rec, seq: 0, queue: Promise.resolve(), stopping: false, wake: null, timer: 0 };
  let showSaveError = () => {};
  const recorder = new Recorder({
    onChunk: blob => {
      const seq = session.seq++;
      rec.durationSec = round1(recorder.elapsed());
      rec.size += blob.size;
      session.queue = session.queue
        .then(() => db.putChunk(rec, seq, blob))
        .catch(err => { session.saveError = err; showSaveError(err); });
    },
    onEnd: reason => stopRecording(session, reason),
  });
  session.recorder = recorder;

  try {
    await recorder.start();
  } catch (err) {
    toast(err.name === "NotAllowedError"
      ? "Microphone blocked. Allow it in Chrome: ⋮ → Settings → Site settings → Microphone."
      : "Can't start recording: " + err.message, 6000);
    return;
  }
  rec.mimeType = recorder.mime;
  rec.ext = recorder.ext;
  rec.startedAt = Date.now();
  try {
    await db.put("recordings", JSON.parse(JSON.stringify(rec)));
  } catch (err) {
    await recorder.stop();
    toast("Can't save on this phone: " + err.message, 6000);
    return;
  }
  state.recording = session;
  navigator.storage?.persist?.().catch(() => {});
  keepAwake(session);

  session.overlay = openScreen("record", el => {
    const timer = h("div", { class: "rec-timer" }, "0:00");
    const meter = h("div", { class: "meter" }, h("div", { class: "meter-fill" }));
    const status = h("div", { class: "rec-status" }, h("span", { class: "rec-dot" }), "Recording · screen stays on");
    const listBox = h("div");
    const errBox = h("p", { class: "warn", hidden: true });
    showSaveError = err => { errBox.textContent = "Saving failed: " + err.message + " — is the phone storage full?"; errBox.hidden = false; };

    const at = () => floor1(recorder.elapsed());
    const refresh = () => {
      const last = rec.marks[rec.marks.length - 1];
      pad.setActive(last ? state.tags.root(last.tag)?.id : null);
      listBox.replaceChildren(marksList(rec, 0, {
        onRemove: refresh,
        empty: "Tap B or I when you start talking about it. Tap a tag at the moment it fits. You can also do all of this later.",
      }));
    };
    const pad = markPad({
      onPart: tag => { if (addPart(rec, at(), tag, Infinity)) refresh(); },
      onPoint: tag => { addPoint(rec, at(), tag); refresh(); },
    });

    const pauseBtn = btn("Pause", () => {
      if (recorder.paused) { recorder.resume(); pauseBtn.textContent = "Pause"; status.classList.remove("paused"); status.lastChild.textContent = "Recording · screen stays on"; }
      else { recorder.pause(); pauseBtn.textContent = "Resume"; status.classList.add("paused"); status.lastChild.textContent = "Paused"; }
    }, "big");
    const stopBtn = h("button", { class: "btn big stop", type: "button", onclick: () => stopRecording(session, "user") },
      h("span", { svg: icons.stop, class: "stop-ico" }), "Stop");
    session.setSaving = () => { stopBtn.disabled = true; pauseBtn.disabled = true; stopBtn.lastChild.textContent = "Stopping…"; };

    el.append(
      screenHeader("New recording", null),
      h("div", { class: "screen-body rec-body" },
        h("div", { class: "rec-top" }, status, timer, meter),
        errBox,
        pad.el,
        h("h4", { class: "section-title" }, "Marked so far"),
        listBox),
      h("div", { class: "rec-actions" }, pauseBtn, stopBtn));
    refresh();

    session.timer = setInterval(() => {
      timer.textContent = fmtClock(recorder.elapsed());
      const lvl = recorder.paused ? 0 : recorder.readLevel();
      meter.firstChild.style.width = Math.round(lvl * 100) + "%";
    }, 100);
  }, { canClose: () => { toast("Tap “Stop” to finish the recording."); return false; } });
}

async function keepAwake(session) {
  try { session.wake = await navigator.wakeLock?.request("screen"); } catch { /* not available */ }
}

document.addEventListener("visibilitychange", () => {
  const s = state.recording;
  if (s && !s.stopping && document.visibilityState === "visible") keepAwake(s);
});

window.addEventListener("beforeunload", e => {
  if (state.recording) { e.preventDefault(); e.returnValue = ""; }
});

async function stopRecording(session, reason) {
  if (session.stopping) return;
  session.stopping = true;
  session.setSaving?.();
  const { rec, recorder } = session;
  const duration = await recorder.stop();
  rec.durationSec = round1(duration);
  clearInterval(session.timer);
  await session.queue;
  session.wake?.release().catch(() => {});
  let finished = null;
  try {
    finished = await db.finishRecording(rec);
  } catch (err) {
    toast("Saving failed: " + err.message + ". The pieces are kept and will be recovered next time the app opens.", 8000);
  }
  state.recording = null;
  if (session.overlay) closeOverlay(session.overlay);
  if (finished) {
    state.recs.push(finished);
    renderAll();
    afterRecording(finished, reason);
  } else if (!session.saveError) {
    toast("Nothing was recorded.");
  }
}

// Right after stopping: keep it or delete it. The recording is already safe
// on the phone at this point, so closing this by accident keeps it.
function afterRecording(r, reason) {
  let deleted = false;
  const title = h("input", { class: "input", placeholder: "Title (optional)", autocomplete: "off", enterkeyhint: "done" });
  const why = reason === "mic-ended" ? "It stopped because another app took the microphone."
    : reason === "error" ? "It stopped because of an error. What was recorded is kept."
    : null;
  openSheet((s, close) => {
    title.addEventListener("keydown", e => { if (e.key === "Enter") close(); });
    fill(s,
      h("h3", {}, `Recording finished · ${fmtClock(r.durationSec)}`),
      why ? h("p", { class: "warn" }, why) : null,
      title,
      h("div", { class: "sheet-actions" },
        btn("Delete", async () => {
          const ok = await confirmSheet({
            title: "Delete this recording?",
            body: `${fmtLength(r.durationSec)}, recorded just now. It can't be brought back.`,
            ok: "Delete", cancel: "Keep it", danger: true,
          });
          if (!ok) return;
          try {
            await db.deleteRecording(r.id);
            state.recs = state.recs.filter(x => x !== r);
            deleted = true;
            close();
          } catch (err) {
            toast("Could not delete: " + err.message);
          }
        }, "danger-text"),
        btn("Save", close, "primary")));
  }, {
    async onClose() {
      if (deleted) { renderAll(); toast("Deleted."); return; }
      if (title.value.trim()) {
        r.title = title.value.trim();
        try { await db.saveRecording(r); } catch (err) { toast("Could not save the title: " + err.message); }
      }
      renderAll();
      toast("Saved on this phone ✓");
    },
  });
}

// A recording that was in progress when the app was closed: its saved
// pieces are joined into a normal recording.
async function recoverInterrupted() {
  const stuck = state.recs.filter(r => r.status === "recording");
  if (!stuck.length || db.isReadOnly()) return;
  let n = 0;
  for (const r of stuck) {
    r.recovered = true;
    try { if (await db.finishRecording(r)) n++; } catch { /* try again next time */ }
  }
  state.recs = await db.getAll("recordings");
  if (n) toast(`Recovered ${n} recording${n > 1 ? "s" : ""} that ${n > 1 ? "were" : "was"} interrupted.`, 5000);
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

const AUDIO_EXT = /\.(m4a|mp4|aac|mp3|wav|ogg|oga|opus|webm|amr|3gp|flac)$/i;

// "Voice 260915_133741 printfy.m4a" -> 15 Sep 2026 13:37:41
function dateFromName(name) {
  let m = name.match(/(20\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  let y, mo, d, hh, mi, ss;
  if (m) [, y, mo, d, hh, mi, ss] = m.map(Number);
  else {
    m = name.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:\D|$)/);
    if (!m) return null;
    [, y, mo, d, hh, mi, ss] = m.map(Number);
    y += 2000;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  return new Date(y, mo - 1, d, hh, mi, ss).getTime();
}

// Whatever you wrote in the file name after the date becomes the title.
function titleFromName(name) {
  return name
    .replace(AUDIO_EXT, "")
    .replace(/^voice\s*/i, "")
    .replace(/(20)?\d{6}[_-]\d{6}/, "")
    .replace(/^[\s.,_-]+|[\s.,_-]+$/g, "")
    .replace(/\s+/g, " ");
}

function probeDuration(blob) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => finish(0), 10000);
    a.preload = "metadata";
    a.onloadedmetadata = () => finish(isFinite(a.duration) ? round1(a.duration) : 0);
    a.onerror = () => finish(0);
    a.src = url;
  });
}

async function importFiles(fileList) {
  if (db.isReadOnly()) return;
  const files = [...fileList].filter(f => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name));
  if (!files.length) { toast("No audio files selected."); return; }
  navigator.storage?.persist?.().catch(() => {});
  const known = new Set(state.recs.map(r => `${r.originalName}|${r.size}`));
  let added = 0, skipped = 0, cancelled = false, stopReason = "";
  const failed = [];

  const progressText = h("p", {}, "Starting…");
  const bar = h("div", { class: "meter" }, h("div", { class: "meter-fill" }));
  let sheet;
  openSheet((s, close) => {
    sheet = { close };
    fill(s, h("h3", {}, "Importing"), h("p", { class: "muted small" }, "Keep the app open until it finishes."), progressText, bar,
      h("div", { class: "sheet-actions" }, btn("Stop", () => { cancelled = true; })));
  });

  for (let i = 0; i < files.length && !cancelled; i++) {
    const f = files[i];
    progressText.textContent = `${i + 1} of ${files.length}: ${f.name}`;
    bar.firstChild.style.width = `${((i + 1) / files.length) * 100}%`;
    if (known.has(`${f.name}|${f.size}`)) { skipped++; continue; }
    const fromName = dateFromName(f.name);
    const now = Date.now();
    const rec = {
      id: uid(), v: 2,
      startedAt: fromName ?? f.lastModified,
      dateFrom: fromName ? "file name" : "file date",
      durationSec: await probeDuration(f),
      mimeType: f.type || "audio/" + (f.name.split(".").pop() || "").toLowerCase(),
      ext: (f.name.match(/\.(\w+)$/)?.[1] || "").toLowerCase(),
      size: f.size,
      title: titleFromName(f.name), note: "",
      marks: [], points: [], lock: null,
      source: "import", originalName: f.name, status: "saved",
      createdAt: now, updatedAt: now,
    };
    try {
      await db.addImported(rec, f);
      state.recs.push(rec);
      known.add(`${f.name}|${f.size}`);
      added++;
    } catch (err) {
      failed.push(f.name);
      if (err.name === "QuotaExceededError") { stopReason = "The phone storage is full."; break; }
    }
  }
  sheet.close();
  renderAll();
  const lines = [`Imported ${added} recording${added === 1 ? "" : "s"}.`];
  if (skipped) lines.push(`${skipped} were already imported, so they were skipped.`);
  if (failed.length) lines.push(`${failed.length} could not be imported: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}`);
  if (stopReason) lines.push(stopReason);
  if (cancelled) lines.push("You stopped the import; you can run it again, already-imported files are skipped.");
  if (added) lines.push("Find them with the “Not tagged yet” filter.");
  await confirmSheet({ title: "Import finished", body: h("div", {}, lines.map(l => h("p", {}, l))), ok: "OK", cancel: null });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const usesAny = (r, ids) =>
  (r.marks || []).some(m => ids.has(m.tag)) || (r.points || []).some(p => ids.has(p.tag)) ||
  (r.topics || []).some(i => ids.has(i)) || (r.labels || []).some(i => ids.has(i));

function openSettings() {
  openScreen("settings", (el, close) => {
    const tagsBox = h("div", { class: "tag-editor" });
    const oldBox = h("div");
    const storageBox = h("div", { class: "muted small" }, "…");
    const count = ids => state.recs.filter(r => usesAny(r, ids)).length || "";

    const renderTags = () => {
      tagsBox.replaceChildren(
        ...state.tags.tags().map(tag => h("button", { class: "tag-row", type: "button", onclick: () => tagActions(tag, renderTags) },
          h("span", { class: "tag-name" }, tag.name), h("span", { class: "tag-count" }, count(new Set([tag.id]))))),
        btn("+ New tag", async () => { if (await newTag()) renderTags(); }, "wide"));
      const old = state.tags.oldTopics();
      oldBox.replaceChildren(...(old.length ? [
        h("h4", { class: "section-title" }, "Topics from the first version"),
        h("p", { class: "muted small" }, "These are no longer used. Tap one to delete it."),
        h("div", { class: "tag-editor" }, old.map(tag => h("button", {
          class: "tag-row", type: "button", style: `--c:${state.tags.color(tag.id)}`, onclick: () => tagActions(tag, renderTags),
        }, h("span", { class: "dot" }), h("span", { class: "tag-name" }, state.tags.name(tag.id)), h("span", { class: "tag-count" }, count(state.tags.descendants(tag.id)))))),
      ] : []));
    };

    const fmts = supportedFormats();
    el.append(
      screenHeader("Settings", close),
      h("div", { class: "screen-body" },
        h("h4", { class: "section-title" }, "Your tags"),
        h("p", { class: "muted small" }, "Tap a tag to rename or delete it. The number is how many recordings use it."),
        tagsBox,
        oldBox,
        h("h4", { class: "section-title" }, "Import old recordings"),
        h("p", { class: "muted small" }, "Pick audio files from the phone (for example the Voice Recorder folder) — you can select them all at once. The date and time are read from the file name; what you wrote after it becomes the title. Files already imported are skipped."),
        btn("Choose files…", () => $("#import-input").click(), "wide primary"),
        h("h4", { class: "section-title" }, "Phone storage"),
        storageBox,
        h("h4", { class: "section-title" }, "Google Drive backup"),
        h("p", { class: "muted small" }, "Coming in the next version."),
        h("h4", { class: "section-title" }, "About"),
        h("p", { class: "muted small" },
          `Version ${APP_VERSION}. New recordings are saved as ${fmts[0] || "(recording not supported in this browser)"}.`)));
    renderTags();
    showStorage(storageBox);
  }, { onClose: renderAll });
}

async function showStorage(box) {
  const recs = state.recs;
  const bytes = recs.reduce((s, r) => s + (r.size || 0), 0);
  const secs = recs.reduce((s, r) => s + (r.durationSec || 0), 0);
  const lines = [`${recs.length} recordings · ${fmtLength(secs)} · ${fmtBytes(bytes)}`];
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) lines.push(`Space the app may use on this phone: ${fmtBytes(est.quota)} (used ${fmtBytes(est.usage)}).`);
    const kept = await navigator.storage?.persisted?.();
    lines.push(kept
      ? "Protected: the phone won't delete this data by itself."
      : "Not protected yet: add the app to the home screen (Chrome ⋮ → Add to home screen) so the phone doesn't clear it when space runs low.");
  } catch { /* not available */ }
  box.replaceChildren(...lines.map(l => h("p", {}, l)));
}

function tagActions(tag, rerender) {
  openSheet((s, close) => {
    fill(s,
      h("h3", {}, state.tags.name(tag.id)),
      h("div", { class: "sheet-actions col" },
        btn("Rename", async () => {
          close();
          const name = await promptSheet({ title: "Rename", value: tag.name });
          if (!name) return;
          const old = tag.name;
          tag.name = name;
          try { await db.put("tags", tag); } catch (err) { tag.name = old; toast("Could not save: " + err.message); }
          rerender();
        }),
        btn("Delete…", () => { close(); deleteTag(tag, rerender); }, "quiet danger-text"),
        btn("Cancel", close)));
  });
}

async function deleteTag(tag, rerender) {
  const isTopic = tag.kind === "topic";
  const ids = isTopic ? state.tags.descendants(tag.id) : new Set([tag.id]);
  const parent = isTopic && tag.parentId ? state.tags.get(tag.parentId) : null;
  const affected = state.recs.filter(r => usesAny(r, ids));
  const lockedCount = affected.filter(r => r.lock).length;
  const lines = [];
  if (ids.size > 1) lines.push(`The ${ids.size - 1} under it ${ids.size > 2 ? "are" : "is"} deleted too.`);
  lines.push(`Used in ${affected.length} recording${affected.length === 1 ? "" : "s"}${lockedCount ? ` (${lockedCount} locked)` : ""}. The recordings themselves stay.`);
  if (affected.length) {
    lines.push(!isTopic ? "Its points are removed from their timelines."
      : parent ? `Parts marked with it become “${state.tags.name(parent.id)}”.`
      : "Parts marked with it are removed from the timelines.");
  }
  const ok = await confirmSheet({
    title: `Delete “${state.tags.name(tag.id)}”?`,
    body: h("div", {}, lines.map(l => h("p", { class: "muted" }, l))),
    ok: "Delete", danger: true,
  });
  if (!ok) return;
  for (const r of affected) {
    if (r.marks) r.marks = r.marks.filter(m => !ids.has(m.tag) || parent).map(m => (ids.has(m.tag) ? { ...m, tag: parent.id } : m));
    if (r.topics) r.topics = [...new Set(r.topics.map(i => (ids.has(i) ? parent?.id : i)).filter(Boolean))];
    if (r.points) r.points = r.points.filter(p => !ids.has(p.tag));
    if (r.labels) r.labels = r.labels.filter(i => !ids.has(i));
    r.updatedAt = Date.now();
  }
  try {
    await db.putMany("recordings", affected);
    for (const id of ids) await db.del("tags", id);
  } catch (err) {
    toast("Could not delete: " + err.message);
  }
  state.tags.set(state.tags.list.filter(t => !ids.has(t.id)));
  state.filter.ids = state.filter.ids.filter(id => !ids.has(id));
  rerender();
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function init() {
  $("#settings-btn").innerHTML = icons.gear;
  $(".search-icon").innerHTML = icons.search;
  $("#rec-btn").innerHTML = icons.mic;

  const importInput = h("input", { id: "import-input", type: "file", accept: "audio/*,.m4a,.mp3,.wav,.ogg,.opus,.webm,.amr,.3gp", multiple: true, hidden: true });
  importInput.addEventListener("change", () => { const files = importInput.files; if (files?.length) importFiles(files).finally(() => { importInput.value = ""; }); });
  document.body.append(importInput);

  try {
    await db.openDB();
    const meta = await db.get("meta", "schema");
    if (meta && meta.version > db.DATA_VERSION) db.setReadOnly(true);
    const tags = await db.getAll("tags");
    if (!db.isReadOnly()) {
      const changed = upgradeTags(tags);
      if (changed.length) await db.putMany("tags", changed);
      if (!meta || meta.version < db.DATA_VERSION) {
        await db.put("meta", { ...(meta || { key: "schema", createdAt: Date.now() }), version: db.DATA_VERSION });
      }
    }
    state.tags.set(tags);
    state.recs = await db.getAll("recordings");
    await recoverInterrupted();
  } catch (err) {
    $("#list").replaceChildren(h("div", { class: "empty" }, h("p", { class: "warn" }, "The app couldn't open its storage: " + err.message)));
    return;
  }
  navigator.storage?.persist?.().catch(() => {});

  new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", topHeight() + "px")).observe($("#top"));

  let searchTimer;
  $("#search").addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter.q = e.target.value; renderList(); }, 150);
  });
  $("#settings-btn").addEventListener("click", openSettings);
  $("#rec-btn").addEventListener("click", startRecording);
  bindRail();
  renderAll();
}

init();
