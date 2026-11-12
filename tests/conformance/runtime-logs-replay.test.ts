import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { openShellLogDecisions } from "../../apps/controller/src/drivers/sandbox/openshell-log-decisions.ts";
import {
  validSandboxPolicyDecision,
  type RuntimeLogRecord,
  type SandboxLogLine,
} from "../../packages/contracts/src/index.ts";
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

type FixtureBase = {
  file: string;
  golden: string;
  provenance: string;
  origin: string;
  scrubbed: string;
};
type ContainerFixture = FixtureBase & { replay: "kubelet-container"; source: "gateway" | "agent" };
type SandboxFixture = FixtureBase & {
  replay: "openshell-sandbox";
  source: "sandbox";
  lines?: (lines: SandboxLogLine[]) => SandboxLogLine[];
};
type EventFixture = FixtureBase & { replay: "kubernetes-events"; source: "events" };
type Fixture = ContainerFixture | SandboxFixture | EventFixture;
type LogReplay = { input: number } & Pick<
  ReturnType<typeof sanitizeRuntimeLogChunk>,
  "records" | "withheld"
>;
type EventReplay = {
  input: number;
  events: ReturnType<typeof validRuntimeDescription>["pods"][number]["events"];
};

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function fixture(value: unknown): Fixture {
  const item = object(value);
  const base = {
    file: string(item.file),
    golden: string(item.golden),
    provenance: string(item.provenance),
    origin: string(item.origin),
    scrubbed: string(item.scrubbed),
  };
  if (item.replay === "kubelet-container") {
    assert.ok(item.source === "gateway" || item.source === "agent");
    return { ...base, replay: item.replay, source: item.source };
  }
  if (item.replay === "openshell-sandbox") {
    assert.equal(item.source, "sandbox");
    return { ...base, replay: item.replay, source: item.source };
  }
  if (item.replay !== "kubernetes-events") {
    throw new Error(`unknown replay ${String(item.replay)}`);
  }
  assert.equal(item.source, "events");
  return { ...base, replay: item.replay, source: item.source };
}

async function manifest() {
  const parsed = object(JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")));
  assert.equal(typeof parsed.count, "number");
  return { count: parsed.count, fixtures: array(parsed.fixtures).map(fixture) };
}

function findFixture<T extends Fixture["replay"]>(
  fixtures: Fixture[],
  replay: T,
  predicate: (entry: Fixture) => boolean,
): Extract<Fixture, { replay: T }> {
  const entry = fixtures.find(
    (candidate): candidate is Extract<Fixture, { replay: T }> =>
      candidate.replay === replay && predicate(candidate),
  );
  assert.ok(entry);
  return entry;
}

function assertSandboxLine(value: unknown): asserts value is SandboxLogLine {
  const item = object(value);
  assert.ok(item.time === null || typeof item.time === "string");
  for (const key of ["sandboxId", "level", "target", "message", "source"]) {
    string(item[key]);
  }
  for (const field of Object.values(object(item.fields))) {
    string(field);
  }
  assert.ok(item.decision === undefined || validSandboxPolicyDecision(item.decision));
}

function isLogLine<T extends RuntimeLogRecord>(record: T): record is Extract<T, { type: "line" }> {
  return record.type === "line";
}

function logLine(record: RuntimeLogRecord): Extract<RuntimeLogRecord, { type: "line" }> {
  assert.ok(isLogLine(record));
  return record;
}

function logs(result: LogReplay | EventReplay | undefined): LogReplay {
  assert.ok(result && "records" in result);
  return result;
}

function kubeletLines(text: string) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line) => {
    const match = KUBELET_LINE.exec(line);
    return match === null
      ? { time: null, raw: line }
      : { time: string(match[1]), raw: string(match[2]) };
  });
}

