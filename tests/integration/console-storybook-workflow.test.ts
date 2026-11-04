import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChannelDirectoryResult } from "@openclaw-enterprise/contracts";
import {
  ChannelDirectoryLookupBody,
  ErrorResponse,
} from "../../packages/contracts/src/api/common.ts";
import { ChannelDirectoryLookupResponse } from "../../packages/contracts/src/api/resources.ts";
import { serveChannelDirectory } from "../../scripts/console-storybook/public/channel-directory-fixture.mts";
import { SandboxNetworkPolicyConfiguration } from "../../packages/contracts/src/sandbox-policy.ts";
import networkPolicySchema from "../../scripts/console-storybook/public/network-policy-schema.mts";
import { createFixtureFetch } from "../../scripts/console-storybook/public/preview-rules.mts";

import { settingsScenarios } from "../../scripts/console-storybook/public/scenario-groups/settings.mts";

const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { loadYaml } = controller("@kubernetes/client-node");
const workflowFile = new URL("../../.github/workflows/console-storybook.yml", import.meta.url);

// GitHub's documented filter rules: "*" stops at "/", "**" does not, "**/" may match no
// directory, and a later "!" pattern removes files an earlier pattern selected.
function matches(file: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*/g, (star) =>
      star === "**/" ? "(?:.*/)?" : star === "*" ? "[^/]*" : ".*",
    );
  return new RegExp(`^${source}$`).test(file);
}

function selects(file: string, patterns: string[]): boolean {
  let selected = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      selected &&= !matches(file, pattern.slice(1));
    } else {
      selected ||= matches(file, pattern);
    }
  }
  return selected;
}

const evidence = "scripts/console-storybook/evidence/console-navigation";
const scenarios = [
  // The preview asset builder renders the preview frame from the example theme.
  { name: "theme only", changed: ["deploy/examples/console-theme/theme.json"], builds: true },
  // The preview asset builder bundles the shipped Presets into the preview.
  { name: "consumed Preset only", changed: ["deploy/presets/swe-preset.json"], builds: true },
  {
    name: "typed asset preparer only",
    changed: ["scripts/console-storybook/prepare-assets.ts"],
    builds: true,
  },
  // Recordings are outside the published Storybook assets, so they need no build.
  {
    name: "recorded media only",
    changed: [
      `${evidence}/repository-outage.png`,
      `${evidence}/repository-outage.mp4`,
      "scripts/console-storybook/evidence/overview.png",
    ],
    builds: false,
  },
  // A frame under public/ is published, so media in the same change cannot hide it.
  {
    name: "media with a published frame",
    changed: [`${evidence}/repository-outage.webm`, "scripts/console-storybook/public/frame.html"],
    builds: true,
  },
  {
    name: "Storybook configuration",
    changed: ["scripts/console-storybook/.storybook/main.ts"],
    builds: true,
  },
  {
    name: "typed preview consumer",
    changed: ["scripts/console-storybook/flows.stories.ts"],
    builds: true,
  },
  {
    name: "unrelated OCC source",
    changed: ["packages/occ/src/deployment-diagnostics.ts"],
    builds: false,
  },
];

for (const event of ["pull_request", "push"] as const) {
  test(`${event} selects Console Storybook build paths`, async () => {
    const workflow = loadYaml(await readFile(workflowFile, "utf8"));
    // The workflow starts when at least one changed file survives the whole list.
    for (const { name, changed, builds } of scenarios) {
      const starts = changed.some((file) => selects(file, workflow.on[event].paths));
      assert.equal(starts, builds, name);
    }
  });
}

