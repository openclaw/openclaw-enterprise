import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { sanitizeRuntimeLogChunk, sanitizeSandboxLogLines } from "../../packages/occ/src/index.ts";
import { validRuntimeDescription } from "../../packages/occ/src/runtime-logs/index.ts";

// Replays real runtime output (and, for OpenShell, output rebuilt from the pinned
// source) through the pure classifier and sanitizer and compares the result with the
// committed goldens byte for byte. A golden diff after a pin bump is format drift to
// review, not a test to update blindly. Regenerate after a deliberate change with
// `UPDATE_RUNTIME_LOG_GOLDENS=1`.
const directory = new URL("../fixtures/runtime-logs/replay/", import.meta.url);
const update = process.env.UPDATE_RUNTIME_LOG_GOLDENS === "1";

// Historical captures below use UTC Z prefixes; production Driver coverage owns
// numeric-offset normalization and preserves these existing replay inputs.
const KUBELET_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) (.*)$/s;

async function manifest() {
  return JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
}

function kubeletLines(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line) => {
    const match = KUBELET_LINE.exec(line);
    return match === null ? { time: null, raw: line } : { time: match[1], raw: match[2] };
  });
}

// A simplified copy of the Kubernetes Compute Driver's private Event projection
// (`runtimePodEvents`): this Pod's Events only, newest first, count from the series when
// present, container from `involvedObject.fieldPath`. It omits the driver's Namespace check, safe-integer guard and Event cap, and
// it is not the product code, so this replay only exercises `validRuntimeDescription`
// (the node, image and object masking); it proves nothing about the driver's filter.
function driverEvents(items, podUid) {
  const time = (value) => (typeof value === "string" ? new Date(value).toISOString() : null);
  return items
    .filter(
      (event) =>
        event.involvedObject?.uid === podUid &&
        event.involvedObject.kind === "Pod" &&
        (event.type === "Normal" || event.type === "Warning"),
    )
    .map((event) => ({
      type: event.type,
      container:
        /^spec\.(?:containers|initContainers|ephemeralContainers)\{([a-z0-9-]+)\}$/.exec(
          event.involvedObject.fieldPath ?? "",
        )?.[1] ?? null,
      reason: event.reason || "Unknown",
      message: typeof event.message === "string" ? event.message : "",
      count: Math.max(1, event.series?.count ?? event.count ?? 1),
      lastObservedAt:
        time(event.series?.lastObservedTime) ??
        time(event.lastTimestamp) ??
        time(event.eventTime) ??
        time(event.firstTimestamp),
    }))
    .sort((left, right) => (right.lastObservedAt ?? "").localeCompare(left.lastObservedAt ?? ""));
}

