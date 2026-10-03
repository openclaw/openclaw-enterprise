import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  apiRequests,
  detailUrl,
  login,
  nativeValues,
  newPage,
  waitForCondition,
} from "./console-agents-browser-helpers.mjs";

// The console runs against the production controller app, IAM, cursor signing and
// sanitizer. The Compute Driver serves in-memory Pod state in place of a cluster.
async function logsFixture(t) {
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createConsoleAppFixture(t, {
    computeDriver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime logs", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Logs Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  return { fixture, computeDriver, namespace, agent, revisionId: active.revision.id };
}

function line(second, raw) {
  return { time: `2026-09-30T12:00:${String(second).padStart(2, "0")}.000000001Z`, raw };
}

function logRequests(requests, revisionId) {
  return requests.filter(({ path }) => path.includes(`/deployments/${revisionId}/runtime/logs`));
}

test("the Logs tab shows runtime status, sanitized output and follows with a cursor", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const secret = `ghp_${randomUUID().replaceAll("-", "")}`;
  computeDriver.state.restartCount = 1;
  computeDriver.state.events = [
    {
      type: "Warning",
      container: "gateway",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 3,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];
  computeDriver.state.lines = [
    line(
      1,
      '{"event":"runtime.startup_phase","container":"gateway","phase":"config","outcome":"ok","ms":12,"sinceStartMs":40}',
    ),
    line(2, `pushing with ${secret}`),
    line(3, '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi"}}'),
    line(
      4,
      '{"event":"codex.model_probe","attempt":1,"elapsedMs":900,"exitCode":1,"signal":null,"code":"AUTHENTICATION_FAILED"}',
    ),
  ];
  computeDriver.state.previousLines = [line(0, "output before the restart")];

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);

  const card = page.locator(".runtime-pod");
  await card.getByRole("heading", { name: "Gateway" }).waitFor();
  await card.getByText("OOMKilled · exit 137", { exact: false }).waitFor();
  // Events name the container they concern.
  await card.getByText("gateway · BackOff ×3: Back-off restarting failed container").waitFor();
  // A container that restarted keeps its warnings styled as current.
  await card.getByRole("list", { name: "Recent warning Events" }).waitFor();
  assert.equal(await card.getByText("Earlier warnings.", { exact: false }).count(), 0);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("runtime.startup_phase").waitFor();
  await pane.getByText("pushing with [redacted:token]").waitFor();
  await pane.getByText("1 structured output withheld").waitFor();
  // A failure code shows on the collapsed row, not only after expanding it.
  const probe = pane.locator(".log-row", { hasText: "codex.model_probe" });
  assert.equal(
    await probe.locator("summary .log-code").textContent(),
    "code=AUTHENTICATION_FAILED",
  );
  assert.equal(await probe.locator("summary .log-code").isVisible(), true);
  assert.equal(await page.getByText(secret).count(), 0);
  await page.getByText("Kubernetes keeps the current and the previous instance.").waitFor();

  // Follow polls with the view's cursor and labels a restart instead of hiding it.
  computeDriver.state.restartCount = 2;
  computeDriver.state.lines = [line(4, "after the restart")];
  await page.getByRole("button", { name: "Follow" }).click();
  await pane.getByText("after the restart").waitFor();
  await pane.getByText("Container restarted", { exact: true }).waitFor();
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("cursor=v1.")));
  await page.getByRole("button", { name: "Following" }).click();

  // The previous instance is a separate view and disables follow.
  await page.getByLabel("Previous instance").check();
  await pane.getByText("output before the restart").waitFor();
  assert.equal(await page.getByRole("button", { name: "Follow" }).isDisabled(), true);
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("previous=true")));

  // Drafts have no runtime and no Logs tab.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "logs").href);
  await page.getByRole("button", { name: "Configuration", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Logs", exact: true }).count(), 0);
});

