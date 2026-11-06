import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
channel("undici:request:headers").subscribe(({ request, response }) => {
  if (response.statusCode >= 400)
    console.warn(
      "node host MCP server downstream failed: HTTP " +
        response.statusCode +
        " on " +
        request.method,
    );
});
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
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

const control = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const { bindings, plugins, releaseFiles } = JSON.parse((await control.next()).value);
assert.equal(bindings.length, 2);
assert(
  bindings.every(
    ({ expectedSubject }) => typeof expectedSubject === "string" && expectedSubject.length > 0,
  ),
);
assert.equal(new Set(bindings.map(({ expectedSubject }) => expectedSubject)).size, 2);
// Materialize the exact package admitted by the fixture Driver. The normal bootstrap
// verifies both checksums before using its slot, endpoint, accounts or tool filter.
assert.equal(plugins.length, 1);
assert.equal(plugins[0].packageName, "test-keycloak-reports");
const catalog = new URL("./catalog/test-keycloak-reports/", import.meta.url);
await mkdir(new URL("ai.openclaw.oce/", catalog), { recursive: true });
await writeFile(new URL("mcp.json", catalog), releaseFiles.manifest);
await writeFile(new URL("ai.openclaw.oce/release.json", catalog), releaseFiles.release);
// Render the same worker config from the admitted plugin selection and OpenShell's sandbox environment.
process.env.OPENCLAW_MANAGED_PLUGIN_JSON = JSON.stringify(plugins);
const project = createRequire(import.meta.url)("./project.cjs");
const servers = project();
const [serverName] = Object.keys(servers);
assert.equal(Object.keys(servers).length, 1);
const server = servers[serverName];
assert(
  server.enabled && server.accounts,
  "The worker must project both browser-connected accounts.",
);
assert.deepEqual(
  new Set(Object.keys(server.accounts)),
  new Set(bindings.map(({ handle }) => handle)),
);
const manager = await startNodeHostMcpManager(servers);
try {
  // Use the model-visible definition the authenticated sessions actually advertised.
  const [tool] = manager.descriptors;
  assert.equal(manager.descriptors.length, 1);
  assert.equal(tool?.name, serverName + "_whoami");
  assert.deepEqual(
    new Set(tool.parameters.properties.account.enum),
    new Set(Object.keys(server.accounts)),
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
    async function call(handle) {
      let response;
      await turn.invoke(
        {
          type: "mcp-call",
          turnId: plan.assignment.turnId,
          requestId: randomUUID(),
          toolId: tool.name,
          arguments: { account: handle, arguments: {} },
        },
        async (frame) => {
          response = frame;
        },
      );
      return response;
    }
    const subject = (reply) => reply?.result?.content?.find(({ type }) => type === "text")?.text;
    const verifiedAccounts = [];
    for (const { handle, label, expectedSubject } of bindings) {
      const reply = await call(handle);
      assert(
        !reply?.error && !reply?.result?.isError && subject(reply) === expectedSubject,
        "The recipient must see the selected browser account.",
      );
      verifiedAccounts.push({ handle, label, subject: subject(reply) });
    }
    console.log("OCE_BROWSER_ACCOUNTS_VERIFIED");
    assert.equal((await control.next()).value, "withdrawn");
    const refused = await call(bindings[0].handle);
    assert(
      refused?.error || refused?.result?.isError,
      "An already-discovered session must refuse its withdrawn grant.",
    );
    assert.equal(
      subject(await call(bindings[1].handle)),
      bindings[1].expectedSubject,
      "The remaining account keeps its grant.",
    );
    console.log(
      JSON.stringify({
        workerTool: tool.name,
        upstreamTool: "whoami",
        verifiedAccounts,
        withdrawnDenied: true,
      }),
    );
  } finally {
    turn.close();
  }
} finally {
  await manager.close();
}