async function replay(entry) {
  const text = await readFile(new URL(entry.file, directory), "utf8");
  if (entry.replay === "kubelet-container") {
    const lines = kubeletLines(text);
    const { records, withheld } = sanitizeRuntimeLogChunk({
      stream: {
        source: entry.source,
        pod: "fixture-pod",
        podUid: "00000000-0000-4000-8000-000000000001",
        container: entry.source,
        restartCount: 0,
      },
      lines,
      truncated: false,
    });
    return { input: lines.length, withheld, records };
  }
  if (entry.replay === "openshell-sandbox") {
    const chunk = JSON.parse(text);
    const { records, withheld } = sanitizeSandboxLogLines(
      { source: "sandbox", sandbox: chunk.sandbox },
      chunk.lines,
    );
    return { input: chunk.lines.length, withheld, records };
  }
  if (entry.replay === "kubernetes-events") {
    const { items } = JSON.parse(text);
    const podUid = items.find((event) => event.involvedObject.kind === "Pod").involvedObject.uid;
    const events = driverEvents(items, podUid);
    const description = validRuntimeDescription(
      {
        revisionId: "rev_fixture",
        observedAt: "2026-09-30T15:00:00.000Z",
        pods: [
          {
            role: "gateway",
            cluster: "control",
            name: "fixture-pod",
            uid: podUid,
            phase: "Running",
            ready: false,
            createdAt: "2026-09-30T14:58:30.000Z",
            containers: [],
            events,
          },
        ],
        sources: [],
      },
      "rev_fixture",
    );
    return { input: items.length, events: description.pods[0].events };
  }
  throw new Error(`unknown replay ${entry.replay}`);
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("the replay manifest lists every fixture on disk and nothing else", async () => {
  const { count, fixtures } = await manifest();
  const files = (await readdir(directory)).filter((name) => name !== "manifest.json").sort();
  const listed = fixtures.flatMap(({ file, golden }) => [file, golden]).sort();
  assert.deepEqual(files, listed, "fixtures and goldens on disk match the manifest");
  assert.equal(fixtures.length, count, "the manifest count matches its entries");
  for (const entry of fixtures) {
    assert.ok(["captured", "upstream-derived"].includes(entry.provenance), entry.file);
    assert.ok(entry.origin.length > 0 && entry.scrubbed.length > 0, entry.file);
  }
  // Every runtime source that reaches the sanitizer has at least one fixture.
  const sources = new Set(fixtures.map(({ source }) => source));
  for (const source of ["gateway", "agent", "sandbox", "events"]) {
    assert.ok(sources.has(source), `no replay fixture for ${source}`);
  }
});

test("replayed runtime output matches the committed goldens", async (t) => {
  const { fixtures } = await manifest();
  for (const entry of fixtures) {
    await t.test(entry.file, async () => {
      const actual = serialize(await replay(entry));
      const goldenUrl = new URL(entry.golden, directory);
      if (update) {
        await writeFile(goldenUrl, actual);
      }
      const expected = await readFile(goldenUrl, "utf8");
      // Never a vacuous pass: a golden with no output would match an empty replay.
      assert.ok(JSON.parse(expected).input > 0, `${entry.golden} replays no input`);
      assert.equal(actual, expected, `${entry.file} drifted from ${entry.golden}`);
    });
  }
});

test("real Gateway, wrapper and Codex output is classified, not withheld", async () => {
  const { fixtures } = await manifest();
  const byFile = Object.fromEntries(
    await Promise.all(fixtures.map(async (entry) => [entry.file, await replay(entry)])),
  );

  const wrapper = byFile["gateway-wrapper-probe-failed.kubelet.txt"];
  assert.deepEqual(
    wrapper.records.map(({ kind, level, message }) => [kind, level, message]),
    [
      ["wrapper", "error", "openclaw.model_probe"],
      ["wrapper", "error", "runtime.startup_phase"],
      ["wrapper", "error", "Harness model authentication probe failed."],
    ],
  );
  assert.equal(wrapper.records[0].fields.code, "AUTHENTICATION_FAILED");

  const gateway = byFile["gateway-console-startup.kubelet.txt"];
  assert.equal(gateway.withheld, 0);
  assert.equal(gateway.records.length, gateway.input);
  assert.ok(gateway.records.every(({ kind, time }) => kind === "openclaw" && time !== null));
  assert.ok(gateway.records.some(({ level }) => level === "warn"));
  assert.ok(gateway.records.some(({ subsystem }) => subsystem === "gateway/heartbeat"));
  // Keys outside the operational allowlist (`intervalMs`, `providers`, `generatedAt`) drop.
  assert.ok(gateway.records.every(({ fields }) => fields === undefined));

  // The Harness prints its node setup result as pretty-printed JSON; the whole value is
  // one withheld run, and the wrapper events after it are still classified.
  const harness = byFile["agent-harness-startup.kubelet.txt"];
  assert.deepEqual(
    harness.records
      .slice(0, 2)
      .map(({ type, reason, count, message }) => [type, reason ?? message, count]),
    [
      ["withheld", "malformed", 7],
      ["line", "runtime.startup_phase", undefined],
    ],
  );
  assert.equal(JSON.stringify(harness.records).includes("configPath"), false);
  assert.ok(harness.records.some(({ message }) => message === "codex.model_probe"));

  const codex = byFile["codex-app-server-startup.kubelet.txt"];
  assert.equal(codex.withheld, 0);
  const tracing = codex.records.filter(({ kind }) => kind === "codex");
  assert.ok(tracing.length > 20);
  assert.ok(tracing.every(({ subsystem }) => /^codex_[a-z_]+(::[a-z_]+)*$/.test(subsystem)));
  // Plain startup banners stay text; Codex tracing keeps no identifying or path fields.
  assert.ok(
    codex.records.some(({ kind, message }) => kind === "text" && /listening on/.test(message)),
  );
  const body = JSON.stringify(tracing);
  for (const dropped of ["installation_id", "server_name", "remote_control_url", ".codex"]) {
    assert.equal(body.includes(dropped), false, `${dropped} reached a tracing record`);
  }
  // Plain-text lines are not field-filtered: the one Codex warning that names CODEX_HOME
  // stays as text. Only that line may carry the path.
  assert.deepEqual(
    codex.records
      .filter(({ kind, message }) => kind === "text" && message.includes(".codex"))
      .map(({ message }) => message.slice(0, 40)),
    ["WARNING: proceeding, even though we coul"],
  );
});

test("Codex model connection and network proxy diagnostics keep their text; payload formats stay withheld", async () => {
  const { fixtures } = await manifest();
  const byFile = Object.fromEntries(
    await Promise.all(fixtures.map(async (entry) => [entry.file, await replay(entry)])),
  );
  const summary = ({ records }) =>
    records.map(({ level, subsystem, message }) => [level, subsystem, message]);

  // Captured: a turn's first model connection on a dedicated Codex Agent.
  assert.deepEqual(summary(byFile["codex-model-connection.kubelet.txt"]), [
    ["info", "codex_network_proxy::certs", "generated process-local MITM CA"],
    [
      "warn",
      "codex_network_proxy::proxy",
      "allowUnixSockets and dangerouslyAllowAllUnixSockets are macOS-only; requests will be rejected on this platform",
    ],
    ["info", "codex_network_proxy::http_proxy", "HTTP proxy listening on 127.0.0.1:35963"],
    [
      "info",
      "codex_api::endpoint::responses_websocket",
      "connecting to websocket: ws://model-proxy.model-proxy.svc.cluster.local:8080/v1/responses",
    ],
    [
      "info",
      "codex_api::endpoint::responses_websocket",
      "successfully connected to websocket: ws://model-proxy.model-proxy.svc.cluster.local:8080/v1/responses",
    ],
  ]);

  // Upstream formats for a turn that cannot reach the model, then payload-carrying
  // formats from the same targets.
  const failures = byFile["codex-model-connection-failures.kubelet.txt"];
  const url = "wss://api.openai.com/v1/responses";
  const withheld = "Codex message withheld";
  assert.deepEqual(summary(failures), [
    ["info", "codex_network_proxy::socks5", "SOCKS5 proxy listening on 127.0.0.1:41871"],
    [
      "info",
      "codex_network_proxy::socks5",
      "SOCKS5 UDP and non-HTTPS SOCKS5 TCP are blocked in limited mode; HTTPS SOCKS5 TCP requires MITM inspection",
    ],
    ["warn", "codex_network_proxy::proxy", "network.enabled is false; skipping proxy listeners"],
    ["info", "codex_api::endpoint::responses_websocket", `connecting to websocket: ${url}`],
    [
      "error",
      "codex_api::endpoint::responses_websocket",
      `failed to connect to websocket: IO error: Connection refused (os error 111), url: ${url}`,
    ],
    [
      "error",
      "codex_api::endpoint::responses_websocket",
      `failed to connect to websocket: IO error: failed to lookup address information: Name or service not known, url: ${url}`,
    ],
    [
      "error",
      "codex_api::endpoint::responses_websocket",
      `failed to connect to websocket: HTTP error: 401 Unauthorized, url: ${url}`,
    ],
    ["warn", "codex_core::client", "falling back to HTTP"],
    [
      "warn",
      "codex_core::responses_retry",
      "stream disconnected - retrying sampling request (1/5 in 212ms)...",
    ],
    ["warn", "codex_core::responses_retry", "stream connection failed; waiting to retry"],
    ["debug", "codex_api::endpoint::responses_websocket", withheld],
    ["warn", "codex_network_proxy::http_proxy", withheld],
    ["warn", "codex_network_proxy::mitm", withheld],
    ["info", "codex_network_proxy::http_proxy", withheld],
    ["info", "codex_api::endpoint::responses_websocket", withheld],
    ["error", "codex_api::endpoint::responses_websocket", withheld],
  ]);
  const body = JSON.stringify(failures.records);
  for (const leaked of ["replay chat sentence", "replay-chat-sentence", "output_text"]) {
    assert.equal(body.includes(leaked), false, `${leaked} reached a record`);
  }
});

test("OpenShell decisions keep rule and engine; the pinned source never sends a policy generation", async () => {
  const { fixtures } = await manifest();
  const sandbox = await replay(fixtures.find(({ source }) => source === "sandbox"));
  assert.equal(sandbox.withheld, 0);
  const decisions = sandbox.records.filter(({ fields }) => fields?.action !== undefined);
  assert.ok(decisions.length >= 6);
  for (const record of decisions) {
    assert.equal(record.contentClass, "activity");
    assert.ok(record.fields.rule_name, record.message);
    assert.ok(record.fields.rule_type, record.message);
    // OpenShell 496ebba pushes OCSF lines with an empty field map and its shorthand has
    // no generation, so the console renders "unknown" (upstream ask U2).
    assert.equal(record.fields.policy_generation, undefined, record.message);
  }
  const denied = decisions.filter(({ fields }) => fields.action === "DENIED");
  assert.deepEqual(
    denied.map(({ level, fields }) => [level, fields.rule_name, fields.rule_type]),
    [
      ["warn", "-", "opa"],
      ["warn", "-", "ssrf"],
      ["warn", "github_api", "opa"],
      ["warn", "bypass-detect", "nftables"],
    ],
  );
  assert.equal(denied[0].fields.reason, "no matching policy");
  const gatewayOrigin = sandbox.records.find(({ fields }) => fields?.source === "gateway");
  assert.equal(gatewayOrigin.fields.activity, "CONFIG:LOADED");
});

test("real Kubernetes Events mask node, image and object names before they reach the status", async () => {
  const { fixtures } = await manifest();
  const { events } = await replay(fixtures.find(({ source }) => source === "events"));
  assert.ok(events.length >= 5);
  const body = JSON.stringify(events);
  assert.equal(
    body.includes("k3d-occ-dev-example-server-0"),
    false,
    "node name reached the status",
  );
  assert.equal(body.includes("0123456789abcdef"), false, "image digest reached the status");
  assert.ok(events.some(({ type, reason }) => type === "Warning" && reason === "Unhealthy"));
});
