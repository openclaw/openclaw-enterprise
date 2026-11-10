# Interface sketch authoring reference

For the regular edit and build commands, see [the renderer README](README.md).

## Add a diagram

Create a module under `examples/` with a default export. Use a stable ID for each group and component; use those IDs to connect them. A title is the name readers scan for. Use the detail for what the component does.

```ts
import type { Diagram } from "../diagram.ts";

export default {
  title: "Request authorization",
  subtitle: "Example interface",
  groups: [
    { id: "worker", title: "OCE worker", role: "control" },
    { id: "runtime", title: "OpenShell", role: "runtime" },
  ],
  nodes: [
    { id: "sender", group: "runtime", title: "Credential Proxy", detail: "Intercepts the request" },
    { id: "adapter", group: "worker", title: "Git transport adapter" },
  ],
  edges: [{ from: "sender", to: "adapter", label: "EvaluateHttpRequest" }],
} satisfies Diagram;
```

Nest a group using `parent` when containment is meaningful, for example an Agent inside a sandbox. Label a conditional edge in words and use `kind: "conditional"` so the drawing also distinguishes it by line style.

## How the tool fits together

- [diagram.ts](diagram.ts) defines what authors describe: groups, components, relationships and notes. The examples contain domain facts, not SVG.
- [layout.ts](layout.ts) compiles a definition into positioned boxes, text and lines. [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html) supplies node placement and orthogonal routing. By default the compiler compares horizontal and vertical layouts. Set `layout: { direction: "RIGHT" }` or `"DOWN"` to fix the reading direction. Pinned presentation boards use [board.ts](board.ts) instead of automatic layout.
- [scene.ts](scene.ts) defines and validates the JSON passed between layout and rendering. A scene contains geometry and semantic roles; it can be used without the TypeScript authoring API.
- [theme.ts](theme.ts) owns the colors and typography. [render.ts](render.ts) draws a scene with bundled Liberation Sans regular, bold, and italic faces. Component names are bold, details use dark-gray italics, and labeled regions use distinct tints.
- [build.ts](build.ts) loads trusted local diagram modules and writes or checks generated artifacts. A TypeScript module runs as code. Use the data-only JSON renderer for input from elsewhere.

## Fit a diagram on one screen

Leave placement automatic for sketches in progress. For a presentation, set `layout: { board: [1180, 640] }` and give each group and component a `pin: [x, y, width, height]`. Root groups use board coordinates; child groups and nodes use coordinates relative to their parent, so moving a group moves its contents. The compiler rejects cards or text that cannot fit. The gallery uses landscape boards: at 1,000 pixels wide, a 1,180 × 640 board is about 542 pixels tall.

Connections still identify components by ID. Use an edge's optional `pin` to select endpoint sides (`from`, `to`), add bends (`via`), or position the label (`label`). Bend points and label positions use board coordinates. See [the Git request layout](examples/current-git.ts) for a working example.

## Keep a presentation override in TypeScript

Start with automatic placement. For a one-off highlight or label adjustment that must survive a rebuild, export a pure `refineScene` function alongside the default diagram. It receives the laid-out scene and returns another scene. For example, give one existing component a stronger outline:

```ts
import type { Sketch } from "../scene.ts";

export function refineScene(scene: Sketch): Sketch {
  return {
    ...scene,
    items: scene.items.map((item) =>
      item.kind === "node" && item.id === "sender" ? { ...item, color: "#245580" } : item,
    ),
  };
}
```

The renderer still validates this result. Automatic routing has already finished at this point: if you move a node, update any fixed edge points and labels that should move with it.

## Render a scene from JSON or Python

Copy a generated scene to a separate file, then move a box or change an edge's points. Absolute points stay fixed; named side anchors track their box. You can also generate this JSON from Python or another language. Pass the result to the same renderer:

```sh
cp examples/current-git.json my-layout.json
node render.ts my-layout.json my-layout
```

This writes `my-layout.svg` and `my-layout.png`. The renderer rejects scenes with more than 10,000 text lines in total, counting each node label and each line of a multiline caption, including empty lines. Keep hand-edited scenes outside the generated examples: the next build replaces those JSON files. No installed system fonts or browser are needed.

## Draw a source-backed view

Generate a report from the current checkout. Use `--root` to inspect another revision and `--file` to inspect a particular source file.

```sh
node graph.ts > coupling.json
jq '.evidence.claims[] | select(.diagram == "generic-exchange")' coupling.json
node graph.ts --root /path/to/oce --file apps/controller/src/composition/egress-authority.ts
```

Choose what to draw. A diagram ID shows **only** its matched claims. An exact source declaration shows its resolved outgoing references, whether or not anyone mapped them to a diagram.

```sh
node projection.ts coupling.json --diagram generic-exchange exchange --captions views/exchange.json
node projection.ts coupling.json --from 'apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts#protectedOpenShellGitOwner' git-authorities --captions views/git-choice.json
```

Open the PNG for review, or the sibling `.sources.json` for the exact declarations and lines behind each arrow. The scene JSON can be rendered again. Captions and optional board positions change presentation only. Omit `--captions` for an automatically laid-out graph using declaration names. Missing evidence, a proposal, or an oversized selection fails instead of producing a plausible partial drawing. A missing arrow can still mean an unresolved call or a file outside the scan; it does not prove isolation.
