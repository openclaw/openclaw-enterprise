# Draw an interface diagram

Change the **TypeScript** to describe a component or connection. The tool lays out the graph and generates an editable JSON scene and a PNG. Use the PNG in a review; use the TypeScript for the next change.

| Diagram                                                               | What it shows                                                                                                                                       | Authoring source                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [1 · OpenShell Git request](examples/current-git.png)                 | One push attempt in the GitHub App installation preview. The supervisor calls the worker hook; an allow does not prove GitHub received the request. | [current-git.ts](examples/current-git.ts)                           |
| [1b · OpenShell Git setup](examples/current-git-setup.png)            | How OCE prepares a token, updates an attached provider and verifies what the supervisor loaded.                                                     | [current-git-setup.ts](examples/current-git-setup.ts)               |
| [2 · Generic protected exchange](examples/generic-exchange.png)       | The exchange contract and its required sender. Stock OpenShell is not a qualified exact-dispatch sender.                                            | [generic-exchange.ts](examples/generic-exchange.ts)                 |
| [3 · Credential pull proposal](examples/credential-pull-proposal.png) | A design proposal with a supervisor credential cache. Its ownership and refresh assumptions are separate from the current implementation.           | [credential-pull-proposal.ts](examples/credential-pull-proposal.ts) |

![OpenShell Git request and worker authorization](examples/current-git.png)

For diagrams 1 and 1b, see the [worker hook and Git authority](https://github.com/openclaw/openclaw-enterprise/blob/cdbbee5b97230097f43ae715d3f2fda087546a3c/apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts#L2157-L2200) and the [profile admission checks](https://github.com/openclaw/openclaw-enterprise/blob/cdbbee5b97230097f43ae715d3f2fda087546a3c/apps/controller/src/drivers/egress-proxy/openshell.ts#L418-L437). Diagram 2 describes the [separate exchange contract at its source revision](https://github.com/openclaw/openclaw-enterprise/tree/d1e543d3b5348070ac41e41ef346cc8f03070f0d).

## Make a change

From the repository root, use Node 24 and the repository's pinned pnpm:

```sh
cd scripts/interface-sketches
pnpm install --frozen-lockfile
pnpm build
```

Open `examples/current-git.ts`, change the Agent's title, and run `pnpm build` again. Open `examples/current-git.png` to see the change. Commit the TypeScript, generated JSON and PNG together. `pnpm check` compares generated output without overwriting files; `pnpm test` type-checks the examples and runs tool tests.

Canonical checks treat each top-level `examples/*.png` file as a preview. It must have a same-stem regular `.ts` source; declarations (`.d.ts`), symlinks and directories do not qualify. After renaming or deleting a source, restore it or manually remove the reported orphan PNG and its same-stem JSON, if present. Builds never delete old assets. Checks ignore standalone JSON and nested entries, and fail if no eligible sources remain. Custom `node build.ts INPUT.ts OUTPUT_PREFIX` builds are unchanged.

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
    { id: "sender", group: "runtime", title: "Supervisor", detail: "Intercepts the request" },
    { id: "adapter", group: "worker", title: "Git transport adapter" },
  ],
  edges: [{ from: "sender", to: "adapter", label: "EvaluateHttpRequest" }],
} satisfies Diagram;
```

Nest a group using `parent` when containment is meaningful, for example an Agent inside a sandbox. Label a conditional edge in words and use `kind: "conditional"` so the drawing also distinguishes it by line style.

## How the tool fits together

- [diagram.ts](diagram.ts) defines what authors describe: groups, components, relationships and notes. The examples contain domain facts, not SVG.
- [layout.ts](layout.ts) compiles a definition into positioned boxes, text and lines. [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html) supplies node placement and orthogonal routing. By default the compiler compares horizontal and vertical layouts. Set `layout: { direction: "RIGHT" }` or `"DOWN"` to fix the reading direction. Diagram 1 uses a horizontal layout to keep the hook and its reply together.
- [scene.ts](scene.ts) defines and validates the JSON passed between layout and rendering. A scene contains geometry and semantic roles; it can be used without the TypeScript authoring API.
- [theme.ts](theme.ts) owns the colors and typography. [render.ts](render.ts) draws a scene with bundled Liberation Sans regular, bold, and italic faces. Component names are bold, details use dark-gray italics, and labeled regions use distinct tints.
- [build.ts](build.ts) loads trusted local diagram modules and writes or checks generated artifacts. A TypeScript module runs as code. Use the data-only JSON renderer for input from elsewhere.

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

This writes `my-layout.svg` and `my-layout.png`. Keep hand-edited scenes outside the generated examples: the next build replaces those JSON files. No installed system fonts or browser are needed.
