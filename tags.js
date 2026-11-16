// Two kinds of things can be put on a recording's timeline:
//   parts  : "B" and "I" (kind "topic"). A part runs until the next part starts.
//   tags   : words you write yourself (kind "label"). A tag is one point in time.
//
// The first version of the app had a tree of topics. Topics made back then
// still work: a sub-topic counts as part of the B / I it sits under.

import { uid } from "./util.js";

export const PARTS = [
  { name: "B", was: "Business", color: "#ff9a9a" },
  { name: "I", was: "Mindset", color: "#7cc4ff" },
];

const STARTER_TAGS = ["just_chatting", "predictions", "listen_to_this_every_once_in_a_while"];

// Makes sure B and I exist with their colours (renaming the first version's
// "Business" / "Mindset"). Adds to `list` and returns what must be saved.
export function upgradeTags(list) {
  const now = Date.now();
  const changed = [];
  const fresh = !list.length;
  const roots = list.filter(t => t.kind === "topic" && !t.parentId);
  PARTS.forEach((p, i) => {
    const t = roots.find(r => r.name === p.name) || roots.find(r => r.name === p.was);
    if (!t) {
      const made = { id: uid() + i, kind: "topic", name: p.name, parentId: null, color: p.color, order: i, createdAt: now };
      list.push(made);
      changed.push(made);
    } else if (t.name !== p.name || t.color !== p.color || t.order !== i) {
      t.name = p.name; t.color = p.color; t.order = i;
      changed.push(t);
    }
  });
  if (fresh) {
    STARTER_TAGS.forEach((name, i) => {
      const made = { id: uid() + "l" + i, kind: "label", name, parentId: null, order: i, createdAt: now };
      list.push(made);
      changed.push(made);
    });
  }
  return changed;
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);

export class Tags {
  constructor(list = []) { this.set(list); }

  set(list) {
    this.list = list;
    this.byId = new Map(list.map(t => [t.id, t]));
  }

  get(id) { return this.byId.get(id); }

  isPart(id) { return this.get(id)?.kind === "topic"; }

  // The part buttons: B and I.
  parts() { return this.list.filter(t => t.kind === "topic" && !t.parentId).sort(byOrder); }

  // The tags you wrote.
  tags() { return this.list.filter(t => t.kind === "label").sort(byOrder); }

  // Topics left over from the first version (anything that isn't B or I).
  oldTopics() {
    const names = new Set(PARTS.map(p => p.name));
    return this.list.filter(t => t.kind === "topic" && (t.parentId || !names.has(t.name))).sort(byOrder);
  }

  path(id) {
    const out = [];
    let t = this.get(id);
    while (t && out.length < 50) { out.unshift(t); t = this.get(t.parentId); }
    return out;
  }

  root(id) { return this.path(id)[0]; }

  name(id) {
    const p = this.path(id);
    return p.length ? p.map(t => t.name).join(" › ") : "(deleted)";
  }

  color(id) { return this.root(id)?.color || "#9a9a9a"; }

  // The tag and everything under it.
  descendants(id) {
    const out = new Set([id]);
    const walk = pid => { for (const t of this.list) if (t.parentId === pid && !out.has(t.id)) { out.add(t.id); walk(t.id); } };
    walk(id);
    return out;
  }
}
