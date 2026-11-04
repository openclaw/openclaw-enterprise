import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