// A simplified copy of the Kubernetes Compute Driver's private Event projection
// (`runtimePodEvents`): this Pod's Events only, newest first, count from the series when
// present, container from `involvedObject.fieldPath`. It omits the driver's Namespace check, safe-integer guard and Event cap, and
// it is not the product code, so this replay only exercises `validRuntimeDescription`
// (the node, image and object masking); it proves nothing about the driver's filter.
function driverEvents(items: Record<string, unknown>[], podUid: string) {
  const time = (value: unknown) =>
    typeof value === "string" ? new Date(value).toISOString() : null;
  return items
    .map((event) => ({
      event,
      involvedObject: event.involvedObject == null ? {} : object(event.involvedObject),
      series: event.series == null ? undefined : object(event.series),
    }))
    .filter(
      ({ event, involvedObject }) =>
        involvedObject.uid === podUid &&
        involvedObject.kind === "Pod" &&
        (event.type === "Normal" || event.type === "Warning"),
    )
    .map(({ event, involvedObject, series }) => {
      const count = series?.count ?? event.count ?? 1;
      assert.ok(typeof count === "number");
      return {
        type: event.type,
        container:
          /^spec\.(?:containers|initContainers|ephemeralContainers)\{([a-z0-9-]+)\}$/.exec(
            string(involvedObject.fieldPath ?? ""),
          )?.[1] ?? null,
        reason: event.reason || "Unknown",
        message: typeof event.message === "string" ? event.message : "",
        count: Math.max(1, count),
        lastObservedAt:
          time(series?.lastObservedTime) ??
          time(event.lastTimestamp) ??
          time(event.eventTime) ??
          time(event.firstTimestamp),
      };
    })
    .sort((left, right) => (right.lastObservedAt ?? "").localeCompare(left.lastObservedAt ?? ""));
}

function replay(entry: ContainerFixture | SandboxFixture): Promise<LogReplay>;
function replay(entry: EventFixture): Promise<EventReplay>;
function replay(entry: Fixture): Promise<LogReplay | EventReplay>;
async function replay(entry: Fixture): Promise<LogReplay | EventReplay> {
  const replayKind = entry.replay;
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
    const chunk = object(JSON.parse(text));
    const captured = array(chunk.lines).map((line) => {
      assertSandboxLine(line);
      return line;
    });
    const lines = entry.lines === undefined ? captured : entry.lines(captured);
    const { records, withheld } = sanitizeSandboxLogLines(
      { source: "sandbox", sandbox: string(chunk.sandbox) },
      openShellLogDecisions(lines),
    );
    return { input: lines.length, withheld, records };
  }
  if (entry.replay === "kubernetes-events") {
    const items = array(object(JSON.parse(text)).items).map(object);
    const pod = items.find((event) => object(event.involvedObject).kind === "Pod");
    assert.ok(pod);
    const podUid = string(object(pod.involvedObject).uid);
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
    const podDescription = description.pods[0];
    assert.ok(podDescription);
    return { input: items.length, events: podDescription.events };
  }
  throw new Error(`unknown replay ${replayKind}`);
}

function serialize(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("runtime descriptions reject invalid Driver timestamps instead of normalizing them", () => {
  assert.throws(
    () =>
      validRuntimeDescription(
        {
          revisionId: "rev_fixture",
          observedAt: "2026-02-30",
          pods: [],
          sources: [],
        },
        "rev_fixture",
      ),
    { name: "InvalidRuntimeDescriptionError" },
  );
});

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
  const sources = new Set<string>(fixtures.map(({ source }) => source));
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
      const input = object(JSON.parse(expected)).input;
      assert.ok(typeof input === "number" && input > 0, `${entry.golden} replays no input`);
      assert.equal(actual, expected, `${entry.file} drifted from ${entry.golden}`);
    });
  }
});