test("Storybook fixture fetch honors native requests, overrides, and pre-aborted writes", async () => {
  const calls: { url: string; method: string; body: unknown; header: string | null }[] = [];
  const requests: { method: string; path: string }[] = [];
  const fetch = createFixtureFetch([], requests, async (url, method, body, headers) => {
    assert.ok(headers instanceof Headers);
    calls.push({ url: url.href, method, body, header: headers.get("x-preview") });
    return new Response(null, { status: 204 });
  });
  const url = new URL("https://preview.example.test/bindings");
  assert.equal((await fetch(url)).status, 204);
  const init = {
    method: "post",
    headers: { "X-Preview": "  original  " },
    body: JSON.stringify({ id: "preview-binding" }),
  };
  assert.equal((await fetch(new Request(url, init))).status, 204);
  // RequestInit replaces the native Request's method, body, and headers at dispatch.
  assert.equal(
    (
      await fetch(new Request(url, init), {
        method: "put",
        headers: { "X-PREVIEW": "  override  " },
        body: JSON.stringify({ id: "replacement-binding" }),
      })
    ).status,
    204,
  );
  // A character can span two chunks of a native streaming request body.
  const encoded = new TextEncoder().encode('{"id":"caf\u00e9"}');
  const split = encoded.indexOf(0xc3) + 1;
  assert.ok(split > 0);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.subarray(0, split));
      controller.enqueue(encoded.subarray(split));
      controller.close();
    },
  });
  const streamInit: RequestInit & { duplex: "half" } = {
    method: "POST",
    body: stream,
    duplex: "half",
  };
  assert.equal((await fetch(new Request(url, streamInit))).status, 204);
  const cancelled = new Request(url, { ...init, signal: AbortSignal.abort() });
  await assert.rejects(fetch(cancelled), { name: "AbortError" });
  await assert.rejects(fetch(new Request(url, init), { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
  assert.deepEqual(calls, [
    { url: url.href, method: "GET", body: {}, header: null },
    { url: url.href, method: "POST", body: { id: "preview-binding" }, header: "original" },
    { url: url.href, method: "PUT", body: { id: "replacement-binding" }, header: "override" },
    { url: url.href, method: "POST", body: { id: "caf\u00e9" }, header: null },
  ]);
  assert.deepEqual(requests, [
    { method: "GET", path: "/bindings" },
    { method: "POST", path: "/bindings" },
    { method: "PUT", path: "/bindings" },
    { method: "POST", path: "/bindings" },
  ]);
});

test("Storybook fixture fetch aborts an open request body before dispatch", async () => {
  const requests: { method: string; path: string }[] = [];
  let dispatches = 0;
  const fetch = createFixtureFetch([], requests, async () => {
    dispatches += 1;
    return new Response(null, { status: 204 });
  });
  const abort = new AbortController();
  const reason = new Error("Cancelled preview write");
  const pulled = Promise.withResolvers<void>();
  const sourceCleanup = Promise.withResolvers<void>();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancellation: unknown;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        source = controller;
      },
      pull() {
        pulled.resolve();
      },
      cancel(reason: unknown) {
        cancellation = reason;
        return sourceCleanup.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
    signal: abort.signal,
  };
  const request = new Request("https://preview.example.test/bindings", init);
  const deadline = new AbortController();
  const timedOut = delay(1000, undefined, { signal: deadline.signal }).then(() => {
    assert.fail("Aborted fetch did not reject while the request body was open");
  });
  const rejected = assert.rejects(fetch(request), (error) => error === reason);
  try {
    await Promise.race([pulled.promise, timedOut]);
    abort.abort(reason);
    await Promise.race([rejected, timedOut]);
    assert.equal(cancellation, reason);
    assert.deepEqual(requests, []);
    assert.equal(dispatches, 0);
  } finally {
    deadline.abort();
    if (cancellation === undefined) {
      source?.close();
    } else {
      // Cleanup can fail after fetch has already rejected; it must not reject again.
      sourceCleanup.reject(new Error("Body source cleanup failed"));
    }
  }
});