test("startup warnings on a Ready Pod without restarts read as history", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  // A healthy first deploy: readiness probes failed while the Gateway started, then it
  // became Ready with no restarts.
  computeDriver.state.events = [
    {
      type: "Warning",
      container: "gateway",
      reason: "Unhealthy",
      message: "Readiness probe failed: Gateway /readyz unavailable: ECONNREFUSED",
      count: 8,
      lastObservedAt: "2026-09-30T11:00:20Z",
    },
  ];
  computeDriver.state.lines = [line(1, "gateway ready")];
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);

  const card = page.locator(".runtime-pod");
  const earlier = card.getByRole("list", { name: "Earlier warning Events" });
  await earlier
    .getByText("gateway · Unhealthy ×8: Readiness probe failed: Gateway /readyz unavailable")
    .waitFor();
  await card.getByText("Earlier warnings. The Pod is Ready now and has not restarted.").waitFor();
  assert.equal(await card.getByRole("list", { name: "Recent warning Events" }).count(), 0);
  // The muted text color, not the warning color, marks them as recovered.
  const colors = await earlier.evaluate((list) => {
    const view = list.ownerDocument.defaultView;
    const probe = list.ownerDocument.createElement("span");
    probe.style.color = "var(--warning)";
    list.append(probe);
    const warning = view.getComputedStyle(probe).color;
    probe.remove();
    return { list: view.getComputedStyle(list).color, warning };
  });
  assert.notEqual(colors.list, colors.warning);
});

