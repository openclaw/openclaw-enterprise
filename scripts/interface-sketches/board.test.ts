import assert from "node:assert/strict";
import test from "node:test";
import type { Diagram } from "./diagram.ts";
import { compileDiagram } from "./layout.ts";
import { render } from "./render.ts";

const board: Diagram = {
  title: "Protected request",
  subtitle: "A single-slide interface",
  layout: { board: [1180, 640] },
  // Forward references must still resolve against the immediate parent.
  groups: [
    { id: "inner", title: "Runtime", parent: "outer", pin: [20, 40, 400, 200] },
    { id: "outer", title: "Boundary", pin: [20, 80, 1140, 450] },
  ],
  nodes: [
    {
      id: "sender",
      title: "Sender",
      detail: "Send request",
      group: "inner",
      pin: [20, 40, 180, 55],
    },
    { id: "receiver", title: "Receiver", group: "outer", pin: [650, 80, 180, 40] },
  ],
  edges: [
    {
      from: "sender",
      to: "receiver",
      label: "Authorize\nrequest",
      kind: "conditional",
      pin: { label: [460, 190] },
    },
  ],
  notes: ["An allow decision does not prove delivery."],
};

test("public compiler renders a screen-fit board with relative nesting and readable hierarchy", async () => {
  const scene = await compileDiagram(board);
  assert.equal(scene.width, 1180);
  assert.equal(scene.height, 640);
  const sender = scene.items.find((item) => "id" in item && item.id === "sender");
  assert.ok(sender?.kind === "node");
  assert.deepEqual([sender.x, sender.y, sender.w, sender.h], [60, 160, 180, 55]);
  const notes = scene.items.filter((item) => item.kind === "text" && item.role === "note");
  assert.ok(notes.every((item) => item.kind === "text" && item.y > 530 && item.y < 640));
  const captions = scene.items.filter((item) => item.kind === "text" && item.role === "label");
  assert.equal(captions.length, 1);
  assert.ok(captions[0].kind === "text");
  assert.equal(captions[0].text, "Authorize\nrequest");
  const { svg, png } = await render(scene);
  assert.equal((svg.match(/fill-opacity="0.84"/g) ?? []).length, 1);
  assert.match(svg, /y="190"[^>]*>Authorize<\/text>/);
  assert.match(svg, /y="206"[^>]*>request<\/text>/);
  assert.equal(png.readUInt32BE(16), 1180);
  assert.equal(png.readUInt32BE(20), 640);
  assert.match(svg, /font-size="16" font-weight="700"[^>]*>Sender<\/text>/);
  assert.match(svg, /font-size="14" font-weight="400"[^>]*>Send request<\/text>/);
  assert.ok(!svg.includes("Conditional:"));
  assert.match(svg, /points="240,187.5 670,180"/);
  // Scene edits keep attached endpoints on the moved component's side center.
  sender.x += 30;
  assert.match((await render(scene)).svg, /points="270,187.5 670,180"/);
});

test("explicit sides and absolute route points survive public compilation", async () => {
  const scene = await compileDiagram({
    ...board,
    edges: [
      {
        ...board.edges[0],
        pin: {
          from: "bottom",
          to: "top",
          via: [
            [150, 300],
            [760, 300],
          ],
          label: [480, 290],
        },
      },
    ],
  });
  assert.match((await render(scene)).svg, /points="150,215 150,300 760,300 760,160"/);
});

test("public compiler rejects incomplete, out-of-bounds and illegible boards", async () => {
  const invalid: [string, Diagram, RegExp][] = [
    [
      "missing pin",
      { ...board, nodes: [{ ...board.nodes[0], pin: undefined }, board.nodes[1]] },
      /sender.*pin coordinates/,
    ],
    ["duplicate id", { ...board, nodes: [...board.nodes, board.nodes[0]] }, /duplicate id sender/],
    [
      "parent overflow",
      { ...board, nodes: [{ ...board.nodes[0], pin: [300, 40, 180, 55] }], edges: [] },
      /sender.*parent inner.*400x200/,
    ],
    [
      "negative size",
      { ...board, nodes: [{ ...board.nodes[0], pin: [20, 40, -1, 55] }], edges: [] },
      /sender.*parent/,
    ],
    ["nonfinite", { ...board, layout: { board: [NaN, 640] } }, /finite/],
    [
      "text overflow",
      { ...board, nodes: [{ ...board.nodes[0], detail: "First\nSecond\nThird" }], edges: [] },
      /sender.*available 152x55.*needs.*95px/,
    ],
    [
      "label overflow",
      { ...board, edges: [{ ...board.edges[0], pin: { label: [1170, 190] } }] },
      /edge sender.*text needs/,
    ],
    ...(
      [
        [3, 190],
        [460, 15],
        [460, 625],
      ] as [number, number][]
    ).map((label): [string, Diagram, RegExp] => [
      "caption padding overflow",
      { ...board, edges: [{ ...board.edges[0], pin: { label } }] },
      /edge sender.*text needs/,
    ]),
    [
      "route overflow",
      { ...board, edges: [{ ...board.edges[0], pin: { via: [[1200, 190]] } }] },
      /edge sender.*coordinates/,
    ],
    ["footer overflow", { ...board, notes: Array(10).fill("A note") }, /footer note/],
  ];
  for (const [name, diagram, error] of invalid) {
    await assert.rejects(compileDiagram(diagram), error, name);
  }
});