test("shared preview inputs select the Storybook build only on pushes to main", async (t) => {
  const workflow = loadYaml(await readFile(workflowFile, "utf8"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  for (const path of [
    "apps/controller/src/console-theme.ts",
    "apps/controller/src/composition/console-theme.ts",
    "packages/contracts/src/workspace-defaults.mjs",
    "packages/occ/src/environment-references.ts",
    "packages/occ/src/gateway-security-defaults.ts",
    "packages/occ/src/stored-configuration-rules.ts",
    "packages/occ/src/retired-openclaw-settings.ts",
    "packages/occ/src/deployment-failure-steps.ts",
  ]) {
    await t.test(path, () => {
      assert.equal(selects(path, workflow.on.pull_request.paths), false, "pull_request");
      assert.equal(selects(path, workflow.on.push.paths), true, "push to main");
    });
  }
});

test("the Storybook network policy schema matches the production JSON wire schema", () => {
  const wireSchema: unknown = JSON.parse(
    JSON.stringify(SandboxNetworkPolicyConfiguration.configurationSchema),
  );
  assert.deepEqual(networkPolicySchema, wireSchema);
});

test("Settings stories distinguish read-only access from an endpoint refusal", () => {
  const readOnly = settingsScenarios.settingsDriverConfigurationsDenied;
  const refused = settingsScenarios.settingsDriverConfigurationsEndpointRefused;

  // Read-only permissions prevent discovery; a configured refusal here would be dormant.
  assert.equal(readOnly.readOnlyPermissionSummary, true);
  assert.equal("rules" in readOnly, false);
  assert.equal(readOnly.path, "/console/settings");

  // Default allowing permissions reach the first GET, with no skip or earlier rule.
  assert.equal("readOnlyPermissionSummary" in refused, false);
  assert.equal(refused.path, "/console/settings");
  assert.deepEqual(refused.rules, [
    { path: "/installation/driver-configurations", status: 403, code: "FORBIDDEN" },
  ]);
});

test("directory preview rejects malformed requests without losing search or ID lookup", async () => {
  const { Check }: { Check(schema: unknown, value: unknown): boolean } =
    controller("typebox/value");
  const validEnvelope = (value: unknown): value is { data: ChannelDirectoryResult } =>
    Check(ChannelDirectoryLookupResponse, value);
  const secretId = "sec_demo_slack_bot_token";
  const canonicalSecretId = "sec_00000000-0000-4000-8000-000000000001";
  const configurationId = "cfg_00000000-0000-4000-8000-000000000001";
  const agentId = "agt_00000000-0000-4000-8000-000000000001";
  const base = { kind: "users", secretId };
  const secrets = new Map([[secretId, {}]]);
  const evidence: Parameters<typeof serveChannelDirectory>[2] = { directoryResponses: [] };
  const fixture = createFixtureFetch([], [], async (_url, _method, body) =>
    serveChannelDirectory(body, secrets, evidence),
  );
  const url = "https://preview.example.test/channel-directory/lookup";
  const post = (body: unknown) => fixture(url, { method: "POST", body: JSON.stringify(body) });
  async function lookup(fields: object) {
    // The wire schema uses a UUID where the preview uses a seeded Secret alias.
    assert.equal(
      Check(ChannelDirectoryLookupBody, { ...base, ...fields, secretId: canonicalSecretId }),
      true,
    );
    const response = await post({ ...base, ...fields });
    assert.equal(response.status, 200);
    const envelope: unknown = await response.json();
    assert.ok(validEnvelope(envelope));
    return envelope.data;
  }
  const first = await lookup({ agentId });
  assert.equal(first.candidates.length, 7);
  assert.equal(first.nextCursor, "page-2");
  assert.equal(first.complete, false);
  const second = await lookup({ cursor: first.nextCursor, configurationId });
  assert.deepEqual(
    second.candidates.map(({ id }) => id),
    ["UDEMO130", "UDEMO131"],
  );
  assert.equal(second.complete, true);
  assert.equal(second.nextCursor, undefined);
  const alex = await lookup({ query: "aLeX" });
  assert.deepEqual(alex.candidates, [
    { id: "UDEMO123", name: "alex.chen", displayName: "Alex Chen" },
    { id: "UDEMO124", name: "alex.ops", displayName: "Alex Chen" },
  ]);
  assert.deepEqual(
    (await lookup({ ids: ["UDEMO124", "udemo123", "UDEMO123"] })).candidates,
    alex.candidates,
  );
  assert.deepEqual((await lookup({ kind: "channels", ids: ["GDEMO124"] })).candidates, [
    { id: "GDEMO124", name: "incident-private" },
  ]);
  assert.deepEqual((await lookup({ query: "😀".repeat(200) })).candidates, []);

  const count = evidence.directoryResponses.length;
  async function rejected(body: unknown, message: string) {
    const response = await post(body);
    assert.equal(response.status, 400);
    const envelope: unknown = await response.json();
    assert.equal(Check(ErrorResponse, envelope), true);
    assert.partialDeepStrictEqual(envelope, { error: { code: "INVALID_REQUEST", message } });
    assert.equal(evidence.directoryResponses.length, count);
  }
  for (const body of [
    null,
    { ...base, query: 1 },
    { ...base, ids: {} },
    { ...base, ids: "UDEMO123" },
    { ...base, ids: ["UDEMO123"], query: "" },
    { ...base, ids: ["UDEMO123", "UDEMO123"] },
    { ...base, ids: ["U\n123"] },
    { ...base, query: "😀".repeat(201) },
    { ...base, agentId, configurationId },
    { ...base, unexpected: true },
  ]) {
    await rejected(body, "Malformed channel directory preview request.");
  }
  await rejected(
    { ...base, secretId: "sec_absent" },
    "The simulated Secret is not in this preview.",
  );
  await rejected(
    { ...base, cursor: "unknown-preview-page" },
    "The preview cursor is not recognized.",
  );
  await assert.rejects(fixture(url, { method: "POST", body: "{" }), SyntaxError);
});

test("Storybook creation routes preserve persistence, recovery and malformed terminal replies", async (t) => {
  // Resolve the same authored Preset JSON that prepare-assets.ts wraps for browsers.
  // The responder and its fetch dispatcher run unchanged; this is fixture proof, not Controller proof.
  const presetFiles = new Map([
    ["/console/default-codex-preset.mjs", "default-codex"],
    ["/console/standard-codex-preset.mjs", "standard-codex"],
    ["/console/standard-openclaw-preset.mjs", "standard-openclaw"],
    ["/console/swe-preset.mjs", "swe-preset"],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const preset = presetFiles.get(specifier);
      if (preset === undefined) {
        return nextResolve(specifier, context);
      }
      const file = new URL(`../../deploy/presets/${preset}.json`, import.meta.url);
      return {
        url: `data:text/javascript,${encodeURIComponent(`export default ${readFileSync(file, "utf8")};`)}`,
        shortCircuit: true,
      };
    },
  });
  t.after(() => hooks.deregister());
  const { installFixture } = await import("../../scripts/console-storybook/public/fixtures.mjs");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  t.after(() => {
    for (const [key, descriptor] of [
      ["window", previousWindow],
      ["sessionStorage", previousStorage],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const storage = new Map<string, string>();
  const frame = { fetch: globalThis.fetch };
  Object.defineProperty(globalThis, "window", { configurable: true, value: frame });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  const namespace = "ns_00000000-0000-4000-8000-000000000001";
  const path = `/namespaces/${namespace}/`;
  const id = (prefix: string, serial: number) =>
    `${prefix}_00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
  const request = (resource: string, method = "GET", body?: unknown) =>
    frame.fetch(`https://preview.example.test${path}${resource}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
  const evidence = () => ({ requests: [], directoryResponses: [], unhandled: [], ready: false });
  const configuration = {
    kind: "agent",
    values: {
      agents: { defaults: { model: "codex/gpt-4.1" } },
      security: { preset: "historical" },
    },
  };
  const provisionBody = {
    name: "Created through fetch",
    requestId: "req_00000000-0000-4000-8000-000000000050",
    configuration,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: "cs_model" },
    initialWorkspaceFiles: { "AGENTS.md": "Synthetic workspace instructions" },
  };

  await t.test("Configuration merge, partial save and Create staging", async () => {
    installFixture(
      {
        configurationChangedElsewhere: {
          values: { agents: { defaults: { model: "codex/gpt-5.1" } } },
        },
      },
      evidence(),
    );
    const created = await request("configurations", "POST", configuration);
    assert.equal(created.status, 201);
    const configId = id("cfg", 100);
    assert.partialDeepStrictEqual(await (await request(`configurations/${configId}`)).json(), {
      data: { generation: 1, values: configuration.values },
    });
    assert.partialDeepStrictEqual(await (await request(`configurations/${configId}`)).json(), {
      data: {
        generation: 2,
        values: {
          agents: { defaults: { model: "codex/gpt-5.1" } },
          security: { preset: "historical" },
        },
      },
    });
    assert.partialDeepStrictEqual(
      await (await request(`configurations/${configId}`, "PATCH", { secretBindings: {} })).json(),
      { data: { generation: 3, secretBindings: {} } },
    );
    const agent = await request("agents", "POST", {
      ...provisionBody,
      configuration: undefined,
      requestId: undefined,
      configurationId: configId,
      workspaceDefaultsId: "synthetic-defaults",
    });
    assert.equal(agent.status, 201);
    assert.partialDeepStrictEqual(await agent.json(), {
      data: {
        id: id("agt", 101),
        name: provisionBody.name,
        desiredRuntimeState: "stopped",
        configurationId: configId,
      },
    });
    assert.partialDeepStrictEqual(
      await (await request(`agents/${id("agt", 101)}/runtime-credentials`)).json(),
      { data: { transportConfigured: false } },
    );
    await request(`agents/${id("agt", 101)}/deploy`, "POST", {});
    assert.partialDeepStrictEqual(
      await (await request(`agents/${id("agt", 101)}/workspace/files/AGENTS.md`)).json(),
      { data: { content: provisionBody.initialWorkspaceFiles["AGENTS.md"] } },
    );
  });

  await t.test(
    "deployment snapshots, one-time staging, stop readback and deferred deletion",
    async () => {
      installFixture({ clearRevisionOnStopReadback: true }, evidence());
      const agentPath = `agents/${id("agt", 100)}`;
      await request("agents", "POST", {
        name: "Staged Agent",
        configurationId: id("cfg", 1),
        executionMode: "dedicated",
        initialWorkspaceFiles: { "AGENTS.md": "Initial guidance" },
      });
      const firstRevision = id("rev", 101);
      assert.equal((await request(`${agentPath}/deploy`, "POST", {})).status, 202);
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/deployments/${firstRevision}`)).json(),
        {
          data: { status: "queued" },
        },
      );
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/deployments/${firstRevision}`)).json(),
        {
          data: { status: "succeeded" },
        },
      );
      // Editing current inputs must not alter the admitted snapshot; staged files
      // are consumed once, so redeploy must preserve a later workspace edit.
      await request(`configurations/${id("cfg", 1)}`, "PATCH", {
        values: { agents: { defaults: { model: "codex/gpt-5.1" } } },
      });
      await request(agentPath, "PATCH", {
        executionMode: "embedded",
        extraSetting: { retained: true },
      });
      await request(`${agentPath}/workspace/files/AGENTS.md`, "PUT", {
        content: "Edited guidance",
      });
      await request(`${agentPath}/deploy`, "POST", {});
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/revisions/${firstRevision}`)).json(),
        {
          data: {
            revision: 1,
            configurationGeneration: 1,
            harness: { mode: "dedicated" },
            configuration: { agents: { defaults: { model: "codex/gpt-4.1" } } },
          },
        },
      );
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/revisions/${id("rev", 102)}`)).json(),
        {
          data: { revision: 2, configurationGeneration: 2, harness: { mode: "embedded" } },
        },
      );
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/workspace/files/AGENTS.md`)).json(),
        {
          data: { content: "Edited guidance" },
        },
      );
      // Stop acknowledges the old selection; only the following detail read clears it.
      assert.partialDeepStrictEqual(await (await request(`${agentPath}/stop`, "POST", {})).json(), {
        data: { desiredRuntimeState: "stopped", activeRevisionId: firstRevision },
      });
      assert.partialDeepStrictEqual(await (await request(agentPath)).json(), {
        data: { activeRevisionId: null, extraSetting: { retained: true } },
      });
      assert.equal((await request(agentPath, "DELETE")).status, 202);
      assert.equal((await request(agentPath)).status, 404);
    },
  );

  await t.test("version lookups and deployment polls stay with their owning Agent", async () => {
    const { Check }: { Check(schema: unknown, value: unknown): boolean } =
      controller("typebox/value");
    const agentA = id("agt", 100);
    const revisionA = id("rev", 101);
    const agentB = id("agt", 102);
    const revisionB = id("rev", 103);
    installFixture(
      {
        rules: [
          {
            method: "GET",
            suffix: `/agents/${agentB}/revisions/${revisionA}`,
            status: 403,
            code: "FORBIDDEN",
            once: true,
          },
        ],
      },
      evidence(),
    );
    for (const agentId of [agentA, agentB]) {
      assert.equal(
        (
          await request("agents", "POST", {
            name: agentId,
            configurationId: id("cfg", 1),
            executionMode: "dedicated",
          })
        ).status,
        201,
      );
      assert.equal((await request(`agents/${agentId}/deploy`, "POST", {})).status, 202);
    }
    // An authored denial still wins before the ownership check.
    assert.equal((await request(`agents/${agentB}/revisions/${revisionA}`)).status, 403);
    const notFound = {
      error: { code: "NOT_FOUND", message: "The requested platform resource was not found." },
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    };
    for (const [agentId, ownRevision, otherRevision] of [
      [agentA, revisionA, revisionB],
      [agentB, revisionB, revisionA],
    ]) {
      for (const revisionId of [otherRevision, id("rev", 999)]) {
        for (const [suffix, method] of [
          [`revisions/${revisionId}`, "GET"],
          [`deployments/${revisionId}`, "GET"],
          [`deployments/${revisionId}/runtime`, "GET"],
          [`deployments/${revisionId}/diagnostics`, "POST"],
        ]) {
          const reply = await request(`agents/${agentId}/${suffix}`, method);
          assert.equal(reply.status, 404, `${agentId}/${suffix}`);
          const body: unknown = await reply.json();
          assert.equal(Check(ErrorResponse, body), true);
          assert.deepEqual(body, notFound);
        }
      }
      const collection: unknown = await (await request(`agents/${agentId}/revisions`)).json();
      assert.ok(
        collection &&
          typeof collection === "object" &&
          "data" in collection &&
          Array.isArray(collection.data),
      );
      assert.equal(collection.data.length, 1);
      assert.partialDeepStrictEqual(collection, { data: [{ id: ownRevision, agentId }] });
      assert.partialDeepStrictEqual(
        await (await request(`agents/${agentId}/revisions/${ownRevision}`)).json(),
        {
          data: { id: ownRevision, agentId },
        },
      );
      assert.equal(
        (await request(`agents/${agentId}/deployments/${ownRevision}/runtime`)).status,
        200,
      );
      assert.equal(
        (await request(`agents/${agentId}/deployments/${ownRevision}/diagnostics`, "POST")).status,
        200,
      );
    }
    // Neither rejected lookups nor runtime/diagnostic reads may poll a deployment
    // or select a version. Each owner's first actual poll must still be queued.
    for (const [agentId, revisionId] of [
      [agentA, revisionA],
      [agentB, revisionB],
    ]) {
      assert.partialDeepStrictEqual(await (await request(`agents/${agentId}`)).json(), {
        data: { activeRevisionId: null },
      });
      assert.partialDeepStrictEqual(
        await (await request(`agents/${agentId}/deployments/${revisionId}`)).json(),
        {
          data: { status: "queued", agentId },
        },
      );
    }
    assert.partialDeepStrictEqual(
      await (await request(`agents/${agentA}/deployments/${revisionA}`)).json(),
      {
        data: { status: "succeeded" },
      },
    );
    assert.partialDeepStrictEqual(await (await request(`agents/${agentA}`)).json(), {
      data: { activeRevisionId: revisionA },
    });
    assert.partialDeepStrictEqual(await (await request(`agents/${agentB}`)).json(), {
      data: { activeRevisionId: null },
    });
    assert.partialDeepStrictEqual(
      await (await request(`agents/${agentB}/deployments/${revisionB}`)).json(),
      {
        data: { status: "succeeded" },
      },
    );
    assert.partialDeepStrictEqual(await (await request(`agents/${agentB}`)).json(), {
      data: { activeRevisionId: revisionB },
    });
  });

  await t.test(
    "seeded revision pagination and runtime reads drive the failed redeploy race",
    async () => {
      installFixture(
        {
          deployed: true,
          revisionHistory: 3,
          stopElsewhereOnReread: true,
          failedRedeployOnReread: true,
        },
        evidence(),
      );
      const agentPath = `agents/${id("agt", 1)}`;
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/revisions?limit=2`)).json(),
        {
          data: [{ revision: 3 }, { revision: 2 }],
          meta: { nextCursor: "v1.2" },
        },
      );
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/revisions?limit=2&cursor=v1.2`)).json(),
        {
          data: [{ revision: 1 }],
          meta: { nextCursor: null },
        },
      );
      const runtime = `${agentPath}/deployments/${id("rev", 1)}/runtime`;
      await request(`${runtime}/logs`);
      // The diagnostic module only signals a read. The lifecycle owner performs the
      // competing stop and preserves omission rather than converting it to null.
      const stopped = await request(agentPath);
      assert.partialDeepStrictEqual(await stopped.clone().json(), {
        data: { desiredRuntimeState: "stopped" },
      });
      assert.doesNotMatch(await stopped.text(), /"activeRevisionId"/);
      // Rejected runtime reads must not contribute to the two-read redeploy race.
      assert.equal(
        (await request(`${agentPath}/deployments/${id("rev", 999)}/runtime`)).status,
        404,
      );
      assert.equal(
        (await request(`agents/${id("agt", 2)}/deployments/${id("rev", 1)}/runtime`)).status,
        404,
      );
      assert.partialDeepStrictEqual(await (await request(agentPath)).json(), {
        data: { desiredRuntimeState: "stopped" },
      });
      await request(runtime);
      assert.partialDeepStrictEqual(await (await request(agentPath)).json(), {
        data: { desiredRuntimeState: "stopped" },
      });
      await request(runtime);
      const restarted = await request(agentPath);
      assert.partialDeepStrictEqual(await restarted.clone().json(), {
        data: { desiredRuntimeState: "running" },
      });
      assert.doesNotMatch(await restarted.text(), /"activeRevisionId"/);
      assert.partialDeepStrictEqual(
        await (await request(`${agentPath}/deployments/${id("rev", 18)}`)).json(),
        {
          data: { status: "failed", error: { code: "RUNTIME_MODEL_PROBE_TIMEOUT" } },
        },
      );
    },
  );

  for (const malformedProvisioningReply of ["revision-id", "error-message"] as const) {
    await t.test(
      `failed job preserves stored deployment with ${malformedProvisioningReply}`,
      async () => {
        installFixture(
          { provisionedDeploymentStatus: "failed", malformedProvisioningReply },
          evidence(),
        );
        const admitted = await request("agents/provision", "POST", provisionBody);
        assert.equal(admitted.status, 202);
        const job = `agents/provision/${id("work", 100)}`;
        assert.partialDeepStrictEqual(await (await request(job)).json(), {
          data: { provisioning: { status: "running", phase: "configuration" } },
        });
        const terminal: unknown = await (await request(job)).json();
        assert.partialDeepStrictEqual(terminal, {
          data: {
            provisioning: {
              status: "failed",
              phase: "handoff",
              agentId: id("agt", 102),
              ...(malformedProvisioningReply === "revision-id"
                ? { revisionId: 17 }
                : { error: { message: { detail: "Unreadable provisioning message" } } }),
            },
          },
        });
        assert.partialDeepStrictEqual(
          await (await request(`agents/${id("agt", 102)}/deployments/${id("rev", 103)}`)).json(),
          {
            data: {
              deploymentId: id("rev", 103),
              status: "failed",
              error: { code: "DEPENDENCY_UNAVAILABLE" },
            },
          },
        );
        assert.partialDeepStrictEqual(await (await request(`${job}/retry`, "POST", {})).json(), {
          data: { provisioning: { status: "queued", attemptCount: 2 } },
        });
        assert.partialDeepStrictEqual(await (await request(job)).json(), {
          data: { provisioning: { status: "running", phase: "configuration" } },
        });
        assert.partialDeepStrictEqual(await (await request(`agents/${id("agt", 102)}`)).json(), {
          data: { credentialSources: [{ sourceId: "cs_model" }] },
        });
      },
    );
  }

  await t.test("cancellation has no revision; deployment waits retain progress", async () => {
    installFixture({ provisioningCancelledByStop: true }, evidence());
    await request("agents/provision", "POST", provisionBody);
    const job = `agents/provision/${id("work", 100)}`;
    await request(job);
    const cancelled: unknown = await (await request(job)).json();
    assert.partialDeepStrictEqual(cancelled, {
      data: { provisioning: { status: "failed", error: { code: "PROVISIONING_CANCELLED" } } },
    });
    assert.ok(cancelled !== null && typeof cancelled === "object" && "data" in cancelled);
    const data = cancelled.data;
    assert.ok(data !== null && typeof data === "object" && "provisioning" in data);
    assert.ok(data.provisioning !== null && typeof data.provisioning === "object");
    assert.equal("revisionId" in data.provisioning, false);
    assert.partialDeepStrictEqual(await (await request(`agents/${id("agt", 102)}`)).json(), {
      data: { desiredRuntimeState: "stopped", activeRevisionId: null },
    });

    const attempt = { code: "DEPENDENCY_UNAVAILABLE", message: "Waiting for the dependency" };
    installFixture(
      {
        provisionedDeploymentStatus: "running",
        provisioningNamesDeploymentWait: true,
        provisionedDeploymentAttempt: attempt,
      },
      evidence(),
    );
    await request("agents/provision", "POST", provisionBody);
    await request(job);
    assert.partialDeepStrictEqual(await (await request(job)).json(), {
      data: {
        provisioning: {
          status: "running",
          phase: "handoff",
          progress: { phase: "deployment", lastAttempt: attempt },
        },
      },
    });
  });

  await t.test(
    "authored boolean race and Slack-only credential projection remain intact",
    async () => {
      const { scenarios: catalog } =
        await import("../../scripts/console-storybook/public/scenarios.mjs");
      installFixture(catalog.channelChangedElsewhere, evidence());
      const configurationPath = `configurations/${id("cfg", 1)}`;
      const before: unknown = await (await request(configurationPath)).json();
      assert.partialDeepStrictEqual(before, { data: { generation: 1 } });
      assert.partialDeepStrictEqual(await (await request(configurationPath)).json(), {
        data: { generation: 2 },
      });
      assert.partialDeepStrictEqual(await (await request(configurationPath)).json(), {
        data: { generation: 2 },
      });
      installFixture(catalog.slackMcpTools, evidence());
      const saved: unknown = await (await request(`agents/${id("agt", 1)}`)).json();
      assert.ok(saved !== null && typeof saved === "object" && "data" in saved);
      assert.ok(
        saved.data !== null && typeof saved.data === "object" && "credentialSources" in saved.data,
      );
      assert.deepEqual(saved.data.credentialSources, catalog.slackMcpTools.credentialSources);
      assert.equal(catalog.slackMcpTools.credentialSources.length, 1);
    },
  );

  async function invalidRequest(resource: string, method: string, body: unknown) {
    const reply = await request(resource, method, body);
    assert.equal(reply.status, 400);
    assert.equal(reply.headers.get("content-type"), "application/json");
    const payload: unknown = await reply.json();
    assert.partialDeepStrictEqual(payload, { error: { code: "INVALID_REQUEST" } });
    assert.ok(payload !== null && typeof payload === "object" && "error" in payload);
    assert.ok(
      payload.error !== null && typeof payload.error === "object" && "message" in payload.error,
    );
    assert.equal(typeof payload.error.message, "string");
    assert.match(String(payload.error.message), /^The preview requires /);
  }

  await t.test(
    "invalid Configuration writes return 400 without state or generation changes",
    async () => {
      installFixture({}, evidence());
      for (const body of [
        null,
        [],
        {},
        { ...configuration, kind: "other" },
        { ...configuration, values: [] },
        { ...configuration, secretBindings: [] },
      ]) {
        await invalidRequest("configurations", "POST", body);
      }
      const created = await request("configurations", "POST", configuration);
      assert.equal(created.status, 201);
      const saved: unknown = await created.json();
      const configPath = `configurations/${id("cfg", 100)}`;
      assert.partialDeepStrictEqual(saved, { data: { id: id("cfg", 100), generation: 1 } });
      for (const patch of [
        null,
        [],
        { kind: "other" },
        { values: null },
        { secretBindings: [] },
        { id: 17 },
        { namespaceId: 17 },
        { createdAt: 17 },
      ]) {
        await invalidRequest(configPath, "PATCH", patch);
        assert.deepEqual(await (await request(configPath)).json(), saved);
      }
      // The next real write increments once; refusals neither consume IDs nor save values.
      const updated = await request(configPath, "PATCH", { secretBindings: {} });
      assert.equal(updated.status, 200);
      assert.partialDeepStrictEqual(await updated.json(), {
        data: { generation: 2, secretBindings: {} },
      });
      const next = await request("configurations", "POST", configuration);
      assert.equal(next.status, 201);
      assert.partialDeepStrictEqual(await next.json(), {
        data: { id: id("cfg", 101), generation: 1 },
      });
    },
  );

  await t.test(
    "invalid direct Create and provision return 400 before allocating resources",
    async () => {
      installFixture({}, evidence());
      const before: unknown = await (await request("agents")).json();
      const direct = { name: "Direct create", configurationId: id("cfg", 1) };
      for (const body of [
        null,
        [],
        { ...direct, name: 17 },
        { name: direct.name },
        { ...direct, configurationId: 17 },
        { ...direct, initialWorkspaceFiles: { "AGENTS.md": 17 } },
      ]) {
        await invalidRequest("agents", "POST", body);
      }
      assert.deepEqual(await (await request("agents")).json(), before);
      const created = await request("agents", "POST", direct);
      assert.equal(created.status, 201);
      assert.partialDeepStrictEqual(await created.json(), {
        data: { id: id("agt", 100), name: direct.name },
      });

      installFixture({}, evidence());
      for (const body of [
        null,
        { ...provisionBody, name: 17 },
        { ...provisionBody, requestId: 17 },
        { ...provisionBody, configuration: undefined },
        { ...provisionBody, configuration: { ...configuration, values: [] } },
        { ...provisionBody, initialWorkspaceFiles: { "AGENTS.md": 17 } },
        { ...provisionBody, harnessAuth: { method: "credential_source" } },
        { ...provisionBody, harnessAuth: { method: "credential_source", sourceId: 17 } },
      ]) {
        await invalidRequest("agents/provision", "POST", body);
      }
      assert.deepEqual(await (await request("agents")).json(), before);
      assert.equal((await request(`configurations/${id("cfg", 101)}`)).status, 404);
      assert.equal((await request(`agents/provision/${id("work", 100)}`)).status, 404);
      const admitted = await request("agents/provision", "POST", provisionBody);
      assert.equal(admitted.status, 202);
      assert.partialDeepStrictEqual(await admitted.json(), {
        data: { provisioning: { workId: id("work", 100) } },
      });
      const job = `agents/provision/${id("work", 100)}`;
      await request(job);
      assert.partialDeepStrictEqual(await (await request(job)).json(), {
        data: {
          provisioning: {
            status: "succeeded",
            agentId: id("agt", 102),
            configurationId: id("cfg", 101),
            revisionId: id("rev", 103),
          },
        },
      });
    },
  );

  await t.test(
    "authored refusals and network errors precede guards; preflight stays permissive",
    async () => {
      // A rule refusal must not be replaced by input validation, even for a null body.
      for (const status of [403, 503]) {
        installFixture(
          { rules: [{ method: "POST", suffix: "/agents/provision", status, once: true }] },
          evidence(),
        );
        assert.equal((await request("agents/provision", "POST", null)).status, status);
        await invalidRequest("agents/provision", "POST", null);
      }
      installFixture(
        {
          rules: [{ method: "POST", suffix: "/agents/provision", networkError: true, once: true }],
        },
        evidence(),
      );
      // Authored offline behavior is still a rejected fetch, unlike an HTTP input refusal.
      await assert.rejects(request("agents/provision", "POST", provisionBody), {
        name: "TypeError",
        message: "Failed to fetch",
      });
      assert.equal((await request("agents/validate", "POST", null)).status, 204);
      const admitted = await request("agents/provision", "POST", provisionBody);
      assert.equal(admitted.status, 202);
      assert.partialDeepStrictEqual(await admitted.json(), {
        data: { provisioning: { workId: id("work", 100) } },
      });
    },
  );
});
