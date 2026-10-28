import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { render, renderSvg, type Sketch } from "./render.ts";

function sample(x = 80): Sketch {
  return {
    title: "A sketch",
    width: 240,
    height: 160,
    items: [
      { kind: "line", points: [[10, 40], { node: "target", side: "left" }], color: "#e43c39" },
      { kind: "node", id: "target", x, y: 20, w: 100, h: 40, lines: ["Target"] },
      { kind: "text", x: 20, y: 120, text: "Note", halo: true },
    ],
  };
}

test("forward anchors track moved nodes and retain drawing order", () => {
  const before = renderSvg(sample());
  const after = renderSvg(sample(110));
  assert.match(before, /points="10,40 80,40"/);
  assert.match(after, /points="10,40 110,40"/);
  assert.ok(before.indexOf("<polyline") < before.indexOf('<rect x="80"'));
  assert.match(before, /<marker[^>]+id="arrow-0"[^>]*><path[^>]+stroke="#e43c39"/);
  assert.match(before, /paint-order="stroke" stroke="white"/);
  assert.match(before, /@font-face.*data:font\/ttf;base64,/);
});

test("all four sides and box anchors resolve", () => {
  const sketch: Sketch = {
    title: "",
    width: 100,
    height: 100,
    items: [
      { kind: "box", id: "b", x: 10, y: 20, w: 40, h: 60, dashed: true },
      {
        kind: "line",
        arrow: false,
        points: ["left", "right", "top", "bottom"].map((side) => ({
          node: "b",
          side: side as "left" | "right" | "top" | "bottom",
        })),
      },
    ],
  };
  const svg = renderSvg(sketch);
  assert.match(svg, /points="10,50 50,50 30,20 30,80"/);
  assert.doesNotMatch(svg, /marker-end/);
});

test("title and labels are escaped as text, never markup", () => {
  const sketch = sample();
  sketch.title = "<script>&\"'";
  sketch.items.push({ kind: "text", x: 0, y: 0, text: '<image href="https://invalid/">&' });
  sketch.items.push({ kind: "node", x: 0, y: 0, w: 10, h: 10, lines: ["<svg>&"] });
  const svg = renderSvg(sketch);
  assert.match(svg, /<title>&lt;script&gt;&amp;&quot;&apos;<\/title>/);
  assert.match(svg, /&lt;image href=&quot;https:\/\/invalid\/&quot;&gt;&amp;/);
  assert.match(svg, /&lt;svg&gt;&amp;/);
  assert.doesNotMatch(svg, /<script|<image/);
});

test("rejects malformed shapes, unsafe values, bad anchors and excessive work", () => {
  const invalid: unknown[] = [
    null,
    {},
    { ...sample(), width: Infinity },
    { ...sample(), height: 0 },
    { ...sample(), width: 8192, height: 8192 },
    { ...sample(), title: "\u0000" },
    { ...sample(), title: "\ud800" },
    ...[
      { kind: "unknown" },
      { kind: "text", x: NaN, y: 1, text: "bad" },
      { kind: "text", x: 0, y: 0, text: "bad", color: "url(https://invalid)" },
      { kind: "text", x: 0, y: 0, text: "bad", halo: "true" },
      { kind: "box", x: 0, y: 0, w: -1, h: 2 },
      { kind: "node", x: 0, y: 0, w: 1, h: 2, lines: [1] },
      {
        kind: "line",
        points: [
          [0, 1, 2],
          [3, 4],
        ],
      },
      { kind: "line", points: [[0, 1], { node: "missing", side: "left" }] },
      { kind: "line", points: [[0, 1], { node: "target", side: "middle" }] },
      { kind: "text", x: 0, y: 0, text: "bad", extra: true },
      { kind: "box", id: "target", x: 0, y: 0, w: 1, h: 2 },
    ].map((item) => ({ ...sample(), items: [...sample().items, item] })),
    {
      ...sample(),
      items: Array.from({ length: 5001 }, () => ({ kind: "text", x: 0, y: 0, text: "" })),
    },
  ];
  for (const input of invalid) assert.throws(() => renderSvg(input), /Invalid sketch:/);
});

test("CLI rejects invalid references before creating or replacing outputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "sketch-validation-"));
  try {
    const input = join(dir, "input.json");
    const prefix = join(dir, "output");
    writeFileSync(
      input,
      JSON.stringify({
        ...sample(),
        items: [{ kind: "line", points: [[0, 0], { node: "missing", side: "left" }] }],
      }),
    );
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./render.ts", import.meta.url)), input, prefix],
        { encoding: "utf8" },
      );
    const result = run();
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /missing anchor/);
    assert.equal(existsSync(`${prefix}.svg`), false);
    assert.equal(existsSync(`${prefix}.png`), false);
    writeFileSync(`${prefix}.svg`, "keep SVG");
    writeFileSync(`${prefix}.png`, "keep PNG");
    assert.equal(run().status, 1);
    assert.equal(readFileSync(`${prefix}.svg`, "utf8"), "keep SVG");
    assert.equal(readFileSync(`${prefix}.png`, "utf8"), "keep PNG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline renderer produces deterministic PNG with requested dimensions", async () => {
  const first = await render(sample());
  const second = await render(sample());
  assert.deepEqual(first.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(first.png.readUInt32BE(16), 240);
  assert.equal(first.png.readUInt32BE(20), 160);
  assert.deepEqual(first.png, second.png);
  assert.ok(first.png.length > 100);
  const empty = { title: "", width: 100, height: 60, items: [] };
  const blank = await render(empty);
  const labelled = await render({
    ...empty,
    items: [{ kind: "text", x: 10, y: 30, text: "Kalam" }],
  });
  assert.notDeepEqual(labelled.png, blank.png, "bundled font must produce visible text");
});

test("CLI writes both formats offline from another working directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sketch-output-"));
  try {
    writeFileSync(join(dir, "input.json"), JSON.stringify(sample()));
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./render.ts", import.meta.url)), "input.json", "output"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(dir, "output.svg"), "utf8"), /points="10,40 80,40"/);
    assert.equal(readFileSync(join(dir, "output.png")).readUInt32BE(16), 240);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
