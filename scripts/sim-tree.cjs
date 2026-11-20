// 精确模拟 projects.rs 的组树算法
const entries = [
  { eid: "VISION-DEMO", parent: null },
  { eid: "EPIC-001-DEMO", parent: "VISION-DEMO" },
  { eid: "FEAT-001-DEMO", parent: "EPIC-001-DEMO" },
  { eid: "STORY-001-DEMO", parent: "FEAT-001-DEMO" },
];
const nodes = new Map(entries.map((e) => [e.eid, { id: e.eid, children: [] }]));
const roots = [];
for (const { eid, parent } of entries) {
  if (parent != null) {
    const child = nodes.get(eid) ?? null;
    const parentExists = child != null && nodes.has(parent);
    if (parentExists) {
      const cn = child;
      const pn = nodes.get(parent);
      if (cn != null && pn != null) {
        pn.children.push(cn);
        continue;
      }
    }
  }
  const n = nodes.get(eid);
  if (n) {
    nodes.delete(eid);
    roots.push(n);
  }
}
console.log("roots:", roots.map((r) => r.id));
console.log("nodes 剩余:", [...nodes.keys()]);
for (const r of roots) console.log(r.id, "->", r.children.map((c) => c.id));