test("a rejected cursor starts one new view and later restarts wait for it", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "first view line")];
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("first view line").waitFor();

  // Tamper with the first follow cursor, then hold the replacement view's read.
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let state = "untouched";
  const arrivedWhileHeld = [];
  await page.route(`**/deployments/${revisionId}/runtime/logs?*`, async (route, request) => {
    const target = new URL(request.url());
    const cursor = target.searchParams.get("cursor");
    if (state === "untouched" && cursor !== null) {
      state = "tampered";
      const last = cursor.at(-1) === "A" ? "B" : "A";
      target.searchParams.set("cursor", `${cursor.slice(0, -1)}${last}`);
      await route.continue({ url: target.href });
      return;
    }
    if (state === "holding") {
      arrivedWhileHeld.push(target.search);
    } else if (state === "tampered" && cursor === null) {
      state = "holding";
      held.resolve();
      await release.promise;
      state = "released";
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Follow" }).click();
  await held.promise;
  // A restart while the replacement read is in flight waits for it.
  computeDriver.state.lines = [line(1, "first view line"), line(2, "debug floor line")];
  await page.getByLabel("Include debug").check();
  await page.waitForTimeout(500);
  assert.deepEqual(arrivedWhileHeld, []);
  release.resolve();
  await pane.getByText("debug floor line").waitFor();
  // The queued restart read the new debug view.
  const after = logRequests(requests, revisionId).at(-1);
  assert.equal(new URL(after.path, fixture.origin).searchParams.has("minLevel"), false);
  await page.getByRole("button", { name: "Following" }).click();
});

test("level chips and the text filter narrow only the loaded window; download saves the sanitized tail", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const secret = `ghp_${randomUUID().replaceAll("-", "")}`;
  computeDriver.state.lines = [
    line(
      1,
      '{"time":"2026-09-30T12:00:01Z","level":"error","message":"model call failed","subsystem":"agents"}',
    ),
    line(
      2,
      '{"time":"2026-09-30T12:00:02Z","level":"warn","message":"slow channel","subsystem":"slack"}',
    ),
    line(
      3,
      '{"time":"2026-09-30T12:00:03Z","level":"info","message":"Gateway ready","subsystem":"gateway"}',
    ),
    line(4, `plain output with ${secret}`),
    line(5, '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi"}}'),
    line(6, "Harness model authentication probe failed."),
    line(
      7,
      '{"time":"2026-09-30T12:00:07Z","level":"debug","message":"heartbeat tick","subsystem":"gateway"}',
    ),
  ];

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("Gateway ready").waitFor();
  await page
    .getByText("Filters search only the lines loaded in this view, not the whole container log.")
    .waitFor();
  const reads = logRequests(requests, revisionId).length;
  // By default the server returns info and above; debug lines are never loaded.
  assert.ok(logRequests(requests, revisionId).every(({ path }) => path.includes("minLevel=info")));
  assert.equal(await pane.getByText("heartbeat tick").count(), 0);

  // Level chips hide lines client-side; withheld rows stay visible.
  const filters = page.getByRole("group", { name: "Log filters" });
  await filters.getByRole("button", { name: "info", exact: true }).click();
  await filters.getByRole("button", { name: "unknown", exact: true }).click();
  assert.equal(
    await filters.getByRole("button", { name: "info", exact: true }).getAttribute("aria-pressed"),
    "false",
  );
  await pane.getByText("Gateway ready").waitFor({ state: "hidden" });
  await pane.getByText(/plain output with/).waitFor({ state: "hidden" });
  // The wrapper's plain failure line is an error, so hiding `unknown` keeps it.
  await pane.getByText("Harness model authentication probe failed.").waitFor();
  assert.equal(await pane.getByText("model call failed").isVisible(), true);
  assert.equal(await pane.getByText("1 structured output withheld").isVisible(), true);
  await page
    .getByText(
      "Showing 3 of 5 loaded lines. Filters search only the lines loaded in this view, not the whole container log.",
    )
    .waitFor();

  // The text filter is case-insensitive over message, subsystem and fields.
  await filters.getByRole("button", { name: "info", exact: true }).click();
  await filters.getByRole("button", { name: "unknown", exact: true }).click();
  await page.getByLabel("Filter", { exact: true }).fill("SLACK");
  await pane.getByText("model call failed").waitFor({ state: "hidden" });
  assert.equal(await pane.getByText("slow channel").isVisible(), true);
  await page.getByText(/^Showing 1 of 5 loaded lines\./).waitFor();
  // Filtering never asks the server again.
  assert.equal(logRequests(requests, revisionId).length, reads);
  await page.getByLabel("Filter", { exact: true }).fill("");
  await pane.getByText("Gateway ready").waitFor();

  // Download: one request through the console session, saved under a stable name.
  const downloadRequest = page.waitForRequest((request) => request.url().includes("download=true"));
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const request = await downloadRequest;
  const saved = await downloadEvent;
  const requested = new URL(request.url());
  assert.equal(requested.pathname.endsWith(`/deployments/${revisionId}/runtime/logs`), true);
  assert.deepEqual(Object.fromEntries(requested.searchParams), {
    source: "gateway",
    pod: computeDriver.podName({ id: revisionId }),
    minLevel: "info",
    download: "true",
  });
  assert.equal(request.method(), "GET");
  const pod = computeDriver.podName({ id: revisionId });
  assert.equal(saved.suggestedFilename(), `${agent.id}-${revisionId}-gateway-${pod}.log`);
  const body = await readFile(await saved.path(), "utf8");
  assert.match(body, /ERROR openclaw \[agents\] model call failed/);
  assert.match(body, /plain output with \[redacted:token\]/);
  assert.match(body, /WITHHELD 1 unrecognised_structured/);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes("jsonrpc"), false);
  assert.equal(body.includes("heartbeat tick"), false);

  // Include debug starts a new server read without the level floor.
  await page.getByLabel("Include debug").check();
  await pane.getByText("heartbeat tick").waitFor();
  assert.equal(logRequests(requests, revisionId).at(-1).path.includes("minLevel="), false);
});

