import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";

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
      { kind: "text", x: 0, y: 0, text: "bad", role: "control" },
      { kind: "box", x: 0, y: 0, w: 1, h: 2, role: "title" },
      { kind: "node", x: 0, y: 0, w: 1, h: 2, lines: [], role: "unknown" },
      {
        kind: "line",
        points: [
          [0, 0],
          [1, 1],
        ],
        role: "runtime",
      },
      { kind: "text", x: NaN, y: 1, text: "bad" },
      { kind: "text", x: 0, y: 0, text: "bad", color: "url(https://invalid)" },
      { kind: "text", x: 0, y: 0, text: "bad", halo: "true" },
      { kind: "box", x: 0, y: 0, w: -1, h: 2 },
      { kind: "node", x: 0, y: 0, w: 1, h: 2, lines: [1] },
      ...[0, -1, 1.5, 3, NaN, Infinity, "2", null, undefined].map((titleLineCount) => ({
        kind: "node",
        x: 0,
        y: 0,
        w: 100,
        h: 60,
        lines: ["Component", "Description"],
        titleLineCount,
      })),
      { kind: "node", x: 0, y: 0, w: 1, h: 2, lines: [], titleLineCount: 1 },
      { kind: "box", x: 0, y: 0, w: 1, h: 2, titleLineCount: 1 },
      { kind: "text", x: 0, y: 0, text: "Label", titleLineCount: 1 },
      {
        kind: "line",
        points: [
          [0, 0],
          [1, 1],
        ],
        titleLineCount: 1,
      },
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
  for (const input of invalid) {
    assert.throws(() => renderSvg(input), /Invalid sketch:/);
  }
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
  const second = await render(JSON.parse(JSON.stringify(sample())));
  assert.equal(first.svg, second.svg);
  assert.deepEqual(first.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(first.png.readUInt32BE(16), 240);
  assert.equal(first.png.readUInt32BE(20), 160);
  assert.deepEqual(first.png, second.png);
  assert.ok(first.png.length > 100);
  const empty = { title: "", width: 100, height: 60, items: [] };
  const blank = await render(empty);
  const faces: Buffer[] = [];
  for (const role of ["label", "title", "note"] as const) {
    const labelled = await render({
      ...empty,
      items: [{ kind: "text", role, x: 10, y: 30, size: 18, color: "#243247", text: "Visible" }],
    });
    // Same text, size and color isolate real regular, bold and italic glyphs.
    assert.notDeepEqual(labelled.png, blank.png, `${role} must produce visible text`);
    for (const face of faces) {
      assert.notDeepEqual(labelled.png, face, `${role} must have distinct glyphs`);
    }
    faces.push(labelled.png);
  }
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

test("semantic typography is explicit, single-painted and honors raw size overrides", () => {
  const svg = renderSvg({
    title: "Typography",
    width: 500,
    height: 300,
    items: [
      { kind: "text", role: "title", x: 20, y: 40, text: "Heading" },
      { kind: "text", role: "title", x: 20, y: 80, size: 21, text: "Override" },
      { kind: "text", role: "group", x: 20, y: 110, text: "Control plane" },
      { kind: "text", role: "subtitle", x: 20, y: 140, text: "Summary" },
      {
        kind: "node",
        role: "runtime",
        x: 20,
        y: 160,
        w: 200,
        h: 80,
        lines: ["Worker", "Runs the request"],
      },
    ],
  });
  assert.match(svg, /font-size="34" font-weight="700"[^>]*>Heading<\/text>/);
  assert.match(svg, /font-size="21" font-weight="700"[^>]*>Override<\/text>/);
  assert.match(svg, /font-size="16" font-weight="700"[^>]*>Control plane<\/text>/);
  assert.match(svg, /font-size="17" font-weight="400"[^>]*>Summary<\/text>/);
  assert.match(svg, /y="194"[^>]*font-size="18" font-weight="700"[^>]*>Worker<\/text>/);
  assert.match(
    svg,
    /y="218"[^>]*font-size="15" font-weight="400" font-style="italic" fill="#4b5563"[^>]*>Runs the request<\/text>/,
  );
  assert.equal((svg.match(/>Worker<\/text>/g) ?? []).length, 1);
  assert.equal((svg.match(/@font-face/g) ?? []).length, 3);
  assert.match(svg, /fill="#ffffff" stroke="#427b76"/);
  assert.match(svg, /x="40" y="194" text-anchor="start"/);
  assert.match(svg, /x="40" y="218" text-anchor="start"/);
});

test("node surfaces and role accents remain visible inside tinted regions", () => {
  for (const [role, tint, accent] of [
    ["control", [240, 245, 251], [83, 121, 157]],
    ["runtime", [238, 247, 245], [66, 123, 118]],
    ["boundary", [252, 247, 236], [150, 114, 52]],
    ["external", [245, 246, 248], [115, 123, 135]],
  ] as const) {
    const svg = renderSvg({
      title: "Visibility",
      width: 100,
      height: 80,
      items: [
        { kind: "box", role, x: 0, y: 0, w: 100, h: 80 },
        { kind: "node", role, x: 20, y: 20, w: 60, h: 40, lines: [] },
      ],
    });
    const { pixels } = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    const pixel = (x: number, y: number): number[] => [
      ...pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3),
    ];
    assert.deepEqual(pixel(10, 40), tint);
    assert.deepEqual(pixel(50, 40), [255, 255, 255]);
    assert.deepEqual(pixel(29, 40), accent);
  }
  // Tiny raw rectangles are valid input; the accent must shrink inside them.
  const tiny = renderSvg({
    title: "Tiny",
    width: 20,
    height: 20,
    items: [{ kind: "node", role: "control", x: 5, y: 5, w: 2, h: 2, lines: [], color: "#123456" }],
  });
  assert.match(tiny, /x="5.25" y="5.25" width="0.2" height="1.5"[^>]*fill="#123456"/);
  assert.match(tiny, /fill="#ffffff" stroke="#123456"/);
  const raw = renderSvg({
    title: "Legacy",
    width: 100,
    height: 60,
    items: [{ kind: "node", x: 10, y: 10, w: 80, h: 40, lines: ["Raw"], size: 12, color: "#abc" }],
  });
  assert.match(raw, /x="50" y="36" text-anchor="middle"[^>]*font-size="12"/);
  assert.match(raw, /fill="#ffffff" stroke="#abc"/);
});

