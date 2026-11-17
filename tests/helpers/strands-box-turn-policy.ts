import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const patchPath = join(root, "deploy/runtime/openclaw-codex-box-owner.patch");

/** The one turn policy the runtime patch selects for a Box workspace turn, read from the patch. */
export async function boxTurnPolicy(): Promise<{ type: string; networkAccess: string }> {
  const patch = await readFile(patchPath, "utf8");
  const turnParams = patch.slice(
    patch.indexOf("diff --git a/extensions/codex/src/app-server/turn-params.ts"),
  );
  const selected = [
    ...turnParams.matchAll(
      /^\+\s+\? \{ type: "externalSandbox", networkAccess: "(\w+)" \}\n\+\s+: undefined;$/gm,
    ),
  ];
  assert.equal(selected.length, 1, "the patch selects exactly one external Box turn policy");
  // The Box owner check admits only that policy for an external turn, so the Gateway cannot
  // send a wider one over the owner's WSS.
  const owner = patch.slice(
    patch.indexOf("diff --git a/extensions/codex/src/app-server/provider-box-owner.ts"),
  );
  const admitted = [
    ...owner.matchAll(
      /^\+\s+if \(type === "externalSandbox"\) \{\n\+\s+return cwd === owner\.workspaceRoot &&\n\+\s+networkAccess === "(\w+)" &&$/gm,
    ),
  ];
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]![1], selected[0]![1]);
  return { type: "externalSandbox", networkAccess: selected[0]![1]! };
}
