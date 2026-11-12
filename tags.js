// Topics form a tree (Mindset > willpower...). Labels are a flat list
// (listen_to_this_everyday, future_predictions...).

import { uid } from "./util.js";

export const COLORS = ["#5cb8ff", "#ffb020", "#b78cff", "#4ade80", "#ff7ab6", "#2dd4bf", "#f2f2f2", "#ff8a5c"];

export function seedTags() {
  const now = Date.now();
  const topic = (name, color, i) => ({ id: uid() + i, kind: "topic", name, parentId: null, color, order: i, createdAt: now });
  const label = (name, i) => ({ id: uid() + "l" + i, kind: "label", name, parentId: null, order: i, createdAt: now });
  return [
    topic("Mindset", COLORS[0], 0),
    topic("Business", COLORS[1], 1),
    ...["listen_to_this_everyday", "future_predictions", "just_chatting", "to_do", "important"].map(label),
  ];
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);

export class Tags {
  constructor(list = []) { this.set(list); }

  set(list) {
    this.list = list;
    this.byId = new Map(list.map(t => [t.id, t]));
  }

  get(id) { return this.byId.get(id); }

  roots() { return this.list.filter(t => t.kind === "topic" && !t.parentId).sort(byOrder); }

  children(id) { return this.list.filter(t => t.kind === "topic" && t.parentId === id).sort(byOrder); }

  labels() { return this.list.filter(t => t.kind === "label").sort(byOrder); }

  path(id) {
    const out = [];
    let t = this.get(id);
    while (t && out.length < 50) { out.unshift(t); t = this.get(t.parentId); }
    return out;
  }

  pathName(id) {
    const p = this.path(id);
    return p.length ? p.map(t => t.name).join(" › ") : "(deleted topic)";
  }

  name(id) { return this.get(id)?.name ?? "(deleted)"; }

  color(id) {
    const p = this.path(id);
    return p[0]?.color || "#888";
  }

  // The tag and everything under it.
  descendants(id) {
    const out = new Set([id]);
    const walk = pid => { for (const c of this.children(pid)) { out.add(c.id); walk(c.id); } };
    walk(id);
    return out;
  }

  // Tree in display order: [{tag, depth}]
  flatTree() {
    const out = [];
    const walk = (list, depth) => { for (const t of list) { out.push({ tag: t, depth }); walk(this.children(t.id), depth + 1); } };
    walk(this.roots(), 0);
    return out;
  }
}