test("an operator without administer sees status but no log text and is never re-polled", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "operator must not see this")];
  const operator = await fixture.createAccountWithPolicy("runtime-operator", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-runtime-operator",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "operate", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-runtime-operator",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-runtime-operator",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search, operator.credentials);

  await page.locator(".runtime-pod").getByRole("heading", { name: "Gateway" }).waitFor();
  await page
    .getByText("Log text requires Agent read_logs (or administer) and read access.")
    .waitFor();
  assert.equal(await page.getByText("operator must not see this").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Follow" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Refresh logs" }).isDisabled(), true);
  const denied = logRequests(requests, revisionId).length;
  assert.equal(denied, 1);
  // Status keeps polling every 10 s; the denied log view is not requested again.
  await waitForCondition(
    () =>
      requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length >=
      2,
    "the runtime strip refreshes",
    15_000,
  );
  assert.equal(logRequests(requests, revisionId).length, denied);
});

test("a log reader without operate reads log text in the Logs tab without runtime status", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.restartCount = 1;
  computeDriver.state.lines = [line(1, "log reader can see this")];
  computeDriver.state.previousLines = [line(0, "output before the restart")];
  const reader = await fixture.createAccountWithPolicy("runtime-log-reader", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-runtime-log-reader",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read_logs", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-runtime-log-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-runtime-log-reader",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search, reader.credentials);

  // Runtime status needs operate; log text needs only read_logs, so the tab still reads it.
  await page
    .getByText(
      "Runtime status requires Agent operate and read access plus read access to this version.",
    )
    .waitFor();
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("log reader can see this").waitFor();
  const pod = computeDriver.podName({ id: revisionId });
  await page.getByText(`Showing gateway in ${pod}.`).waitFor();
  assert.equal(await page.locator(".runtime-pod").count(), 0);
  assert.equal(await page.locator("#runtime-log-source").isDisabled(), false);
  // Without status the console names no Pod; OCC reads the source's current Pod.
  const [first] = logRequests(requests, revisionId);
  assert.equal(new URL(first.path, fixture.origin).searchParams.has("pod"), false);

  // The page's stream reports the restart, so the previous instance is readable.
  await page.getByLabel("Previous instance").check();
  await pane.getByText("output before the restart").waitFor();
  await page.getByLabel("Previous instance").uncheck();
  await pane.getByText("log reader can see this").waitFor();

  // Follow continues the view with its cursor.
  computeDriver.state.lines = [line(1, "log reader can see this"), line(2, "a later line")];
  await page.getByRole("button", { name: "Follow" }).click();
  await pane.getByText("a later line").waitFor();
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("cursor=v1.")));
  await page.getByRole("button", { name: "Following" }).click();

  // A source this version does not have is explained, not a generic failure.
  await page.locator("#runtime-log-source").selectOption("sandbox");
  await page.getByText(/This version has no sandbox log source/).waitFor();

  // Reopening the tab remembers the status denial and still reads log text; with no
  // Pod list there is no Harness hint.
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length;
  const before = statusReads();
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await pane.getByText("log reader can see this").waitFor();
  assert.equal(await page.locator("#runtime-log-source").isDisabled(), false);
  assert.equal(statusReads(), before);
  assert.equal(await page.getByRole("note").count(), 0);
});

test("the Logs tab explains cluster RBAC, unsupported Drivers and unavailable reads", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const { RuntimeLogsForbiddenByClusterError } = await import("../../packages/occ/src/index.ts");
  computeDriver.state.readError = new RuntimeLogsForbiddenByClusterError();
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);
  await page
    .getByText(/Ask your platform operator to enable agentRuntimeLogs in the Helm chart/)
    .waitFor();

  computeDriver.state.readError = new Error(`private detail ${randomUUID()}`);
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await page.getByText(/Runtime status or logs are unavailable/).waitFor();
  assert.equal(await page.getByText(/private detail/).count(), 0);

  computeDriver.state.readError = undefined;
  computeDriver.state.describeError = new Error("cluster unreachable");
  computeDriver.runtimeLogging = "driver";
  await page.reload();
  await page
    .getByText(/This Compute Driver does not expose runtime status or logs/)
    .first()
    .waitFor();
});