test("real Gateway, wrapper and Codex output is classified, not withheld", async () => {
  const { fixtures } = await manifest();
  const byFile = new Map(
    await Promise.all(fixtures.map(async (entry) => [entry.file, await replay(entry)] as const)),
  );

  const wrapper = logs(byFile.get("gateway-wrapper-probe-failed.kubelet.txt"));
  assert.deepEqual(
    wrapper.records.map(logLine).map(({ kind, level, message }) => [kind, level, message]),
    [
      ["wrapper", "error", "openclaw.model_probe"],
      ["wrapper", "error", "runtime.startup_phase"],
      ["wrapper", "error", "Harness model authentication probe failed."],
    ],
  );
  const firstWrapper = wrapper.records[0];
  assert.ok(firstWrapper);
  assert.equal(logLine(firstWrapper).fields?.code, "AUTHENTICATION_FAILED");

  const gateway = logs(byFile.get("gateway-console-startup.kubelet.txt"));
  assert.equal(gateway.withheld, 0);
  assert.equal(gateway.records.length, gateway.input);
  const gatewayLines = gateway.records.map(logLine);
  assert.ok(gatewayLines.every(({ kind, time }) => kind === "openclaw" && time !== null));
  assert.ok(gatewayLines.some(({ level }) => level === "warn"));
  assert.ok(gatewayLines.some(({ subsystem }) => subsystem === "gateway/heartbeat"));
  // Keys outside the operational allowlist (`intervalMs`, `providers`, `generatedAt`) drop.
  assert.ok(gatewayLines.every(({ fields }) => fields === undefined));

  // The Harness prints its node setup result as pretty-printed JSON; the whole value is
  // one withheld run, and the wrapper events after it are still classified.
  const harness = logs(byFile.get("agent-harness-startup.kubelet.txt"));
  assert.deepEqual(
    harness.records
      .slice(0, 2)
      .map((record) => [
        record.type,
        record.type === "line" ? record.message : record.reason,
        record.type === "withheld" ? record.count : undefined,
      ]),
    [
      ["withheld", "malformed", 7],
      ["line", "runtime.startup_phase", undefined],
    ],
  );
  assert.equal(JSON.stringify(harness.records).includes("configPath"), false);
  assert.ok(
    harness.records.some(
      (record) => record.type === "line" && record.message === "codex.model_probe",
    ),
  );

  const codex = logs(byFile.get("codex-app-server-startup.kubelet.txt"));
  assert.equal(codex.withheld, 0);
  const codexLines = codex.records.filter(isLogLine);
  const tracing = codexLines.filter(({ kind }) => kind === "codex");
  assert.ok(tracing.length > 20);
  assert.ok(
    tracing.every(
      ({ subsystem }) =>
        typeof subsystem === "string" && /^codex_[a-z_]+(::[a-z_]+)*$/.test(subsystem),
    ),
  );
  // Plain startup banners stay text; Codex tracing keeps no identifying or path fields.
  assert.ok(
    codexLines.some(({ kind, message }) => kind === "text" && /listening on/.test(message)),
  );
  const body = JSON.stringify(tracing);
  for (const dropped of ["installation_id", "server_name", "remote_control_url", ".codex"]) {
    assert.equal(body.includes(dropped), false, `${dropped} reached a tracing record`);
  }
  // Plain-text lines are not field-filtered: the one Codex warning that names CODEX_HOME
  // stays as text. Only that line may carry the path.
  assert.deepEqual(
    codexLines
      .filter(({ kind, message }) => kind === "text" && message.includes(".codex"))
      .map(({ message }) => message.slice(0, 40)),
    ["WARNING: proceeding, even though we coul"],
  );
});

