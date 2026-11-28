import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { withoutLineComments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { stockWorkspaceNodeLaunch } from "../../apps/controller/src/drivers/compute/workspace-node-launch.ts";

test("the public workspace-node launch splits exactly the combined program Compute renders", () => {
  const launch = stockWorkspaceNodeLaunch();
  assert.equal(stockWorkspaceNodeLaunch(), launch);
  assert.ok(Object.isFrozen(launch) && Object.isFrozen(launch.codexCommand));
  // The combined program is the one a provider-owned dedicated Codex launch carries.
  assert.equal(launch.combinedProgram, withoutLineComments(AGENT_WITH_NODE_ENTRYPOINT));
  // The separate Codex argv runs the very child the combined supervisor starts...
  assert.deepEqual(
    launch.codexCommand.slice(0, RUNTIME_WRAPPER_COMMAND.length),
    RUNTIME_WRAPPER_COMMAND,
  );
  const child = ["-e", ...launch.codexCommand.slice(RUNTIME_WRAPPER_COMMAND.length)];
  assert.ok(launch.combinedProgram.includes(`args: ${JSON.stringify(child)}`));
  // ...and the separate node gets exactly the commands the in-Pod node is granted.
  assert.ok(
    launch.combinedProgram.includes(`"--commands", ${JSON.stringify(launch.nodeCommands)}`),
  );
  assert.deepEqual(launch.nodeCommands.split(","), [
    "file.fetch",
    "file.stat",
    "file.write",
    "file.create",
    "dir.list",
    "workspace.memory",
    "workspace.skills",
  ]);
});