test("the Sandbox source shows redacted policy decisions without a Pod picker", async (t) => {
  const computeDriver = createRuntimeLogComputeDriver({ sandboxNamespace: "tenant-console" });
  const secret = `Zq9${randomUUID().replaceAll("-", "")}`;
  const sandboxState = { lines: [], error: undefined };
  const sandboxRequests = [];
  const sandboxDriver = {
    id: "console-sandbox",
    capability: "sandbox",
    implementation: "openshell",
    facets: ["networking", "filesystem", "process"],
    async provisionHarness(context) {
      return {
        namespaceName: context.namespace.name,
        resourceName: `sb-${context.revision.id.slice(4, 12)}`,
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
    async cleanup() {},
    async readSandboxLogs(context, request) {
      sandboxRequests.push({ namespace: context.namespace.name, ...request });
      if (sandboxState.error !== undefined) {
        throw sandboxState.error;
      }
      return {
        sandbox: `sb-${context.revision.id.slice(4, 12)}`,
        observedAt: "2026-09-30T12:00:05.000Z",
        lines: sandboxState.lines,
        bufferTotal: sandboxState.lines.length,
      };
    },
  };
  const fixture = await createConsoleAppFixture(t, {
    computeDriver,
    sandboxDriver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sandbox logs", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Sandbox Agent",
    nativeValues("v1", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const sandboxLine = (second, message, fields = {}) => ({
    sandboxId: "7c0e5d4a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
    time: `2026-09-30T12:00:0${second}.000000000Z`,
    level: "OCSF",
    target: "ocsf",
    message,
    source: "sandbox",
    fields,
  });
  sandboxState.lines = [
    sandboxLine(
      1,
      `PROC:LAUNCH [INFO] git(42) [cmd:git clone https://x-access-token:${secret}@github.com/acme/repo.git]`,
    ),
    sandboxLine(
      2,
      "NET:OPEN [MED] DENIED python3(7) -> blocked.example.com:443 [policy:default engine:opa]",
    ),
    sandboxLine(
      3,
      "NET:OPEN [MED] DENIED curl(9) -> 169.254.169.254:80 [policy:- engine:ssrf] [reason:resolves to always-blocked address]",
    ),
    sandboxLine(
      4,
      "HTTP:GET [INFO] ALLOWED GET https://api.github.com/zen [policy:github_api engine:opa]",
      { policy_generation: "12" },
    ),
  ];

  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "logs");
  await login(page, fixture, url.pathname + url.search);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await page.locator("#runtime-log-source").selectOption("sandbox");
  await pane
    .getByText("NET:OPEN [MED] DENIED python3(7) -> blocked.example.com:443", {
      exact: false,
    })
    .waitFor();
  await page.getByText(/OpenShell keeps the last 2000 lines per sandbox/).waitFor();
  // Every decision names its rule and engine; a missing policy generation reads "unknown"
  // and a sandbox decision is never presented as attributed to a Gateway line.
  const rows = pane.locator(".log-row");
  const rowFor = (text) => rows.filter({ hasText: text });
  assert.equal(
    await rowFor("blocked.example.com").locator(".log-provenance").textContent(),
    "rule default · engine opa · policy generation unknown",
  );
  assert.equal(
    await rowFor("169.254.169.254").locator(".log-provenance").textContent(),
    "rule no matching rule · engine ssrf · policy generation unknown",
  );
  assert.equal(
    await rowFor("api.github.com/zen").locator(".log-provenance").textContent(),
    "rule github_api · engine opa · policy generation 12",
  );
  assert.equal(await rows.locator(".log-join").count(), 3);
  assert.equal(
    await rowFor("blocked.example.com").locator(".log-join").textContent(),
    "Gateway lines: inferred (time window)",
  );
  assert.match(
    await rowFor("blocked.example.com").locator(".log-join").getAttribute("title"),
    /does not record which Agent turn made this request/,
  );
  // A process launch is not a policy decision: no provenance, no join label.
  assert.equal(await rowFor("PROC:LAUNCH").locator(".log-provenance").count(), 0);
  await page.getByText(/Showing policy decisions and supervisor output of sandbox sb-/).waitFor();
  assert.equal(await page.getByText(secret).count(), 0);
  assert.equal(await page.locator("#runtime-log-pod").isVisible(), false);
  assert.equal(await page.getByLabel("Previous instance").isDisabled(), true);
  assert.equal(sandboxRequests.at(-1).namespace, "tenant-console");

  const { RuntimeLogsForbiddenByClusterError } = await import("../../packages/occ/src/index.ts");
  sandboxState.error = new RuntimeLogsForbiddenByClusterError();
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await page
    .getByText(/grant the OpenClaw Enterprise gateway identity the sandbox:read scope/)
    .waitFor();
});

test("a Gateway view points at an unready Harness Pod instead of reading as a network fault", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.harnessPod = { ready: false };
  computeDriver.state.lines = [
    line(1, "codex app-server remote WebSocket connection failed: connect ECONNREFUSED"),
  ];
  computeDriver.state.harnessLines = [line(2, "Harness model authentication probe failed.")];
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);
  await page.locator("#runtime-log-source").selectOption("gateway");
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText(/ECONNREFUSED/)
    .waitFor();
  const hint = page.getByRole("note").filter({ hasText: "The Agent (Harness) Pod is not ready" });
  await hint.waitFor();
  assert.match(await hint.textContent(), /read the Agent \(Harness\) source for the cause/);

  await page.locator("#runtime-log-source").selectOption("agent");
  await hint.waitFor({ state: "hidden" });
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText("Harness model authentication probe failed.")
    .waitFor();
  assert.equal(await page.getByText(/ECONNREFUSED/).count(), 0);

  // A ready Harness adds no hint to the Gateway view.
  computeDriver.state.harnessPod = { ready: true };
  await page.reload();
  await page.locator("#runtime-log-source").selectOption("gateway");
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText(/ECONNREFUSED/)
    .waitFor();
  assert.equal(await hint.count(), 0);
});

test("the Gateway hint skips a rollout's old Harness Pod and covers a Harness with no Pod", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  // A rollout keeps an unready old Harness Pod beside a ready one: no hint.
  computeDriver.state.harnessPod = { ready: true, stale: true };
  computeDriver.state.lines = [
    line(1, "codex app-server remote WebSocket connection failed: connect ECONNREFUSED"),
  ];
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);
  await page
    .locator(".runtime-pod")
    .getByText(`agent-${revisionId.slice(4, 12)}-old`)
    .waitFor();
  await page.locator("#runtime-log-source").selectOption("gateway");
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText(/ECONNREFUSED/)
    .waitFor();
  assert.equal(await page.getByRole("note").count(), 0);

  // A dedicated Harness whose Pod does not exist yet still explains the Gateway errors.
  computeDriver.state.harnessPod = { created: false };
  await page.reload();
  await page.locator("#runtime-log-source").selectOption("gateway");
  const missing = page.getByRole("note").filter({ hasText: "The Agent (Harness) has no Pod yet" });
  await missing.waitFor();
  assert.match(await missing.textContent(), /see Deployment activity/);
});