test("Codex model connection and network proxy diagnostics keep their text; payload formats stay withheld", async () => {
  const { fixtures } = await manifest();
  const byFile = new Map(
    await Promise.all(fixtures.map(async (entry) => [entry.file, await replay(entry)] as const)),
  );
  const summary = ({ records }: LogReplay) =>
    records.map(logLine).map(({ level, subsystem, message }) => [level, subsystem, message]);

  // Captured: a turn's first model connection on a dedicated Codex Agent.
  assert.deepEqual(summary(logs(byFile.get("codex-model-connection.kubelet.txt"))), [
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
  const failures = logs(byFile.get("codex-model-connection-failures.kubelet.txt"));
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
  const sandbox = await replay(
    findFixture(fixtures, "openshell-sandbox", ({ source }) => source === "sandbox"),
  );
  assert.equal(sandbox.withheld, 0);
  const decisions = sandbox.records
    .filter(isLogLine)
    .filter(({ fields }) => fields?.action !== undefined);
  assert.ok(decisions.length >= 6);
  for (const record of decisions) {
    assert.equal(record.contentClass, "activity");
    assert.ok(record.fields?.rule_name, record.message);
    assert.ok(record.fields?.rule_type, record.message);
    // OpenShell 496ebba pushes OCSF lines with an empty field map and its shorthand has
    // no generation, so the console renders "unknown" (upstream ask U2).
    assert.equal(record.fields?.policy_generation, undefined, record.message);
  }
  const denied = decisions.filter(({ fields }) => fields?.action === "DENIED");
  assert.deepEqual(
    denied.map(({ level, fields }) => [level, fields?.rule_name, fields?.rule_type]),
    [
      ["warn", "-", "opa"],
      ["warn", "-", "ssrf"],
      ["warn", "github_api", "opa"],
      ["warn", "bypass-detect", "nftables"],
    ],
  );
  assert.equal(denied[0]?.fields?.reason, "no matching policy");
  const gatewayOrigin = sandbox.records
    .filter(isLogLine)
    .find(({ fields }) => fields?.source === "gateway");
  assert.equal(gatewayOrigin?.fields?.activity, "CONFIG:LOADED");
});

test("OpenShell placeholder addresses resolve to the host its policy DNS mapped, never to the address", async () => {
  // D771 (dogfood-r52, OpenShell 0.1.5): a second port of a host with a rule is denied with
  // the placeholder address that host's lookup was answered with. The `Policy DNS mapped` record
  // just before it names the host; after an apply the host moves to a new address.
  const { fixtures } = await manifest();
  const sandbox = await replay(
    findFixture(
      fixtures,
      "openshell-sandbox",
      ({ file }) => file === "sandbox-openshell-placeholder-denials.json",
    ),
  );
  assert.equal(sandbox.withheld, 0);
  const denied = sandbox.records
    .filter(isLogLine)
    .filter(({ decision }) => decision?.decision === "denied");
  assert.deepEqual(
    denied.map(({ decision, fields }) => [
      decision?.binary ?? null,
      decision?.host ?? null,
      decision?.port ?? null,
      fields?.dst_host ?? null,
      fields?.dst_placeholder_ip ?? null,
    ]),
    [
      [
        "/usr/bin/python3.11",
        "fake-model.oce-r52-fake.svc.cluster.local",
        8083,
        null,
        "198.18.0.2",
      ],
      [
        "/usr/bin/python3.11",
        "fake-model.oce-r52-fake.svc.cluster.local",
        8084,
        null,
        "198.18.0.2",
      ],
      [
        "/usr/bin/python3.11",
        "fake-model.oce-r52-fake.svc.cluster.local",
        8084,
        null,
        "198.18.0.6",
      ],
      [
        "/usr/bin/python3.11",
        "kubernetes.default.svc.cluster.local",
        443,
        "kubernetes.default.svc.cluster.local",
        null,
      ],
      // D772: a DNS refusal names the query; it knows no executable and no port.
      [null, "example.com", null, "example.com", null],
      ["/usr/bin/curl", "example.com", 443, "example.com", null],
    ],
  );
  // The same denial read without its mapping record names no host, so nothing can propose
  // the placeholder as a destination.
  const lone = await replay({
    ...findFixture(
      fixtures,
      "openshell-sandbox",
      ({ file }) => file === "sandbox-openshell-placeholder-denials.json",
    ),
    lines: (lines) => lines.filter(({ message }) => !message.startsWith("CONFIG:")),
  });
  const unmapped = lone.records
    .filter(isLogLine)
    .filter(({ fields }) => fields?.dst_placeholder_ip !== undefined);
  assert.equal(unmapped.length, 3);
  for (const record of unmapped) {
    assert.ok(record.decision, record.message);
    assert.ok(record.fields, record.message);
    assert.equal(record.decision.host, undefined, record.message);
    assert.equal(record.fields.dst_host, undefined, record.message);
  }
});

test("an IPv6 placeholder keeps its port apart and resolves through its mapping record", () => {
  // OpenShell writes an IPv6 destination bare, so the port is the last `:<digits>`.
  const line = (time: string, message: string): SandboxLogLine => ({
    time,
    sandboxId: "",
    level: "OCSF",
    target: "ocsf",
    message,
    source: "sandbox",
    fields: {},
  });
  const [, denied, real] = openShellLogDecisions([
    line(
      "2026-10-26T20:43:13.940000000Z",
      "CONFIG:PUBLISHED [INFO] Policy DNS mapped db.example.com resolved=2001:db8::5 synthetic=fd23:6f70:656e::5 ports=5432 mapping_id=35efb49a-76c2-46b0-ae12-e68bd01add6d",
    ),
    line(
      "2026-10-26T20:43:13.953000000Z",
      "NET:OPEN [MED] DENIED /usr/bin/psql(7) -> fd23:6f70:656e::5:6432 [reason:transparent_tcp_mapping_denied]",
    ),
    line(
      "2026-10-26T20:43:14.000000000Z",
      "NET:OPEN [MED] DENIED /usr/bin/psql(7) -> 2001:db8::9:443 [reason:transparent_tcp_policy_denied]",
    ),
  ]);
  assert.deepEqual(
    [denied?.fields.dst_placeholder_ip, denied?.fields.dst_port, denied?.decision?.host],
    ["fd23:6f70:656e::5", "6432", "db.example.com"],
  );
  assert.deepEqual([real?.fields.dst_host, real?.decision?.port], ["2001:db8::9", 443]);
});

test("a placeholder address takes its latest mapping and never a placeholder-shaped name", async () => {
  // Synthetic lines in OpenShell's real record format, replayed through the Driver parser and
  // the sanitizer, so the decision below is what the API and CLI return.
  const { fixtures } = await manifest();
  const ocsf = (time: string, message: string): SandboxLogLine => ({
    time,
    sandboxId: "3f2b8c1e-5d4a-4b6f-9e21-7a0c9d8e6f54",
    level: "OCSF",
    target: "ocsf",
    message,
    source: "sandbox",
    fields: {},
  });
  const denied = (time: string, address: string) =>
    ocsf(
      time,
      `NET:OPEN [MED] DENIED /usr/bin/curl(0) -> ${address}:443 [reason:transparent_tcp_policy_denied]`,
    );
  const { records } = await replay({
    ...findFixture(
      fixtures,
      "openshell-sandbox",
      ({ file }) => file === "sandbox-openshell-placeholder-denials.json",
    ),
    lines: () => [
      ocsf(
        "2026-10-26T20:50:00.000000000Z",
        "CONFIG:PUBLISHED [INFO] Policy DNS mapped old.example.com resolved=192.0.2.10 synthetic=198.18.0.10 ports=443 mapping_id=0d6f6a52-0b8e-4a55-9a3b-4c1f1f0e2a10",
      ),
      // A remap: the latest record for an address names its host, not the first.
      ocsf(
        "2026-10-26T20:50:01.000000000Z",
        "CONFIG:PUBLISHED [INFO] Policy DNS mapped new.example.com resolved=192.0.2.11 synthetic=198.18.0.10 ports=443 mapping_id=6b0f2c4e-8d1a-4f3e-b5a7-2e9c8d7f6a11",
      ),
      denied("2026-10-26T20:50:01.100000000Z", "198.18.0.10"),
      // A workload looked up `198.18.0.5.`: policy DNS stages that name like any other, but a
      // placeholder is no destination, so the denial must name no host (and no rule proposal).
      ocsf(
        "2026-10-26T20:50:02.000000000Z",
        "CONFIG:OBSERVATION [INFO] Policy DNS staged unapproved name 198.18.0.5 synthetic=198.18.0.12 for TCP policy review",
      ),
      denied("2026-10-26T20:50:02.100000000Z", "198.18.0.12"),
      // The same with the presentation trailing dot, after a real host held the address.
      ocsf(
        "2026-10-26T20:50:03.000000000Z",
        "CONFIG:PUBLISHED [INFO] Policy DNS mapped db.example.com resolved=192.0.2.12 synthetic=198.18.0.14 ports=443 mapping_id=9a3e1c7b-2f4d-4e8a-8c6b-1d0e5f4a3b14",
      ),
      ocsf(
        "2026-10-26T20:50:03.500000000Z",
        "CONFIG:PUBLISHED [INFO] Policy DNS mapped 198.18.0.6. resolved=192.0.2.13 synthetic=198.18.0.14 ports=443 mapping_id=4c2b8e6d-1a3f-4b7c-9d5e-0f8a6b4c2d15",
      ),
      denied("2026-10-26T20:50:03.600000000Z", "198.18.0.14"),
    ],
  });
  assert.deepEqual(
    records
      .filter(isLogLine)
      .filter(({ decision }) => decision?.decision === "denied")
      .map(({ decision, fields }) => [fields?.dst_placeholder_ip, decision?.host ?? null]),
    [
      ["198.18.0.10", "new.example.com"],
      ["198.18.0.12", null],
      ["198.18.0.14", null],
    ],
  );
});

test("real Kubernetes Events mask node, image and object names before they reach the status", async () => {
  const { fixtures } = await manifest();
  const { events } = await replay(
    findFixture(fixtures, "kubernetes-events", ({ source }) => source === "events"),
  );
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
