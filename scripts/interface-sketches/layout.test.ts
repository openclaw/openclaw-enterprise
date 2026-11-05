import assert from "node:assert/strict";
import test from "node:test";
import type { Diagram } from "./diagram.ts";
import { compileDiagram } from "./layout.ts";
import { widestLine } from "./measure.ts";
import { render, type Item, type Sketch } from "./render.ts";

type Rectangle = Extract<Item, { kind: "node" | "box" }>;
function rectangle(scene: Sketch, id: string): Rectangle {
  const item = scene.items.find(
    (entry) => (entry.kind === "node" || entry.kind === "box") && entry.id === id,
  );
  assert.ok(item && (item.kind === "node" || item.kind === "box"));
  return item;
}
function inside(inner: Rectangle, outer: Rectangle): void {
  assert.ok(inner.x >= outer.x && inner.y > outer.y);
  assert.ok(inner.x + inner.w <= outer.x + outer.w);
  assert.ok(inner.y + inner.h <= outer.y + outer.h);
}
function onBorder(point: [number, number], box: Rectangle): boolean {
  const [x, y] = point;
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
  return (
    ((near(x, box.x) || near(x, box.x + box.w)) && y >= box.y && y <= box.y + box.h) ||
    ((near(y, box.y) || near(y, box.y + box.h)) && x >= box.x && x <= box.x + box.w)
  );
}
const nested = {
  title: "Request boundaries",
  groups: [
    { id: "outer", title: "Runtime boundary", role: "boundary" },
    { id: "inner", title: "Caller", parent: "outer", role: "runtime" },
  ],
  nodes: [
    { id: "caller", title: "Caller", group: "inner" },
    { id: "peer", title: "Peer", group: "inner" },
    { id: "service", title: "Service" },
  ],
  edges: [
    { from: "caller", to: "peer", label: "Local request" },
    { from: "peer", to: "service", label: "Authorized request", kind: "conditional" },
  ],
} satisfies Diagram;

test("nested routes connect actual endpoint borders in both directions", async () => {
  for (const direction of ["RIGHT", "DOWN"] as const) {
    const scene = await compileDiagram({ ...nested, layout: { direction } });
    inside(rectangle(scene, "caller"), rectangle(scene, "inner"));
    inside(rectangle(scene, "inner"), rectangle(scene, "outer"));
    const lines = scene.items.filter((item) => item.kind === "line");
    assert.equal(lines.length, 2);
    // One route stays inside a nested group; the other crosses both ancestors.
    for (const edge of nested.edges) {
      const route = lines.find(
        (line) =>
          Array.isArray(line.points[0]) && onBorder(line.points[0], rectangle(scene, edge.from)),
      );
      assert.ok(route, `route begins on ${edge.from}`);
      const last = route.points.at(-1)!;
      assert.ok(Array.isArray(last) && onBorder(last, rectangle(scene, edge.to)));
      for (let i = 1; i < route.points.length; i++) {
        const previous = route.points[i - 1];
        const next = route.points[i];
        assert.ok(Array.isArray(previous) && Array.isArray(next));
        assert.ok(previous[0] === next[0] || previous[1] === next[1]);
      }
    }
    const caller = rectangle(scene, "caller");
    const peer = rectangle(scene, "peer");
    assert.ok(direction === "RIGHT" ? peer.x > caller.x : peer.y > caller.y);
    assert.ok(
      scene.items.some((item) => item.kind === "text" && item.text.includes("Conditional:")),
    );
  }
});

test("graph edits resize containment and reroute without mutating author data", async () => {
  const saved = JSON.stringify(nested);
  const before = await compileDiagram(nested);
  const edited: Diagram = {
    ...nested,
    nodes: nested.nodes.map((node) =>
      node.id === "peer"
        ? {
            ...node,
            detail: "A longer explanation of the exact operation and its authorization boundary.",
          }
        : node,
    ),
  };
  const after = await compileDiagram(edited);
  assert.ok(rectangle(after, "peer").h > rectangle(before, "peer").h);
  inside(rectangle(after, "peer"), rectangle(after, "inner"));
  assert.notDeepEqual(
    after.items.filter((item) => item.kind === "line"),
    before.items.filter((item) => item.kind === "line"),
  );
  assert.equal(JSON.stringify(nested), saved);
  assert.equal(JSON.stringify(after), JSON.stringify(await compileDiagram(edited)));
});

