import { h, $, uid, fmtClock, fmtLength, dayKey, fmtTime, fmtDay, fmtDayShort, fmtISODate, todayISO, fmtBytes, fold, icons } from "./util.js";
import * as db from "./db.js";
import { Recorder, supportedFormats } from "./recorder.js";
import { Tags, seedTags, COLORS } from "./tags.js";

const APP_VERSION = "0.1.0";

const state = {
  recs: [],            // every recording (info only; the audio is loaded when played)
  tags: new Tags(),
  filter: { q: "", tags: [], labels: [], untagged: false, locked: false },
  groups: [],          // what the list currently shows, grouped by day
  recording: null,     // the recording in progress, if any
};

const round1 = x => Math.round(x * 10) / 10;
// Marks are rounded down so the part starts at (not after) the moment you tapped.
const floor1 = x => Math.floor(x * 10) / 10;

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
      s.append(...[
        h("h3", {}, title),
        body ? (typeof body === "string" ? h("p", { class: "muted" }, body) : body) : null,
        input,
        h("div", { class: "sheet-actions" }, cancel ? btn(cancel, close) : null, okBtn)].filter(Boolean));
    }, { onClose: () => { if (!answered) resolve(false); } });
  });
}

function promptSheet({ title, value = "", placeholder = "", ok = "Save" }) {
  return new Promise(resolve => {
    let answer = null;
    openSheet((s, close) => {
      const input = h("input", { class: "input", value, placeholder, autocomplete: "off", enterkeyhint: "done" });
      const submit = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } answer = v; close(); };
      input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
      s.append(h("h3", {}, title), input, h("div", { class: "sheet-actions" }, btn("Cancel", close), btn(ok, submit, "primary")));
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
/* Tags                                                               */
/* ------------------------------------------------------------------ */

async function createTag({ kind, name, parentId = null }) {
  const t = { id: uid(), kind, name: name.trim(), parentId, order: Date.now(), createdAt: Date.now() };
  if (kind === "topic" && !parentId) t.color = COLORS[state.tags.roots().length % COLORS.length];
  await db.put("tags", t);
  state.tags.set([...state.tags.list, t]);
  return t;
}

function tagChip(id, extra = "") {
  return h("span", { class: "chip " + extra, style: `--c:${state.tags.color(id)}` }, h("span", { class: "dot" }), state.tags.pathName(id));
}

function labelChip(id) {
  return h("span", { class: "chip label" }, "#" + state.tags.name(id));
}

// The topic tree in a sheet. Resolves with the chosen id (or undefined).
function pickTopic({ title, current = null, exclude = null, topLevelOption = null }) {
  return new Promise(resolve => {
    let picked;
    openSheet((s, close) => {
      const input = h("input", { class: "input", type: "search", placeholder: "Find a topic…", autocomplete: "off" });
      const tree = h("div", { class: "tree" });
      const render = () => {
        const q = fold(input.value.trim());
        tree.replaceChildren();
        for (const { tag, depth } of state.tags.flatTree()) {
          if (exclude?.has(tag.id)) continue;
          const full = state.tags.pathName(tag.id);
          if (q && !fold(full).includes(q)) continue;
          tree.append(h("div", { class: "tree-row" + (tag.id === current ? " current" : ""), style: `--d:${q ? 0 : depth}` },
            h("button", { class: "tree-pick", type: "button", style: `--c:${state.tags.color(tag.id)}`, onclick: () => { picked = tag.id; close(); } },
              h("span", { class: "dot" }), q ? full : tag.name),
            h("button", {
              class: "icon-btn add-sub", type: "button", "aria-label": "Add a sub-topic", title: "Add a sub-topic",
              onclick: async () => {
                const name = await promptSheet({ title: `New topic under “${full}”`, placeholder: "e.g. Printify" });
                if (name) { await createTag({ kind: "topic", name, parentId: tag.id }); input.value = ""; render(); }
              },
            }, "+")));
        }
        if (!tree.children.length) tree.append(h("p", { class: "muted small" }, q ? "No topic matches." : "No topics yet."));
      };
      input.addEventListener("input", render);
      s.append(
        h("h3", {}, title),
        input,
        topLevelOption ? btn(topLevelOption, () => { picked = null; close(); }, "wide") : "",
        tree,
        h("div", { class: "sheet-actions" },
          btn("+ Main topic", async () => {
            const name = await promptSheet({ title: "New main topic", placeholder: "e.g. Health" });
            if (name) { await createTag({ kind: "topic", name }); render(); }
          }),
          btn("Cancel", close)));
      render();
    }, { onClose: () => resolve(picked) });
  });
}

// Big topic buttons used while recording and while listening: tap a topic
// when the subject changes; then optionally narrow it to a sub-topic.
function topicPad({ onAdd, onRefine, timeOf }) {
  const wrap = h("div", { class: "pad" });
  let cur = null;
  const render = () => {
    wrap.replaceChildren();
    wrap.append(h("div", { class: "pad-row" },
      state.tags.roots().map(t => h("button", {
        class: "pad-btn", type: "button", style: `--c:${t.color}`,
        onclick: () => { cur = onAdd(t.id); render(); },
      }, t.name)),
      h("button", {
        class: "pad-btn ghost", type: "button",
        onclick: async () => {
          const name = await promptSheet({ title: "New main topic", placeholder: "e.g. Health" });
          if (name) { const t = await createTag({ kind: "topic", name }); cur = onAdd(t.id); render(); }
        },
      }, "+ New")));
    if (cur) {
      const kids = state.tags.children(cur.tag);
      wrap.append(h("div", { class: "pad-sub", style: `--c:${state.tags.color(cur.tag)}` },
        h("div", { class: "pad-sub-head" },
          h("span", { class: "muted" }, `From ${fmtClock(timeOf(cur))}: `),
          h("b", {}, state.tags.pathName(cur.tag)),
          h("button", { class: "link", type: "button", onclick: () => { cur = null; render(); } }, "OK")),
        h("div", { class: "pad-row small" },
          kids.map(k => h("button", {
            class: "pad-btn small", type: "button", style: `--c:${state.tags.color(k.id)}`,
            onclick: () => { cur.tag = k.id; onRefine(cur); render(); },
          }, k.name)),
          h("button", {
            class: "pad-btn small ghost", type: "button",
            onclick: async () => {
              const name = await promptSheet({ title: `New topic under “${state.tags.pathName(cur.tag)}”`, placeholder: "e.g. Printify" });
              if (name && cur) { const t = await createTag({ kind: "topic", name, parentId: cur.tag }); cur.tag = t.id; onRefine(cur); render(); }
            },
          }, "+ sub-topic"))));
    }
  };
  render();
  return { el: wrap, render, reset() { cur = null; render(); } };
}

// Parts of a recording: each mark starts a part that lasts until the next mark.
function segments(r, duration) {
  const d = duration || r.durationSec || 0;
  const ms = [...(r.marks || [])].sort((a, b) => a.t - b.t);
  return ms.map((m, i) => ({ start: m.t, end: Math.max(m.t, i + 1 < ms.length ? ms[i + 1].t : d), tag: m.tag, mark: m }));
}

function segStrip(r, cls = "seg-strip") {
  const d = r.durationSec || 0;
  const el = h("div", { class: cls });
  if (!d) return el;
  for (const s of segments(r, d)) {
    el.append(h("span", { style: `left:${(s.start / d) * 100}%;width:${((s.end - s.start) / d) * 100}%;background:${state.tags.color(s.tag)}` }));
  }
  return el;
}

/* ------------------------------------------------------------------ */
/* Library list, search and filters                                   */
/* ------------------------------------------------------------------ */

const isDue = r => r.lock && r.lock.until <= todayISO();
const needsTagging = r => !r.lock && !r.topics?.length && !r.marks?.length && !r.labels?.length;
const tagIdsOf = r => new Set([...(r.topics || []), ...(r.marks || []).map(m => m.tag).filter(Boolean)]);

function haystack(r) {
  const when = [dayKey(r.startedAt), fmtDay(r.startedAt), fmtTime(r.startedAt)].join(" ");
  if (r.lock) return fold(when + " locked");
  const parts = [r.title, r.note, r.originalName, when];
  for (const id of tagIdsOf(r)) parts.push(state.tags.pathName(id));
  for (const id of r.labels || []) parts.push(state.tags.name(id));
  return fold(parts.join(" "));
}

function matches(r) {
  const f = state.filter;
  if (f.untagged && !needsTagging(r)) return false;
  if (f.locked && !r.lock) return false;
  if (f.tags.length || f.labels.length) {
    if (r.lock) return false;
    const ids = tagIdsOf(r);
    for (const tid of f.tags) {
      const want = state.tags.descendants(tid);
      if (![...ids].some(id => want.has(id))) return false;
    }
    for (const lid of f.labels) if (!(r.labels || []).includes(lid)) return false;
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
  const box = $("#filters");
  const chip = (content, on, onclick, color) =>
    h("button", { class: "fchip" + (on ? " on" : ""), type: "button", onclick, style: color ? `--c:${color}` : null }, content);
  box.replaceChildren(
    chip("+ Topic", false, async () => {
      const id = await pickTopic({ title: "Show recordings about…" });
      if (id && !f.tags.includes(id)) { f.tags.push(id); renderAll(); }
    }),
    ...f.tags.map(id => chip([h("span", { class: "dot" }), state.tags.pathName(id), " ✕"], true,
      () => { f.tags = f.tags.filter(x => x !== id); renderAll(); }, state.tags.color(id))),
    chip("Needs tagging", f.untagged, () => { f.untagged = !f.untagged; renderAll(); }),
    ...state.tags.labels().map(l => chip("#" + l.name, f.labels.includes(l.id), () => {
      f.labels = f.labels.includes(l.id) ? f.labels.filter(x => x !== l.id) : [...f.labels, l.id];
      renderAll();
    })),
    chip("🔒 Locked", f.locked, () => { f.locked = !f.locked; renderAll(); }),
  );
}

function filtersActive() {
  const f = state.filter;
  return !!(f.q.trim() || f.tags.length || f.labels.length || f.untagged || f.locked);
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
          btn("Import recordings", () => $("#import-input").click(), "primary")));
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
  state.filter = { q: "", tags: [], labels: [], untagged: false, locked: false };
  $("#search").value = "";
  renderAll();
}

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
  const chips = [...[...tagIdsOf(r)].map(id => tagChip(id)), ...(r.labels || []).map(labelChip)];
  const shown = chips.slice(0, 4);
  if (chips.length > 4) shown.push(h("span", { class: "chip more" }, `+${chips.length - 4}`));
  return h("div", {
    class: "card", role: "button", tabindex: "0",
    onclick: () => openDetail(r.id, { focusTag: state.filter.tags[0] }),
  },
    time,
    h("div", { class: "card-body" },
      h("div", { class: "card-title" + (r.title ? "" : " muted") }, r.title || "Untitled"),
      r.marks?.length ? segStrip(r) : null,
      shown.length ? h("div", { class: "chips" }, shown) : null),
    len);
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
  let lastTop = -1;
  for (let i = 0; i < 600; i++) {
    if (m > 11) { m = 0; y++; }
    const n = Date.UTC(y, m, 1) / 864e5;
    if (n > max) break;
    const top = ((max - n) / span) * 100;
    const name = new Date(y, m, 1).toLocaleDateString("en-GB", { month: "short" }) + (m === 0 ? ` ${String(y).slice(2)}` : "");
    ticks.append(h("span", { class: "rail-month", style: `top:${top}%` }, name));
    lastTop = top;
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
        try { await db.saveRecording(r); } catch (err) { delete r.lock; toast("Could not save: " + err.message); return; }
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
      s.append(
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
    s.append(
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
            await db.saveRecording(r);
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
  delete r.lock;
  r.unlockedAt = Date.now();
  try { await db.saveRecording(r); } catch (err) { r.lock = old; toast("Could not save: " + err.message); }
  renderAll();
}

/* ------------------------------------------------------------------ */
/* Recording page: player, parts, tags, notes                          */
/* ------------------------------------------------------------------ */

async function openDetail(id, { focusTag = null, justRecorded = false } = {}) {
  const r = state.recs.find(x => x.id === id);
  if (!r) return;
  if (r.lock) { openLocked(r); return; }

  const blob = await db.getAudio(id).catch(() => null);
  const url = blob ? URL.createObjectURL(blob) : null;
  const audio = new Audio();
  audio.preload = "metadata";
  let dur = r.durationSec || 0;
  let raf = 0;
  let saveTimer = null;
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
    const segLayer = h("div", { class: "seek-segs" });
    const progress = h("div", { class: "seek-progress" });
    const thumb = h("div", { class: "seek-thumb" });
    const seek = h("div", { class: "seek" }, segLayer, progress, thumb);
    const nowLine = h("div", { class: "now-line" });
    const speedBtn = h("button", { class: "small-btn", type: "button" }, "1×");

    const play = () => audio.play().catch(err => toast("Can't play: " + err.message));
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

    function currentSeg(t) {
      let found = null;
      for (const s of segments(r, dur)) if (t >= s.start) found = s;
      return found;
    }

    function tick() {
      const t = audio.currentTime || 0;
      const frac = dur ? Math.min(1, t / dur) : 0;
      progress.style.width = frac * 100 + "%";
      thumb.style.left = frac * 100 + "%";
      cur.textContent = fmtClock(t);
      const s = currentSeg(t);
      nowLine.replaceChildren(s
        ? h("span", { style: `--c:${state.tags.color(s.tag)}` }, h("span", { class: "dot" }), "Now: ", h("b", {}, state.tags.pathName(s.tag)))
        : h("span", { class: "muted" }, r.marks?.length ? "Before the first part" : ""));
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
    let startAt = 0;
    function useDuration() {
      if (isFinite(audio.duration) && audio.duration > 0) {
        if (!dur || Math.abs(audio.duration - dur) > 2) {
          dur = audio.duration;
          r.durationSec = round1(dur);
          save();
        }
        total.textContent = fmtClock(dur);
        refreshParts();
      }
      if (startAt && !fixingDuration) audio.currentTime = startAt;
      tick();
    }

    /* --- parts --- */
    const marksBox = h("div", { class: "marks" });
    const pad = topicPad({
      timeOf: m => m.t,
      onAdd: tag => {
        const m = { t: floor1(audio.currentTime || 0), tag };
        r.marks = [...(r.marks || []), m].sort((a, b) => a.t - b.t);
        save(); refreshParts();
        return m;
      },
      onRefine: () => { save(); refreshParts(); },
    });

    function refreshParts() {
      segLayer.replaceChildren();
      if (dur) for (const s of segments(r, dur)) {
        segLayer.append(h("span", { style: `left:${(s.start / dur) * 100}%;width:${((s.end - s.start) / dur) * 100}%;background:${state.tags.color(s.tag)}` }));
      }
      marksBox.replaceChildren();
      const segs = segments(r, dur);
      if (!segs.length) {
        marksBox.append(h("p", { class: "muted small" }, "No parts yet. While listening, tap a topic above when the subject changes."));
      }
      for (const s of segs) {
        marksBox.append(h("div", { class: "mark-row", style: `--c:${state.tags.color(s.tag)}` },
          h("button", { class: "mark-time", type: "button", title: "Play from here", onclick: () => { audio.currentTime = s.start; play(); } }, "▶ " + fmtClock(s.start)),
          h("button", {
            class: "mark-tag", type: "button", title: "Change topic",
            onclick: async () => {
              const id = await pickTopic({ title: "Topic of this part", current: s.tag });
              if (id) { s.mark.tag = id; save(); refreshParts(); pad.render(); }
            },
          }, h("span", { class: "dot" }), state.tags.pathName(s.tag)),
          h("span", { class: "mark-len" }, fmtLength(s.end - s.start)),
          h("button", {
            class: "small-btn", type: "button", title: "Make this part start where the player is now",
            onclick: () => {
              s.mark.t = floor1(audio.currentTime || 0);
              r.marks.sort((a, b) => a.t - b.t);
              save(); refreshParts();
            },
          }, "start here"),
          h("button", {
            class: "icon-btn", type: "button", "aria-label": "Remove this part",
            onclick: () => { r.marks = r.marks.filter(x => x !== s.mark); save(); pad.reset(); refreshParts(); },
          }, "✕")));
      }
      tick();
    }

    /* --- whole recording topics and labels --- */
    const wholeBox = h("div", { class: "chips wrap" });
    function renderWhole() {
      wholeBox.replaceChildren(
        ...(r.topics || []).map(id => h("button", {
          class: "chip removable", type: "button", style: `--c:${state.tags.color(id)}`,
          onclick: () => { r.topics = r.topics.filter(x => x !== id); save(); renderWhole(); },
        }, h("span", { class: "dot" }), state.tags.pathName(id), h("span", { class: "x" }, " ✕"))),
        h("button", {
          class: "chip add", type: "button",
          onclick: async () => {
            const id = await pickTopic({ title: "The whole recording is about…" });
            if (id && !(r.topics || []).includes(id)) { r.topics = [...(r.topics || []), id]; save(); renderWhole(); }
          },
        }, "+ topic"));
    }

    const labelsBox = h("div", { class: "chips wrap" });
    function renderLabels() {
      labelsBox.replaceChildren(
        ...state.tags.labels().map(l => {
          const on = (r.labels || []).includes(l.id);
          return h("button", {
            class: "chip toggle" + (on ? " on" : ""), type: "button",
            onclick: () => { r.labels = on ? r.labels.filter(x => x !== l.id) : [...(r.labels || []), l.id]; save(); renderLabels(); },
          }, "#" + l.name);
        }),
        h("button", {
          class: "chip add", type: "button",
          onclick: async () => {
            const name = await promptSheet({ title: "New label", placeholder: "e.g. gratitude" });
            if (name) { const t = await createTag({ kind: "label", name }); r.labels = [...(r.labels || []), t.id]; save(); renderLabels(); }
          },
        }, "+ new label"));
    }

    /* --- text --- */
    const title = h("input", { class: "title-input", value: r.title || "", placeholder: "Untitled — add a title", autocomplete: "off" });
    title.addEventListener("input", () => { r.title = title.value; saveSoon(); });
    const note = h("textarea", { class: "input note", rows: "3", placeholder: "Notes…" });
    note.value = r.note || "";
    note.addEventListener("input", () => { r.note = note.value; saveSoon(); });

    const info = [
      r.source === "import" ? `Imported from “${r.originalName}”` : r.recovered ? "Recorded in this app (recovered after an interruption)" : "Recorded in this app",
      (r.ext || "").toUpperCase(),
      fmtBytes(r.size),
    ].filter(Boolean).join(" · ");

    el.append(
      screenHeader(h("span", {}, fmtDayShort(r.startedAt), h("span", { class: "muted" }, " · " + fmtTime(r.startedAt))), close),
      h("div", { class: "screen-body" },
        title,
        !url ? h("p", { class: "warn" }, "The audio for this recording is missing on this phone.") : null,
        h("div", { class: "player" },
          seek,
          h("div", { class: "times" }, cur, total),
          h("div", { class: "controls" },
            h("button", { class: "small-btn", type: "button", onclick: () => jump(-10) }, "−10s"),
            playBtn,
            h("button", { class: "small-btn", type: "button", onclick: () => jump(10) }, "+10s"),
            speedBtn),
          nowLine),
        h("h4", { class: "section-title" }, "Tag the part playing now"),
        pad.el,
        h("h4", { class: "section-title" }, "Parts"),
        marksBox,
        h("h4", { class: "section-title" }, "The whole recording is about"),
        wholeBox,
        h("h4", { class: "section-title" }, "Labels"),
        labelsBox,
        h("h4", { class: "section-title" }, "Notes"),
        note,
        h("div", { class: "danger-zone" },
          btn("🔒 Lock it (dangerous — don't listen until later)", async () => {
            audio.pause();
            if (await lockSheet(r)) { close(); toast(`Locked until ${fmtISODate(r.lock.until)}.`); }
          }, "wide"),
          btn("Delete this recording…", () => deleteRec(r, close), "wide quiet danger-text")),
        h("p", { class: "info" }, info)));

    renderWhole();
    renderLabels();
    refreshParts();

    if (focusTag) {
      const want = state.tags.descendants(focusTag);
      const m = segments(r, dur).find(s => want.has(s.tag));
      if (m) { startAt = m.start; toast(`Starts at the “${state.tags.name(focusTag)}” part.`); }
    }
    if (justRecorded) toast("Saved on this phone ✓");
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
    id: uid(), v: 1, startedAt: now, durationSec: 0, mimeType: "", ext: "", size: 0,
    title: "", note: "", topics: [], labels: [], marks: [], lock: null,
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
    const partsBox = h("div", { class: "marks compact" });
    const errBox = h("p", { class: "warn", hidden: true });
    showSaveError = err => { errBox.textContent = "Saving failed: " + err.message + " — is the phone storage full?"; errBox.hidden = false; };

    const renderParts = () => {
      partsBox.replaceChildren(...rec.marks.map(m => h("div", { class: "mark-row", style: `--c:${state.tags.color(m.tag)}` },
        h("span", { class: "mark-time" }, fmtClock(m.t)),
        h("span", { class: "mark-tag" }, h("span", { class: "dot" }), state.tags.pathName(m.tag)),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Remove", onclick: () => { rec.marks = rec.marks.filter(x => x !== m); pad.reset(); renderParts(); } }, "✕"))));
      if (!rec.marks.length) partsBox.append(h("p", { class: "muted small" }, "Tap a topic when you start talking about it. You can also do this later while listening."));
    };
    const pad = topicPad({
      timeOf: m => m.t,
      onAdd: tag => { const m = { t: floor1(recorder.elapsed()), tag }; rec.marks.push(m); renderParts(); return m; },
      onRefine: () => renderParts(),
    });

    const pauseBtn = btn("Pause", () => {
      if (recorder.paused) { recorder.resume(); pauseBtn.textContent = "Pause"; status.classList.remove("paused"); status.lastChild.textContent = "Recording · screen stays on"; }
      else { recorder.pause(); pauseBtn.textContent = "Resume"; status.classList.add("paused"); status.lastChild.textContent = "Paused"; }
    }, "big");
    const stopBtn = h("button", { class: "btn big stop", type: "button", onclick: () => stopRecording(session, "user") },
      h("span", { svg: icons.stop, class: "stop-ico" }), "Stop & save");
    session.setSaving = () => { stopBtn.disabled = true; pauseBtn.disabled = true; stopBtn.lastChild.textContent = "Saving…"; };

    el.append(
      screenHeader("New recording", null),
      h("div", { class: "screen-body rec-body" },
        h("div", { class: "rec-top" }, status, timer, meter),
        errBox,
        h("h4", { class: "section-title" }, "What are you talking about?"),
        pad.el,
        h("h4", { class: "section-title" }, "Parts so far"),
        partsBox),
      h("div", { class: "rec-actions" }, pauseBtn, stopBtn));
    renderParts();

    session.timer = setInterval(() => {
      timer.textContent = fmtClock(recorder.elapsed());
      const lvl = recorder.paused ? 0 : recorder.readLevel();
      meter.firstChild.style.width = Math.round(lvl * 100) + "%";
    }, 100);
  }, { canClose: () => { toast("Tap “Stop & save” to finish the recording."); return false; } });
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
    openDetail(finished.id, { justRecorded: reason === "user" });
    if (reason === "mic-ended") toast("Recording stopped: another app took the microphone. Saved.", 6000);
    if (reason === "error") toast("Recording stopped because of an error. What was recorded is saved.", 6000);
  } else if (!session.saveError) {
    toast("Nothing was recorded.");
  }
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
  let added = 0, skipped = 0, failed = [], cancelled = false, stopReason = "";

  const progressText = h("p", {}, "Starting…");
  const bar = h("div", { class: "meter" }, h("div", { class: "meter-fill" }));
  let sheet;
  openSheet((s, close) => {
    sheet = { close };
    s.append(h("h3", {}, "Importing"), progressText, bar,
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
      id: uid(), v: 1,
      startedAt: fromName ?? f.lastModified,
      dateFrom: fromName ? "file name" : "file date",
      durationSec: await probeDuration(f),
      mimeType: f.type || "audio/" + (f.name.split(".").pop() || "").toLowerCase(),
      ext: (f.name.match(/\.(\w+)$/)?.[1] || "").toLowerCase(),
      size: f.size,
      title: titleFromName(f.name), note: "",
      topics: [], labels: [], marks: [], lock: null,
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
  await confirmSheet({ title: "Import finished", body: h("div", {}, lines.map(l => h("p", {}, l))), ok: "OK", cancel: null });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings() {
  openScreen("settings", (el, close) => {
    const topicsBox = h("div", { class: "tag-editor" });
    const labelsBox = h("div", { class: "tag-editor" });
    const storageBox = h("div", { class: "muted small" }, "…");

    const usage = ids => state.recs.filter(r =>
      (r.topics || []).some(i => ids.has(i)) || (r.marks || []).some(m => ids.has(m.tag)) || (r.labels || []).some(i => ids.has(i))).length;

    const renderTags = () => {
      topicsBox.replaceChildren(...state.tags.flatTree().map(({ tag, depth }) => h("button", {
        class: "tag-row", type: "button", style: `--d:${depth};--c:${state.tags.color(tag.id)}`,
        onclick: () => tagActions(tag, renderTags),
      }, h("span", { class: "dot" }), h("span", { class: "tag-name" }, tag.name), h("span", { class: "tag-count" }, usage(state.tags.descendants(tag.id)) || ""))),
      btn("+ Main topic", async () => {
        const name = await promptSheet({ title: "New main topic", placeholder: "e.g. Health" });
        if (name) { await createTag({ kind: "topic", name }); renderTags(); }
      }, "wide"));
      labelsBox.replaceChildren(...state.tags.labels().map(tag => h("button", {
        class: "tag-row", type: "button", style: "--d:0",
        onclick: () => tagActions(tag, renderTags),
      }, h("span", { class: "tag-name" }, "#" + tag.name), h("span", { class: "tag-count" }, usage(new Set([tag.id])) || ""))),
      btn("+ Label", async () => {
        const name = await promptSheet({ title: "New label", placeholder: "e.g. gratitude" });
        if (name) { await createTag({ kind: "label", name }); renderTags(); }
      }, "wide"));
    };

    const fmts = supportedFormats();
    el.append(
      screenHeader("Settings", close),
      h("div", { class: "screen-body" },
        h("h4", { class: "section-title" }, "Topics"),
        h("p", { class: "muted small" }, "Tap a topic to add a sub-topic, rename, move or delete it. The number is how many recordings use it."),
        topicsBox,
        h("h4", { class: "section-title" }, "Labels"),
        labelsBox,
        h("h4", { class: "section-title" }, "Import recordings"),
        h("p", { class: "muted small" }, "Pick audio files from the phone (for example the Voice Recorder folder). The date and time are read from the file name; what you wrote after it becomes the title. Files already imported are skipped."),
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
  const isTopic = tag.kind === "topic";
  openSheet((s, close) => {
    s.append(
      h("h3", {}, isTopic ? state.tags.pathName(tag.id) : "#" + tag.name),
      h("div", { class: "sheet-actions col" },
        isTopic ? btn("+ Add a sub-topic", async () => {
          close();
          const name = await promptSheet({ title: `New topic under “${state.tags.pathName(tag.id)}”` });
          if (name) { await createTag({ kind: "topic", name, parentId: tag.id }); rerender(); }
        }) : null,
        btn("Rename", async () => {
          close();
          const name = await promptSheet({ title: "Rename", value: tag.name });
          if (name) { tag.name = name; await db.put("tags", tag); state.tags.set(state.tags.list); rerender(); }
        }),
        isTopic ? btn("Move under another topic", async () => {
          close();
          const exclude = state.tags.descendants(tag.id);
          const target = await pickTopic({ title: `Move “${tag.name}” under…`, exclude, topLevelOption: "Make it a main topic" });
          if (target === undefined) return;
          tag.parentId = target;
          if (!target && !tag.color) tag.color = COLORS[state.tags.roots().length % COLORS.length];
          tag.order = Date.now();
          await db.put("tags", tag);
          state.tags.set(state.tags.list);
          rerender();
        }) : null,
        isTopic && !tag.parentId ? btn("Change colour", async () => {
          tag.color = COLORS[(COLORS.indexOf(tag.color) + 1) % COLORS.length];
          await db.put("tags", tag);
          state.tags.set(state.tags.list);
          rerender();
          close();
        }) : null,
        btn("Delete…", async () => { close(); deleteTag(tag, rerender); }, "quiet danger-text"),
        btn("Cancel", close)));
  });
}

async function deleteTag(tag, rerender) {
  const isTopic = tag.kind === "topic";
  const ids = isTopic ? state.tags.descendants(tag.id) : new Set([tag.id]);
  const parent = isTopic && tag.parentId ? state.tags.get(tag.parentId) : null;
  const affected = state.recs.filter(r =>
    (r.topics || []).some(i => ids.has(i)) || (r.marks || []).some(m => ids.has(m.tag)) || (r.labels || []).some(i => ids.has(i)));
  const lockedCount = affected.filter(r => r.lock).length;
  const sub = ids.size - 1;
  const lines = [];
  if (sub) lines.push(`Its ${sub} sub-topic${sub > 1 ? "s are" : " is"} deleted too.`);
  lines.push(`Used in ${affected.length} recording${affected.length === 1 ? "" : "s"}${lockedCount ? ` (${lockedCount} locked)` : ""}. The recordings themselves stay.`);
  if (affected.length) {
    lines.push(!isTopic
      ? "They just lose this label."
      : parent
        ? `Parts tagged with it become “${state.tags.pathName(parent.id)}”.`
        : "Parts tagged with it lose their time mark.");
  }
  const ok = await confirmSheet({
    title: `Delete ${isTopic ? "“" + state.tags.pathName(tag.id) + "”" : "#" + tag.name}?`,
    body: h("div", {}, lines.map(l => h("p", { class: "muted" }, l))),
    ok: "Delete", danger: true,
  });
  if (!ok) return;
  for (const r of affected) {
    if (r.topics) r.topics = [...new Set(r.topics.map(i => (ids.has(i) ? parent?.id : i)).filter(Boolean))];
    if (r.marks) r.marks = r.marks.filter(m => !ids.has(m.tag) || parent).map(m => (ids.has(m.tag) ? { ...m, tag: parent.id } : m));
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
  state.filter.tags = state.filter.tags.filter(id => !ids.has(id));
  state.filter.labels = state.filter.labels.filter(id => !ids.has(id));
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
    else if (!meta) await db.put("meta", { key: "schema", version: db.DATA_VERSION, createdAt: Date.now() });
    let tags = await db.getAll("tags");
    if (!tags.length && !db.isReadOnly()) { tags = seedTags(); await db.putMany("tags", tags); }
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