test("a reader without operate learns what log text needs and is asked for status once per page", async (t) => {
  const { fixture, namespace, agent, revisionId } = await logsFixture(t);
  const reader = await fixture.createAccountWithPolicy("runtime-reader", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-runtime-reader",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-runtime-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-runtime-reader",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search, reader.credentials);

  await page
    .getByText(
      /Runtime status requires Agent operate .* Log text needs Agent read_logs \(or administer\) and read access\./,
    )
    .waitFor();
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length;
  assert.equal(statusReads(), 1);

  // Every denied read is an audited authorization denial: reopening the tab does not ask again.
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await page.getByText(/Log text needs Agent read_logs/).waitFor();
  await page.waitForTimeout(500);
  assert.equal(statusReads(), 1);
});

test("a status denial for one operator does not carry over to the next sign-in on the tab", async (t) => {
  const { fixture, namespace, agent, revisionId } = await logsFixture(t);
  const reader = await fixture.createAccountWithPolicy("runtime-switch-reader", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-runtime-switch-reader",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-runtime-switch-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-runtime-switch-reader",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search, reader.credentials);
  await page.getByText(/Runtime status requires Agent operate/).waitFor();

  // Sign out and in as the administrator without reloading the page.
  await page.getByRole("button", { name: "OpenClaw Enterprise", exact: true }).click();
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.waitForURL(/\/console\/agents/);
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length;
  const before = statusReads();
  await page.evaluate((target) => {
    globalThis.history.pushState(null, "", target);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, url.pathname + url.search);

  await page.locator(".runtime-pod").getByRole("heading", { name: "Gateway" }).waitFor();
  await page.getByRole("log", { name: "Runtime log output" }).waitFor();
  assert.ok(statusReads() > before);
  assert.equal(await page.getByText(/Runtime status requires Agent operate/).count(), 0);
});

test("Back restores a followed Logs view without replaying its reads and keeps polling", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  // Enough earlier output that the pane scrolls: detaching it for Back's cache resets its
  // offset, which must not leave follow paused as though the reader had scrolled up.
  const earlier = Array.from({ length: 120 }, (_, index) => ({
    time: `2026-09-30T11:59:00.${String(index + 1).padStart(9, "0")}Z`,
    raw: `earlier output ${index + 1}`,
  }));
  computeDriver.state.lines = [...earlier, line(1, "before leaving")];
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // A recorded deployment result keeps the Agent view cacheable for Back.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            deploymentId: revisionId,
            namespaceId: namespace.id,
            agentId: agent.id,
            status: "succeeded",
            error: null,
            warnings: [],
            progress: null,
          },
          meta: { requestId: "req_logs_back" },
        }),
      }),
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url.pathname + url.search);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("before leaving").waitFor();
  await page.getByRole("button", { name: "Follow" }).click();
  for (const [second, tick] of [
    [2, "first poll"],
    [3, "second poll"],
  ]) {
    computeDriver.state.lines = [...computeDriver.state.lines, line(second, tick)];
    await page.clock.runFor(2_000);
    await pane.getByText(tick).waitFor();
  }
  const panel = await pane.elementHandle();
  const overflowing = (node) => node.scrollHeight > node.clientHeight;
  assert.equal(await panel.evaluate(overflowing), true);
  const logPaths = () =>
    requests.filter(({ path }) => path.includes("/runtime/logs")).map(({ path }) => path);
  const statusReads = () => requests.filter(({ path }) => path.endsWith("/runtime")).length;
  const readBeforeLeaving = new Set(logPaths());
  const logReadsBeforeLeaving = logPaths().length;

  // Both timers fire while the view is cached and stop.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces" }).waitFor();
  await page.clock.runFor(25_000);
  const statusBeforeBack = statusReads();
  computeDriver.state.lines = [...computeDriver.state.lines, line(9, "after back")];
  await page.goBack();
  // The cached view stays inert, its controls disabled, until Back revalidates it.
  await page
    .locator(".agent-logs button[aria-pressed='true']:enabled", { hasText: "Following" })
    .waitFor();
  assert.equal(await panel.evaluate((node) => node.isConnected), true);

  // The restored view resumes from its cursor; Back replays none of its earlier reads.
  await page.clock.runFor(2_000);
  await pane.getByText("after back").waitFor();
  // The reader was at the bottom when leaving and stays there as new lines arrive.
  assert.equal(
    await panel.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 24),
    true,
  );
  assert.ok(statusReads() > statusBeforeBack);
  const readAfterBack = logPaths().slice(logReadsBeforeLeaving);
  assert.ok(readAfterBack.length > 0);
  assert.deepEqual(
    readAfterBack.filter((path) => readBeforeLeaving.has(path) || path.includes("tailLines")),
    [],
  );
});
