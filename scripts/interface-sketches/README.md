# Edit a Credential Proxy diagram

Find the image in the [architecture gallery](../../docs/design/credential-proxy-architecture.md), then edit its same-named TypeScript file in [examples](examples/). Nodes name components, groups mark ownership boundaries, and labeled arrows connect them.

From the repository root, use Node 24 and the pinned pnpm:

```sh
cd scripts/interface-sketches
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm graph:check
```

Open the generated PNG at docs-page width and follow the arrows. Commit the source, its JSON scene and both PNG copies (in `examples/` and `docs/assets/credential-proxy/`). After renaming a source, remove its old generated files. `pnpm check` checks the scenes and verifies that both image directories have the same PNG filenames and bytes.

`pnpm graph:check` checks the [catalogued source relationships](evidence.ts) using the TypeScript compiler. The catalog covers **5 of 53 nodes and arrows** across the four implementation diagrams. The pull proposal has no source claims. A match shows that the checked-out code contains the relationship. Runtime enforcement requires separate evidence.

For custom layouts, rendering JSON from other tools, and querying the compiler graph, see the [authoring reference](authoring.md).
