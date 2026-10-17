import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  apiRequests,
  detailUrl,
  login,
  nativeValues,
  newPage,
  settlePageRequests,
} from "./console-agents-browser-helpers.mjs";

// Real console, controller, IAM and policy routes. The fixture Sandbox Driver supplies
// authored policy and native observations; simulation uses the real OCE matcher.
// Native responses prove presentation only, not OpenShell enforcement.
async function policyFixture(t, { empty = false, admission = "applied", decision = "deny" } = {}) {
  const state = { empty, admission, decision, reads: 0, simulationReads: 0, evaluations: [] };
  const hash = "a".repeat(64);
  const sandboxDriver = {
    id: "console-policy-sandbox",
    capability: "sandbox",
    implementation: "browser-policy-fixture",
    facets: ["networking"],
    async provisionHarness(context) {
      return {
        namespaceName: context.namespace.name,
        resourceName: `sb-${context.revision.id.slice(4, 12)}`,
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
    async cleanup() {},
    async readSandboxLogs(context) {
      return {
        sandbox: `sb-${context.revision.id.slice(4, 12)}`,
        observedAt: "2026-10-13T12:00:00.000Z",
        bufferTotal: state.empty ? 0 : 1,
        lines: state.empty
          ? []
          : [
              {
                sandboxId: "7c0e5d4a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
                time: "2026-10-13T12:00:00.000000000Z",
                level: "OCSF",
                target: "ocsf",
                source: "sandbox",
                fields: { policy_generation: "11" },
                message:
                  "NET:OPEN [MED] DENIED curl(42) -> blocked.example.com:443 [policy:- engine:opa]",
              },
            ],
      };
    },
    async describePolicySimulation() {
      state.simulationReads += 1;
      return {
        kind: "network",
        rules: [
          {
            id: "policy:github-api",
            name: "GitHub API",
            binaries: ["/usr/bin/curl"],
            destinations: [
              {
                host: "api.github.com",
                ports: [443],
                http: { methods: ["GET"], enforcement: "audit" },
              },
            ],
          },
        ],
        unevaluatedChecks: ["DNS resolution was not evaluated."],
      };
    },
    async describeNetworkPolicy(context) {
      state.reads += 1;
      return {
        sandbox: `sb-${context.revision.id.slice(4, 12)}`,
        observedAt: "2026-10-13T12:00:01.000Z",
        identity: {
          source: "sandbox",
          version: 12,
          policyHash: hash,
          configRevision: "12",
          providerEnvRevision: "1",
        },
        admission: { state: state.admission },
        rules: [
          {
            id: "policy:github-api",
            name: "GitHub API",
            origin: "configured",
            binaries: ["/usr/bin/curl"],
            destinations: [
              {
                host: "api.github.com",
                ports: [443],
                protocol: "https",
                tls: "terminate",
                enforcement: "enforce",
              },
            ],
            configuration: { allowed: "api.github.com" },
          },
          {
            id: "builtin:default-deny",
            name: "Default deny",
            origin: "builtin",
            binaries: [],
            destinations: [],
            configuration: { reason: "No matching allowed rule" },
          },
        ],
      };
    },
    async evaluateNetworkPolicy(context, request) {
      state.evaluations.push({ revisionId: context.revision.id, request });
      return {
        policyHash: hash,
        applied: state.admission === "applied",
        decision: state.decision,
        reason: "Provider explanation of this action.",
        rules: [
          { id: "policy:github-api", matched: false, reason: "Destination did not match." },
          { id: "builtin:default-deny", matched: true, reason: "No allowed destination matched." },
        ],
        stages: [
          { id: "network-policy", decision: state.decision, reason: "Provider network decision." },
        ],
        unevaluatedChecks: ["DNS resolution was not evaluated."],
      };
    },
  };
  const fixture = await createConsoleAppFixture(t, {
    computeDriver: createRuntimeLogComputeDriver({ sandboxNamespace: "tenant-policy" }),
    sandboxDriver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-policy-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Policy tests", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Policy Agent",
    nativeValues("v1", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  return { fixture, page, state, namespace, agent, revision, hash };
}

test("a logged action simulates intended rules and keeps optional native evidence separate", async (t) => {
  const { fixture, page, state, namespace, agent, revision, hash } = await policyFixture(t);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "logs"));
  await page.locator("#runtime-log-source").selectOption("sandbox");
  const inspect = page.getByRole("button", { name: "Inspect / test action" });
  await inspect.waitFor();
  await settlePageRequests(page);
  assert.equal(state.reads, 0);
  assert.equal(state.simulationReads, 0, "rendering log rows must not read policy inventory");
  await inspect.click();
  const dialog = page.getByRole("dialog", { name: "Policy inspector and tester" });
  await dialog.getByText("OCE intended policy loaded. Enter an action to simulate.").waitFor();
  await dialog.getByText(/generation 11/).waitFor();
  assert.equal(await dialog.getByLabel("Destination host").inputValue(), "blocked.example.com");
  assert.equal(await dialog.getByLabel("Full executable path", { exact: true }).inputValue(), "");
  await dialog.getByText(/a logged name does not verify its path/).waitFor();
  const snapshotHash = (await dialog.getByText(/^Simulation snapshot:/).textContent()).split(
    ": ",
  )[1];
  await dialog.getByLabel("Full executable path", { exact: true }).fill("/usr/bin/curl");
  await dialog.getByLabel("Include an HTTP request").check();
  await dialog.getByLabel("HTTP path").fill("/repos");
  await dialog.getByLabel("Query parameters (optional)").fill("label=bug&label=urgent");
  await dialog.getByRole("button", { name: "Simulate policy" }).click();
  await dialog.getByRole("heading", { name: "Simulated decision: deny" }).waitFor();
  const trace = dialog.getByRole("table", { name: "Simulation rule results" });
  await trace
    .getByRole("row")
    .filter({ hasText: "GitHub API" })
    .getByText("No", { exact: true })
    .waitFor();
  await trace
    .getByRole("row")
    .filter({ hasText: "Default deny" })
    .getByText("Yes", { exact: true })
    .waitFor();
  assert.equal(state.reads, 0, "OCE simulation must not require a native provider snapshot");
  assert.equal(state.evaluations.length, 0);
  assert.deepEqual(
    requests
      .filter(({ method, path }) => method === "POST" && path.endsWith("/policy-simulation"))
      .map(({ body }) => body),
    [
      {
        kind: "network",
        host: "blocked.example.com",
        port: 443,
        binaryPath: "/usr/bin/curl",
        expectedSimulationHash: snapshotHash,
        http: { method: "GET", path: "/repos", query: { label: ["bug", "urgent"] } },
      },
    ],
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await dialog
      .getByText(`Simulated snapshot: ${snapshotHash}`)
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  await dialog.getByText("Optional native network evaluation", { exact: true }).click();
  await dialog.getByRole("button", { name: "Inspect Sandbox provider" }).click();
  await dialog
    .getByText("Provider snapshot loaded. Native evaluation uses the network action above.")
    .waitFor();
  await dialog.getByRole("button", { name: "Evaluate with Sandbox provider" }).click();
  await dialog.getByRole("heading", { name: "Native evaluator decision: deny" }).waitFor();
  await dialog.getByRole("heading", { name: "Simulated decision: deny" }).waitFor();
  assert.deepEqual(state.evaluations, [
    {
      revisionId: revision.id,
      request: {
        host: "blocked.example.com",
        port: 443,
        binaryPath: "/usr/bin/curl",
        expectedPolicyHash: hash,
        http: { method: "GET", path: "/repos", query: { label: ["bug", "urgent"] } },
      },
    },
  ]);
  assert.equal(
    await dialog
      .getByText(`Evaluated policy hash: ${hash}`)
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  await dialog.getByLabel("Destination host").fill("changed.example.com");
  assert.equal(await dialog.getByRole("heading", { name: "Simulated decision: deny" }).count(), 0);
  assert.equal(
    await dialog.getByRole("heading", { name: "Native evaluator decision: deny" }).count(),
    0,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !globalThis.document.querySelector(".network-policy-dialog"));
  assert.equal(await inspect.evaluate((node) => globalThis.document.activeElement === node), true);
});

test("manual simulation works with empty logs and preserves an audit outcome", async (t) => {
  const { fixture, page, state, namespace, agent, revision } = await policyFixture(t, {
    empty: true,
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "logs"));
  await page.locator("#runtime-log-source").selectOption("sandbox");
  await page.getByRole("button", { name: "Open policy tester" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("OCE intended policy loaded. Enter an action to simulate.").waitFor();
  assert.equal(await dialog.getByRole("heading", { name: "Observed log decision" }).count(), 0);
  await dialog.getByLabel("Destination host").fill("api.github.com");
  await dialog.getByLabel("Full executable path", { exact: true }).fill("/usr/bin/curl");
  await dialog.getByLabel("Include an HTTP request").check();
  await dialog.getByLabel("HTTP method").fill("POST");
  await dialog.getByRole("button", { name: "Simulate policy" }).click();
  await dialog.getByRole("heading", { name: "Simulated decision: audit" }).waitFor();
  await dialog
    .getByRole("table", { name: "Simulation rule results" })
    .getByRole("row")
    .filter({ hasText: "HTTP access preset" })
    .getByText("audit", { exact: true })
    .waitFor();
  assert.equal(state.reads, 0);
  assert.equal(state.evaluations.length, 0);
});

test("policy simulation and log reads retain independent IAM grants", async (t) => {
  const { fixture, page, state, namespace, agent, revision } = await policyFixture(t);
  const reader = await fixture.createAccountWithPolicy("policy-log-reader", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "policy-log-reader",
      namespaceId: namespace.id,
      permissions: {
        namespace: ["read"],
        agent: ["read", "read_logs"],
        configuration: ["read"],
        agent_revision: ["read"],
      },
    });
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "logs"),
    reader.credentials,
  );
  await page.locator("#runtime-log-source").selectOption("sandbox");
  await page.getByRole("button", { name: "Inspect / test action" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(/Log access alone does not grant policy access/).waitFor();
  await dialog.getByRole("heading", { name: "Observed log decision" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Simulate policy" }).isDisabled(), true);
  assert.equal(state.simulationReads, 0, "authorization must precede Driver policy access");
  assert.equal(state.reads, 0);
  const operator = await fixture.createAccountWithPolicy("policy-runtime-operator", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "policy-runtime-operator",
      namespaceId: namespace.id,
      permissions: {
        namespace: ["read"],
        agent: ["read", "operate"],
        configuration: ["read"],
        agent_revision: ["read"],
      },
    });
  });
  const { page: operatorPage } = await newPage(t, fixture);
  await login(
    operatorPage,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
    operator.credentials,
  );
  await operatorPage.getByRole("button", { name: "Policy tester", exact: true }).click();
  await operatorPage.getByRole("button", { name: "Open policy tester" }).click();
  const operatorDialog = operatorPage.getByRole("dialog");
  await operatorDialog
    .getByText("OCE intended policy loaded. Enter an action to simulate.")
    .waitFor();
  await operatorDialog.getByLabel("Destination host").fill("blocked.example.com");
  await operatorDialog.getByLabel("Full executable path", { exact: true }).fill("/usr/bin/curl");
  await operatorDialog.getByRole("button", { name: "Simulate policy" }).click();
  await operatorDialog.getByRole("heading", { name: "Simulated decision: deny" }).waitFor();
  assert.equal(
    state.simulationReads,
    2,
    "the controller captures authored policy for read and simulation",
  );
  assert.equal(state.reads, 0);
});

test("a refused log follow closes its observed decision but leaves the manual policy tester available", async (t) => {
  const { fixture, page, namespace, agent, revision } = await policyFixture(t);
  let role;
  const { credentials } = await fixture.createAccountWithPolicy(
    "policy-log-revoked",
    (principal) => {
      ({ role } = grantRole(fixture.policy, principal.id, {
        id: "policy-log-revoked",
        namespaceId: namespace.id,
        permissions: {
          namespace: ["read"],
          agent: ["read", "operate", "read_logs"],
          configuration: ["read"],
          agent_revision: ["read"],
        },
      }));
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "logs"),
    credentials,
  );
  await page.locator("#runtime-log-source").selectOption("sandbox");
  const inspect = page.getByRole("button", { name: "Inspect / test action" });
  await inspect.waitFor();
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await inspect.click();
  const dialog = page.getByRole("dialog");
  const destination = dialog.getByLabel("Destination host");
  assert.equal(await destination.inputValue(), "blocked.example.com");

  const refused = page.waitForResponse(
    (response) => response.url().includes("/runtime/logs?") && response.status() === 403,
  );
  role.permissions = role.permissions.filter(({ action }) => action !== "read_logs");
  await refused;
  await page.getByText(/Log text requires Agent read_logs/).waitFor();
  assert.equal(await inspect.count(), 0);
  assert.equal(
    await page.locator(".network-policy-dialog").count(),
    0,
    "the observed decision must be removed too",
  );

  const manual = page.getByRole("button", { name: "Open policy tester" });
  assert.equal(
    await manual.evaluate((button) => button === globalThis.document.activeElement),
    true,
  );
  await manual.click();
  await dialog.getByText("OCE intended policy loaded. Enter an action to simulate.").waitFor();
  assert.equal(await destination.inputValue(), "");
  assert.equal(await dialog.getByRole("heading", { name: "Observed log decision" }).count(), 0);
});

test("a plugin action is reachable without Sandbox or log access and uses the admitted tool policy", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new OCCPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Plugin policy", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Plugin Agent",
    nativeValues("plugin-policy"),
  );
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins: {
      "occ-plugin:diffs": {
        enabled: true,
        toolDefaults: { approval: "none" },
        tools: { diffs: { enabled: false } },
      },
    },
  });
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const operator = await fixture.createAccountWithPolicy("plugin-policy-operator", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "plugin-policy-operator",
      namespaceId: namespace.id,
      permissions: {
        namespace: ["read"],
        agent: ["read", "operate"],
        configuration: ["read"],
        agent_revision: ["read"],
      },
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
    operator.credentials,
  );
  await page.getByRole("button", { name: "Policy tester", exact: true }).click();
  await page.getByRole("button", { name: "Open policy tester" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("OCE intended policy loaded. Enter an action to simulate.").waitFor();
  assert.equal(await dialog.getByLabel("Action type").inputValue(), "plugin");
  assert.doesNotMatch(
    await dialog.innerText(),
    /^null$/m,
    "manual testers must omit absent log evidence",
  );
  await dialog
    .getByRole("table", { name: "Intended plugin policies" })
    .getByText("occ-plugin:diffs", { exact: true })
    .waitFor();
  await dialog.getByLabel("Plugin ID", { exact: true }).fill("occ-plugin:diffs");
  await dialog.getByLabel("Tool ID", { exact: true }).fill("diffs");
  await dialog.getByRole("button", { name: "Simulate policy" }).click();
  await dialog.getByRole("heading", { name: "Simulated decision: deny" }).waitFor();
  await dialog
    .getByRole("table", { name: "Simulation rule results" })
    .getByRole("row")
    .filter({ hasText: "Tool enabled" })
    .getByText("deny", { exact: true })
    .waitFor();
  await dialog.getByLabel("Tool ID", { exact: true }).fill("unknown-tool");
  await dialog.getByText("Inputs changed. Simulate again.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("heading", { name: "Simulated decision: deny" }).count(), 0);
  await dialog.getByRole("button", { name: "Simulate policy" }).click();
  await dialog.getByRole("heading", { name: "Simulated decision: unknown" }).waitFor();
  await dialog.getByText(/no verified ownership inventory/).waitFor();
  await dialog.getByLabel("Action type").selectOption("network");
  await dialog.getByText(/Sandbox Driver does not describe/).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Simulate policy" }).isDisabled(), true);
  assert.equal(
    requests.some(
      ({ path }) =>
        path.endsWith("/logs") ||
        path.endsWith("/network-policy") ||
        path.endsWith("/network-policy/evaluate"),
    ),
    false,
  );
  assert.deepEqual(
    requests
      .filter(({ method, path }) => method === "POST" && path.endsWith("/policy-simulation"))
      .map(({ body }) => [body.kind, body.pluginId, body.toolId]),
    [
      ["plugin", "occ-plugin:diffs", "diffs"],
      ["plugin", "occ-plugin:diffs", "unknown-tool"],
    ],
  );
});