test("standalone SVG carries all bundled faces and offline font attribution", () => {
  const svg = renderSvg(sample());
  for (const [name, weight, style] of [
    ["Regular", 400, "normal"],
    ["Bold", 700, "normal"],
    ["Italic", 400, "italic"],
  ] as const) {
    const bytes = readFileSync(new URL(`./fonts/LiberationSans-${name}.ttf`, import.meta.url));
    assert.ok(
      svg.includes(
        `font-weight:${weight};font-style:${style};src:url(data:font/ttf;base64,${bytes.toString("base64")})`,
      ),
    );
  }
  const metadata = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1];
  assert.ok(metadata);
  assert.ok(metadata.includes("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007"));
  assert.ok(metadata.includes("Digitized data copyright (c) 2010 Google Corporation"));
  assert.ok(metadata.includes("Copyright (c) 2012 Red Hat, Inc."));
  assert.ok(metadata.includes("PERMISSION &amp; CONDITIONS"));
  assert.ok(metadata.includes("DEALINGS IN THE FONT SOFTWARE."));
  assert.doesNotMatch(svg, /file:\/\/|\/home\/|\/tmp\//);
});

test("two-line component titles stay bold above gray italic descriptions", () => {
  const node = {
    kind: "node" as const,
    x: 10,
    y: 10,
    w: 200,
    h: 100,
    lines: ["Repository", "credentials", "Issues scoped tokens"],
    titleLineCount: 2,
  };
  const sketch = { title: "Component", width: 240, height: 140, items: [node] };
  const svg = renderSvg(sketch);
  for (const title of ["Repository", "credentials"]) {
    assert.match(
      svg,
      new RegExp(
        `font-size="18" font-weight="700" font-style="normal" fill="#243247">${title}</text>`,
      ),
    );
  }
  assert.match(
    svg,
    /font-size="15" font-weight="400" font-style="italic" fill="#4b5563">Issues scoped tokens<\/text>/,
  );
  // A title may occupy every line; an explicit size still applies to all lines.
  assert.doesNotThrow(() =>
    renderSvg({ ...sketch, items: [{ ...node, lines: node.lines.slice(0, 2) }] }),
  );
  const resized = renderSvg({ ...sketch, items: [{ ...node, size: 21 }] });
  assert.equal((resized.match(/font-size="21"/g) ?? []).length, 3);
});