test("long headings, labels and notes wrap inside a bounded scene", async () => {
  const scene = await compileDiagram({
    ...nested,
    title: "A readable diagram heading with enough context to require several lines",
    subtitle: "Scope and boundaries remain visible",
    notes: ["This note explains an important limitation. ".repeat(12), "unbroken".repeat(30)],
    edges: [
      {
        from: "caller",
        to: "service",
        label: "A longer label describing the operation crossing the enclosing boundary",
        kind: "setup",
      },
    ],
  });
  assert.ok(scene.width < 2000 && scene.height < 2000);
  const captions = scene.items.filter((item) => item.kind === "text" && item.role === "label");
  assert.equal(captions.length, 1);
  assert.ok(captions[0].kind === "text" && captions[0].text.includes("\n"));

  for (const item of scene.items) {
    if (item.kind === "line") {
      for (const point of item.points) {
        assert.ok(Array.isArray(point));
        assert.ok(
          point[0] >= 0 && point[0] <= scene.width && point[1] >= 0 && point[1] <= scene.height,
        );
      }
    } else {
      assert.ok(item.x >= 0 && item.y >= 0);
      if (item.kind === "text") {
        const size = item.size!;
        const face =
          item.role === "group" || item.role === "title"
            ? "Bold"
            : item.role === "note"
              ? "Italic"
              : "Regular";
        assert.ok(item.x + widestLine(item.text.split("\n"), size, face) <= scene.width);
        const lines = item.text.split("\n");
        const padding = item.backdrop ? 2 : 0;
        assert.ok(item.y - size - padding >= 0);
        assert.ok(
          item.y + (lines.length - 1) * (item.lineHeight ?? size + 4) + size / 4 + padding <=
            scene.height,
        );
        assert.ok(item.x + widestLine(lines, size, face) + (item.backdrop ? 4 : 0) <= scene.width);
      } else {
        assert.ok(item.x + item.w <= scene.width && item.y + item.h <= scene.height);
      }
    }
  }
  const restored: Sketch = JSON.parse(JSON.stringify(scene));
  assert.deepEqual(restored, scene);
  const original = await render(scene);
  const replayed = await render(restored);
  assert.equal(original.svg, replayed.svg);
  assert.deepEqual(original.png, replayed.png);
});

test("invalid topology fails with the offending identity before layout", async () => {
  const cases: [Diagram, RegExp][] = [
    [
      { ...nested, nodes: [...nested.nodes, { id: "caller", title: "Duplicate" }] },
      /duplicate id caller/,
    ],
    [{ ...nested, nodes: [{ id: "outer", title: "Collision" }] }, /duplicate id outer/],
    [
      { ...nested, groups: [{ id: "outer", title: "Outer", parent: "missing" }] },
      /missing group missing/,
    ],
    [
      {
        ...nested,
        groups: [
          { id: "outer", title: "Outer", parent: "inner" },
          { id: "inner", title: "Inner", parent: "outer" },
        ],
      },
      /group cycle/,
    ],
    [
      { ...nested, nodes: [{ id: "caller", title: "Caller", group: "missing" }] },
      /missing group missing/,
    ],
    [
      { ...nested, edges: [{ from: "caller", to: "missing", label: "Missing" }] },
      /missing node endpoint missing/,
    ],
  ];
  for (const [diagram, expected] of cases) {
    await assert.rejects(compileDiagram(diagram), expected);
  }
});

test("component identifiers stay intact and wrapped title text stays bold", async () => {
  const scene = await compileDiagram({
    title: "Handlers",
    groups: [],
    nodes: [
      { id: "proxy", title: "CredentialProxyExchange", detail: "Reads material" },
      {
        id: "long",
        title: "A long title with enough words to require a second line",
        detail: "Ordinary detail",
      },
    ],
    edges: [],
  });
  const proxy = rectangle(scene, "proxy");
  const long = rectangle(scene, "long");
  assert.ok(proxy.kind === "node" && long.kind === "node");
  assert.deepEqual(proxy.lines, ["CredentialProxyExchange", "Reads material"]);
  assert.ok(long.lines.length >= 3, "the title wraps before the detail begins");
  const { svg } = await render(scene);
  for (const line of long.lines.slice(0, -1)) {
    const element = svg.match(new RegExp(`<text [^>]*>${line}</text>`))?.[0];
    assert.ok(element && element.includes('font-weight="700"'), line);
  }
});

test("automatic layout fits a long chain to reading width and respects explicit direction", async () => {
  const nodes = Array.from({ length: 6 }, (_, i) => ({
    id: `n${i}`,
    title: `Request handler ${i}`,
  }));
  const diagram = {
    title: "Chain",
    nodes,
    groups: [],
    edges: nodes
      .slice(1)
      .map((n, i) => ({ from: nodes[i].id, to: n.id, label: "Pass request upstream" })),
  };
  const auto = await compileDiagram(diagram);
  const right = await compileDiagram({ ...diagram, layout: { direction: "RIGHT" } });
  assert.ok(auto.width < right.width);
  assert.ok(rectangle(auto, "n5").y > rectangle(auto, "n0").y);
  assert.ok(rectangle(right, "n5").x > rectangle(right, "n0").x);
});

test("a response returns to the caller along the request corridor", async () => {
  const scene = await compileDiagram({
    ...nested,
    layout: { direction: "RIGHT" },
    edges: [...nested.edges, { from: "service", to: "peer", label: "Decision" }],
  });
  const service = rectangle(scene, "service");
  const peer = rectangle(scene, "peer");
  const route = scene.items.find(
    (item) =>
      item.kind === "line" && Array.isArray(item.points[0]) && onBorder(item.points[0], service),
  );
  assert.ok(route?.kind === "line" && route.arrow);
  const end = route.points.at(-1);
  assert.ok(end && Array.isArray(end) && onBorder(end, peer));
  for (const point of route.points) {
    assert.ok(Array.isArray(point) && point[0] >= peer.x + peer.w && point[0] <= service.x);
  }
});
