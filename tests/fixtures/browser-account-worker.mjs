import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "openclaw/src/infra/node-commands.js";
import { startNodeHostMcpManager } from "openclaw/src/node-host/mcp.js";
import {
  createNodeWorkerMcpTurn,
  NodeWorkerMcpPolicy,
} from "openclaw/src/node-host/node-worker-mcp.js";
import {
  TEST_WORKER_ENDPOINT,
  testWorkerLaunchInput,
} from "openclaw/src/node-host/node-worker-supervisor.test-support.js";

const { url, bindings } = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(bindings.length, 2);
assert.equal(new Set(bindings.map(({ expectedSubject }) => expectedSubject)).size, 2);
const accounts = Object.fromEntries(
  bindings.map(({ handle, env }) => {
    const marker = process.env[env];
    assert(
      marker?.startsWith("openshell:resolve:env:"),
      "The sandbox must supply an OpenShell placeholder.",
    );
    return [handle, { headers: { Authorization: "Bearer " + marker } }];
  }),
);
const manager = await startNodeHostMcpManager({
  reports: { transport: "streamable-http", url, accounts, toolFilter: { include: ["whoami"] } },
});
try {
  // Use the model-visible definition the authenticated sessions actually advertised.
  const [tool] = manager.descriptors;
  assert.equal(manager.descriptors.length, 1);
  assert.equal(tool?.name, "reports_whoami");
  assert.deepEqual(
    new Set(tool.parameters.properties.account.enum),
    new Set(Object.keys(accounts)),
  );

  const plan = testWorkerLaunchInput("/sandbox", "browser-account-proof").descriptor;
  plan.assignment.toolAuthority.mcpTools = [{ id: tool.name, ...tool.mcp }];
  const policy = new NodeWorkerMcpPolicy();
  policy.setAllowed(true);
  const turn = createNodeWorkerMcpTurn(
    { ...plan, connectionEndpoint: TEST_WORKER_ENDPOINT },
    policy.sessionForCommand(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND, manager),
  );
  assert(turn, "The supervisor must admit the worker's local MCP tool.");
  try {
    const verifiedAccounts = [];
    for (const { handle, label, expectedSubject } of bindings) {
      let reply;
      await turn.invoke(
        {
          type: "mcp-call",
          turnId: plan.assignment.turnId,
          requestId: randomUUID(),
          toolId: tool.name,
          arguments: { account: handle, arguments: {} },
        },
        async (frame) => {
          reply = frame;
        },
      );
      const subject = reply?.result?.content.find(({ type }) => type === "text")?.text;
      assert(
        subject === expectedSubject,
        "The recipient must return the subject of the selected browser account.",
      );
      verifiedAccounts.push({ handle, label, subject });
    }
    console.log(
      JSON.stringify({ workerTool: tool.name, upstreamTool: "whoami", verifiedAccounts }),
    );
  } finally {
    turn.close();
  }
} finally {
  await manager.close();
}
