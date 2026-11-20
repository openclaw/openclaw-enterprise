import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import type {
  OpenShellSandboxLogLine,
  OpenShellSandboxLogReader,
  OpenShellSandboxLogsResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { projectOpenShellGitAclFailure } from "../../scripts/ci/openshell-git-retention.mjs";
import type { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";

/** Keep raw Git errors inside the workload and emit only the observed denial category. */
export function gitRemovalDenialCommand(
  git: string,
): [command: "sh", option: "-ceu", script: string] {
  return [
    "sh",
    "-ceu",
    "set +e; error=$(" +
      git +
      ' 2>&1); status=$?; set -e; test "$status" -ne 0; test "$status" -ne 126; test "$status" -ne 127; case "$error" in *"returned error: 403"*|*"response 403"*) printf signed ;; *) printf transport ;; esac',
  ];
}

export function gitRemovalDenialCategory(result: unknown): "signed" | "transport" {
  assert.ok(
    result !== null &&
      typeof result === "object" &&
      "stdout" in result &&
      Buffer.isBuffer(result.stdout),
    "Git denial command did not return stdout",
  );
  const category = result.stdout.toString("utf8");
  assert.ok(category === "signed" || category === "transport", "invalid Git denial category");
  return category;
}

// The observer also refuses malformed field values supplied directly in receipt tests.
// The real gRPC reader has already decoded these fields as strings.
interface ObservedLogLine extends Omit<OpenShellSandboxLogLine, "fields"> {
  readonly fields: Readonly<Record<string, unknown>>;
}

interface GitDenialOptions {
  readonly gatewayClient: {
    getSandboxLogs(
      ...args: Parameters<OpenShellSandboxLogReader["getSandboxLogs"]>
    ): Promise<
      Omit<OpenShellSandboxLogsResponse, "lines"> & { readonly lines: readonly ObservedLogLine[] }
    >;
  };
  readonly workspace: string;
  readonly sandbox: string;
  readonly sandboxId: string;
  readonly supervisor: unknown;
  readonly readSupervisor: () => Promise<unknown>;
  readonly executable: string;
  readonly signal: AbortSignal;
}

interface GitDenialInterval {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly markerHost: string;
  readonly markerEndedAt: number;
}

export type GitDenialFailureStage =
  | "input"
  | "supervisor-identity"
  | "log-read"
  | "log-history"
  | "event-time"
  | "dns-marker"
  | "policy-pair"
  | "evidence-wait"
  | "evidence-deadline";

// Only stages assigned by this observer can reach the installed test's safe report.
// Preserve the original error for direct callers without exporting its message.
const failureStages = new WeakMap<object, GitDenialFailureStage>();

export function openShellGitDenialFailureStage(error: unknown): GitDenialFailureStage | undefined {
  return error !== null && typeof error === "object" ? failureStages.get(error) : undefined;
}

const ringSize = 2000;
const reason = "transparent_tcp_policy_denied";
// These are the Git HTTPS helpers admitted by openshell-git-runtime.ts. Resolve
// the runtime's symlink before observation: its HTTP helper can own the socket.
const executables = new Set([
  "/usr/lib/git-core/git-remote-https",
  "/usr/lib/git-core/git-remote-http",
  "/usr/libexec/git-core/git-remote-https",
  "/usr/libexec/git-core/git-remote-http",
]);

function fingerprint(line: ObservedLogLine): string {
  const { fields, ...metadata } = line;
  return createHash("sha256")
    .update(
      JSON.stringify([metadata, Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))]),
    )
    .digest("hex");
}

function eventTime(value: string | null) {
  // The real gRPC adapter emits UTC with nine fractional digits. Reject date
  // normalization, but compare millisecond buckets so the final bucket survives.
  assert.ok(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(value),
    "Git denial has no canonical event time",
  );
  const time = Date.parse(value);
  assert.ok(
    Number.isSafeInteger(time) &&
      time >= 0 &&
      new Date(time).toISOString() === `${value.slice(0, 23)}Z`,
    "Git denial has an invalid event time",
  );
  return { milliseconds: time, timestamp: value };
}

function policyWarning(line: ObservedLogLine): boolean {
  if (
    line.source !== "sandbox" ||
    line.level !== "WARN" ||
    line.target !== "openshell_supervisor_network::proxy" ||
    line.message !== "Denied staged transparent connection" ||
    line.fields.reason !== "endpoint github.com:443 is not allowed by any policy"
  ) {
    return false;
  }
  const destination = line.fields.destination;
  if (typeof destination !== "string") {
    return false;
  }
  // Rust SocketAddr renders IPv4 bare and IPv6 bracketed. Do not accept a URL,
  // hostname, different port, or malformed address as the staged TCP destination.
  const ipv4 = /^([^:[\]]+):443$/.exec(destination);
  const ipv6 = /^\[([0-9a-fA-F:.]+)\]:443$/.exec(destination);
  return (
    (ipv4?.[1] !== undefined && isIP(ipv4[1]) === 4) ||
    (ipv6?.[1] !== undefined && isIP(ipv6[1]) === 6)
  );
}

function appendedIndex(baseline: readonly string[], current: readonly string[]): number {
  const anchor = baseline.at(-1);
  if (anchor === undefined) {
    assert.ok(current.length < ringSize, "Git denial lost its empty baseline");
    return 0;
  }
  const index = current.indexOf(anchor);
  assert.ok(
    index >= 0 && current.lastIndexOf(anchor) === index,
    "Git denial baseline anchor is missing or ambiguous",
  );
  const appendedAt = index + 1;
  const retained = baseline.slice(-appendedAt);
  assert.ok(
    appendedAt <= baseline.length &&
      (appendedAt === baseline.length || current.length === ringSize) &&
      retained.every((entry, i) => entry === current[i]),
    "Git denial log history changed",
  );
  return appendedAt;
}

function stagedDenial(line: ObservedLogLine): boolean {
  return (
    line.message === "Denied staged transparent connection" ||
    (line.message.startsWith("NET:OPEN ") && line.message.includes("[reason:transparent_tcp_"))
  );
}

/**
 * Observe stock supervisor evidence, not Git's transport error text. Stock
 * LogPushLayer sends OCSF as shorthand with an empty fields map; proxy.rs emits
 * its WARN immediately before OCSF without an await. Require that WARN's exact
 * endpoint-not-admitted reason: OCSF alone also covers evaluator errors. PID zero
 * is intentional and there is no Exec request ID. Join this observation with the
 * caller's unchanged execution identity and independent origin-I/O witness.
 */
export function createOpenShellGitDenial({
  gatewayClient,
  workspace,
  sandbox,
  sandboxId,
  supervisor,
  readSupervisor,
  executable,
  signal,
}: GitDenialOptions) {
  assert.ok(executables.has(executable), "unsupported Git HTTPS executable");
  assert.ok(
    workspace &&
      sandbox &&
      sandboxId &&
      supervisor !== null &&
      typeof supervisor === "object" &&
      "sandboxId" in supervisor &&
      supervisor.sandboxId === sandboxId,
    "Git denial requires the selected Sandbox identity",
  );
  const identity = structuredClone(supervisor);
  const getSandboxLogs = gatewayClient.getSandboxLogs.bind(gatewayClient);
  const snapshots = new WeakMap<object, readonly string[]>();
  const message = `NET:OPEN [MED] DENIED ${executable}(0) -> github.com:443 [reason:${reason}]`;

  async function sameSupervisor() {
    signal.throwIfAborted();
    assert.ok(
      isDeepStrictEqual(await readSupervisor(), identity),
      "Git denial supervisor identity changed",
    );
  }

  async function read(timeoutMs: number) {
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, 5000))]);
    const { lines, bufferTotal } = await getSandboxLogs(
      { workspace, sandbox, lines: ringSize },
      readSignal,
    );
    assert.ok(
      bufferTotal === lines.length && lines.length <= ringSize,
      "Git denial log ring is incomplete",
    );
    assert.ok(
      lines.every((line) => line.sandboxId === sandboxId),
      "Git denial log belongs to a different Sandbox",
    );
    return { lines, fingerprints: lines.map(fingerprint) };
  }

  return Object.freeze({
    async snapshot(): Promise<object> {
      await sameSupervisor();
      const { fingerprints } = await read(5000);
      const anchor = fingerprints.at(-1);
      assert.ok(
        anchor === undefined || fingerprints.indexOf(anchor) === fingerprints.length - 1,
        "Git denial baseline anchor is ambiguous",
      );
      await sameSupervisor();
      const snapshot = Object.freeze({});
      snapshots.set(snapshot, fingerprints);
      return snapshot;
    },

    async expectAfter(
      before: object,
      { startedAt, endedAt, markerHost, markerEndedAt }: GitDenialInterval,
    ) {
      let stage: GitDenialFailureStage = "input";
      try {
        const baseline = snapshots.get(before);
        assert.ok(baseline, "Git denial requires its own baseline");
        assert.ok(
          Number.isSafeInteger(startedAt) &&
            Number.isSafeInteger(endedAt) &&
            Number.isSafeInteger(markerEndedAt) &&
            startedAt >= 0 &&
            endedAt >= startedAt &&
            markerEndedAt >= endedAt,
          "Git denial requires a bounded attempt interval",
        );
        assert.ok(
          typeof markerHost === "string" &&
            /^git-retention-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.invalid$/.test(
              markerHost,
            ),
          "Git denial requires a unique DNS marker host",
        );
        const markerMessage = `NET:REFUSE [MED] DENIED ${markerHost} [reason:policy_dns_ineligible]`;
        let previous: readonly string[] = [];
        const deadline = performance.now() + 20_000;
        while (performance.now() < deadline) {
          stage = "supervisor-identity";
          await sameSupervisor();
          stage = "log-read";
          const { lines, fingerprints } = await read(
            Math.max(1, Math.ceil(deadline - performance.now())),
          );
          stage = "log-history";
          const appendedAt = appendedIndex(baseline, fingerprints);
          // While the original boundary remains retained, no later record can
          // roll out first. Compare the observed suffix at that same boundary;
          // a repeated pre-boundary record must never become a new tail anchor.
          const appended = fingerprints.slice(appendedAt);
          assert.ok(
            previous.every((entry, i) => entry === appended[i]),
            "Git denial log history changed",
          );
          previous = appended;
          let count = 0;
          let pending = false;
          let observedMarker = false;
          let lastGitTime: string | undefined;
          // Examine every staged denial, including other executables and evaluator
          // errors. Interleaved warnings must not lend their reason to a Git OCSF
          // event. Only a trailing valid warning may await the next pushed batch.
          for (let index = appendedAt; index < lines.length; index += 1) {
            stage = "event-time";
            const warning = lines[index];
            assert.ok(warning, "Git denial log ring contains a missing record");
            if (warning.message === markerMessage) {
              const time = eventTime(warning.time);
              stage = "dns-marker";
              assert.ok(
                !observedMarker &&
                  warning.source === "sandbox" &&
                  warning.level === "OCSF" &&
                  warning.target === "ocsf" &&
                  time.milliseconds >= endedAt &&
                  time.milliseconds <= markerEndedAt &&
                  lastGitTime !== undefined &&
                  lastGitTime <= time.timestamp,
                "Git denial DNS marker is invalid or precedes its evidence",
              );
              observedMarker = true;
              continue;
            }
            if (!stagedDenial(warning)) {
              continue;
            }
            const warningTime = eventTime(warning.time);
            if (warningTime.milliseconds < startedAt || warningTime.milliseconds > endedAt) {
              continue;
            }
            stage = "dns-marker";
            assert.ok(!observedMarker, "Git denial staged evidence follows its DNS marker");
            stage = "policy-pair";
            assert.ok(
              policyWarning(warning),
              "Git denial has competing or unpaired staged records",
            );
            const line = lines[index + 1];
            if (line === undefined) {
              pending = true;
              break;
            }
            assert.ok(
              line.source === "sandbox" &&
                line.level === "OCSF" &&
                line.target === "ocsf" &&
                line.message === message,
              "Git denial has competing or unpaired staged records",
            );
            stage = "event-time";
            const time = eventTime(line.time);
            stage = "policy-pair";
            assert.ok(
              warningTime.milliseconds <= time.milliseconds &&
                time.milliseconds <= endedAt &&
                warningTime.timestamp <= time.timestamp,
              "Git denial has competing or unpaired staged records",
            );
            count += 1;
            if (lastGitTime === undefined || lastGitTime < time.timestamp) {
              lastGitTime = time.timestamp;
            }
            index += 1;
          }
          stage = "supervisor-identity";
          await sameSupervisor();
          // A complete pair alone is not an end-of-stream receipt: a subsequent
          // batch may contain conflicting evidence from the same Git command.
          if (count > 0 && !pending && observedMarker) {
            return Object.freeze({
              count,
              reason,
              policyReason: "endpoint-not-admitted",
              marker: "policy-dns-ineligible",
              executable,
              host: "github.com",
              port: 443,
              startedAt,
              endedAt,
            });
          }
          stage = "evidence-wait";
          await setTimeout(Math.max(1, Math.min(400, deadline - performance.now())), undefined, {
            signal,
          });
        }
        stage = "evidence-deadline";
        assert.fail("fresh Git policy denial was not observable before the delivery deadline");
      } catch (error) {
        if (error !== null && typeof error === "object") {
          failureStages.set(error, stage);
        }
        throw error;
      }
    },
  });
}

type GitAclDenial =
  | { kind: "git" }
  | { kind: "rest" | "request-authority"; method: "GET" | "POST"; path: string; host: string };

type GitAclObservation =
  | GitAclDenial
  | { kind: "success" }
  | { kind: "variant"; method: "GET" | "HEAD" | "POST"; path: string; host: string };

type GitAclCredentialFingerprint = readonly [length: number, sha256: string];

interface GitAclVariant {
  readonly name: string;
  readonly repository: "fixture/a" | "fixture/c";
  readonly method: "GET" | "HEAD" | "POST";
  readonly target: string;
  readonly path: string;
  readonly service: "git-upload-pack" | "git-receive-pack";
  readonly body?: string;
  readonly expected: "rest-denial" | "head-denial" | "safe-read";
}

export function gitAclVariants(initialSha: string): readonly GitAclVariant[] {
  const upload = "git-upload-pack";
  const receive = "git-receive-pack";
  const discovery = (
    name: string,
    expected: GitAclVariant["expected"],
    {
      service = upload,
      method = "GET",
      repository = "fixture/a",
      wireRepository = repository + ".git",
      query = `service=${service}`,
    }: {
      service?: GitAclVariant["service"];
      method?: "GET" | "HEAD";
      repository?: GitAclVariant["repository"];
      wireRepository?: string;
      query?: string;
    } = {},
  ): GitAclVariant => ({
    name,
    expected,
    repository,
    method,
    service,
    path: `/${repository}.git/info/refs`,
    target: `/${wireRepository}/info/refs?${query}`,
  });
  const rpc = (
    name: string,
    repository: GitAclVariant["repository"],
    service: GitAclVariant["service"],
    target: string,
  ): GitAclVariant => ({
    name,
    repository,
    service,
    target,
    path: `/${repository}.git/${service}`,
    method: "POST",
    body: service === upload ? `0032want ${initialSha}\n00000009done\n` : "0000",
    expected: "rest-denial",
  });
  return [
    discovery("upload then receive", "rest-denial", {
      service: receive,
      query: `service=${upload}&service=${receive}`,
    }),
    discovery("receive then upload", "rest-denial", {
      query: `service=${receive}&service=${upload}`,
    }),
    discovery("encoded mixed service key", "rest-denial", {
      service: receive,
      query: `service=${upload}&%73ervice=${receive}`,
    }),
    discovery("identical upload values", "safe-read", {
      query: `service=${upload}&service=${upload}`,
    }),
    discovery("extra query parameter", "safe-read", { query: `service=${upload}&extra=1` }),
    discovery("case-sensitive extra key", "safe-read", {
      query: `service=${upload}&Service=${receive}`,
    }),
    discovery("encoded A upload discovery", "safe-read", {
      wireRepository: "fixture/%61.git",
      query: "%73ervice=git-%75pload-pack",
    }),
    discovery("HEAD A upload", "safe-read", { method: "HEAD" }),
    discovery("HEAD A receive", "head-denial", { method: "HEAD", service: receive }),
    discovery("HEAD encoded C upload", "head-denial", {
      method: "HEAD",
      repository: "fixture/c",
      wireRepository: "fixture/%63.git",
    }),
    discovery("normalized C upload discovery", "rest-denial", {
      repository: "fixture/c",
      wireRepository: "fixture/a.git/%2e%2e/%63.git",
    }),
    discovery("encoded C receive discovery", "rest-denial", {
      service: receive,
      repository: "fixture/c",
      wireRepository: "fixture/%63.git",
    }),
    rpc("A receive RPC with query", "fixture/a", receive, `/fixture/a.git/${receive}?anything=1`),
    rpc("encoded C upload RPC", "fixture/c", upload, `/fixture/%63.git/${upload}`),
    rpc("normalized C receive RPC", "fixture/c", receive, `/fixture/a.git/../%63.git/${receive}`),
  ];
}

type GitAclOrigin = Awaited<ReturnType<typeof startSkipperPrivateGitOrigin>>;

export async function calibrateGitAclVariant(
  origin: GitAclOrigin,
  index: number,
  probe: GitAclVariant,
) {
  const network = origin.network;
  assert.ok(network);
  const before = origin.snapshot().requests;
  const start = network.requests().length;
  const witness = await network.probeIssued(index, probe.repository, probe);
  assert.deepEqual(
    witness,
    {
      status: 200,
      type: `application/x-${probe.service}-${probe.method === "POST" ? "result" : "advertisement"}`,
    },
    probe.name,
  );
  assert.equal(origin.snapshot().requests - before, 1, probe.name);
  assertGitAclVariantOrigin(network.requests().slice(start), index, probe);
}

export function assertGitAclVariantOrigin(
  requests: ReturnType<NonNullable<GitAclOrigin["network"]>["requests"]>,
  index: number,
  probe: Pick<GitAclVariant, "name" | "repository" | "service" | "method">,
) {
  assert.deepEqual(
    requests,
    [
      {
        repository: probe.repository,
        operation: `${probe.service === "git-receive-pack" ? "receive" : "upload"}-${probe.method === "POST" ? "pack" : "advertise"}`,
        method: probe.method,
        authenticated: true,
        credentialIndex: index,
      },
    ],
    probe.name,
  );
}

export function assertGitAclVariantOutcome(
  probe: GitAclVariant,
  output: string,
  httpDelta: number,
  requests: Parameters<typeof assertGitAclVariantOrigin>[0],
  index: number,
) {
  if (output === "200 upload-advertisement\n" && probe.expected === "safe-read") {
    assert.equal(httpDelta, 1, probe.name);
    assertGitAclVariantOrigin(requests, index, probe);
    return "upload-advertisement";
  }
  assert.equal(httpDelta, 0, `${probe.name}: forbidden origin HTTP`);
  const decision = /^403 (native-rest-policy|git-request-authority|head-http)\n$/.exec(output)?.[1];
  if (probe.expected === "rest-denial") {
    assert.equal(decision, "native-rest-policy", probe.name);
  } else if (probe.expected === "head-denial" || probe.method === "HEAD") {
    assert.equal(decision, "head-http", probe.name);
  } else {
    assert.ok(
      decision === "native-rest-policy" || decision === "git-request-authority",
      probe.name,
    );
  }
  return decision;
}

export function gitAclVariantCurlArgs(probe: GitAclVariant) {
  return [
    "--path-as-is",
    ...(probe.method === "HEAD" ? ["--head"] : ["-X", probe.method]),
    ...(probe.body === undefined
      ? []
      : [
          "-H",
          `Content-Type: application/x-${probe.service}-request`,
          "--data-binary",
          probe.body,
        ]),
  ];
}

/** Expose only a complete, credential-free diagnostic from the contained client. */
export function describeGitAclFailure(stderr: Buffer): string | undefined {
  const output = stderr.toString("utf8");
  return output.endsWith("\n") ? projectOpenShellGitAclFailure(output.slice(0, -1)) : undefined;
}

/** Run the same bounded denial check in the installed guest and the local test. */
export function createGitAclDenialCommand(
  credential: string | readonly GitAclCredentialFingerprint[],
) {
  const verifyEnvironment = typeof credential !== "string";
  const fingerprints = verifyEnvironment
    ? credential
    : [credential, Buffer.from(`x-access-token:${credential}`).toString("base64")].map((value) => [
        Buffer.byteLength(value),
        createHash("sha256").update(value).digest("hex"),
      ]);
  // Node's TypeScript loader erases types. The guest needs only Node builtins.
  const script = `(${checkGitAclDenial.toString()})().catch(() => {
    process.stderr.write("ACL_DENIAL_CAPTURE\\n");
    process.exitCode = 1;
  });`;
  return (observation: GitAclObservation, [executable, ...args]: [string, ...string[]]) => [
    "node",
    "--eval",
    script,
    "--",
    JSON.stringify(fingerprints),
    String(verifyEnvironment),
    observation.kind,
    "method" in observation ? observation.method : "",
    "path" in observation ? observation.path : "",
    "host" in observation ? observation.host : "",
    executable,
    ...args,
  ];
}

async function checkGitAclDenial() {
  const { spawnSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const [encoded, verifyEnvironment, kind, method, path, host, executable, ...args] =
    process.argv.slice(1);
  const limit = 8192;
  const fail = (diagnostic: string) => {
    process.stderr.write(diagnostic + "\n");
    process.exitCode = 1;
  };
  const fingerprints: GitAclCredentialFingerprint[] = JSON.parse(encoded ?? "null");
  const rest = kind === "rest" || kind === "request-authority" || kind === "variant";
  if (
    !executable ||
    (!rest && kind !== "git" && kind !== "success") ||
    !Array.isArray(fingerprints) ||
    fingerprints.length < 2 ||
    fingerprints.some(
      ([length, hash]) =>
        !Number.isSafeInteger(length) || length <= 0 || !/^[a-f0-9]{64}$/.test(hash),
    )
  ) {
    return fail("ACL_DENIAL_CAPTURE");
  }
  const containsCredential = (stream: Buffer) => {
    for (const [size, hash] of fingerprints) {
      for (let offset = 0; offset + size <= stream.length; offset++) {
        if (
          createHash("sha256")
            .update(stream.subarray(offset, offset + size))
            .digest("hex") === hash
        ) {
          return true;
        }
      }
    }
    return false;
  };

  if (verifyEnvironment === "true") {
    if (
      !/^openshell:resolve:env:s[a-f0-9]{64}_GITHUB_TOKEN$/.test(process.env.GITHUB_TOKEN ?? "")
    ) {
      return fail("ACL_PLACEHOLDER_ENVIRONMENT");
    }
    for (const value of Object.values(process.env)) {
      if (value !== undefined && containsCredential(Buffer.from(value))) {
        return fail("ACL_CREDENTIAL_IN_ENVIRONMENT");
      }
    }
  }
  if (rest) {
    args.push(
      "-u",
      `x-access-token:${process.env.GITHUB_TOKEN}`,
      "--show-error",
      "--max-filesize",
      String(limit),
      "--write-out",
      "\n%{http_code} %{content_type}\n",
    );
  }
  const { stdout, stderr, status, error } = spawnSync(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: limit + 1,
  });
  if (error || status === null || !stdout || !stderr) {
    const exceededLimit = error !== undefined && "code" in error && error.code === "ENOBUFS";
    return fail(
      kind === "variant"
        ? exceededLimit
          ? "ACL_VARIANT_OUTPUT_LIMIT"
          : "ACL_VARIANT_PROCESS"
        : "ACL_DENIAL_CAPTURE",
    );
  }
  if (stdout.length + stderr.length > limit) {
    return fail(kind === "variant" ? "ACL_VARIANT_OUTPUT_LIMIT" : "ACL_DENIAL_CAPTURE");
  }

  // Scan complete bytes in both streams before interpreting a status or body.
  // Any contiguous match counts, including prefixes and extra JSON fields.
  if (containsCredential(stdout) || containsCredential(stderr)) {
    return fail("ACL_CREDENTIAL_IN_OUTPUT");
  }

  if (kind === "success") {
    if (status !== 0 || stderr.length !== 0) {
      return fail("ACL_ALLOWED_CAPTURE");
    }
    process.stdout.write(stdout);
    return;
  }
  if (kind === "git") {
    if (status === 0) {
      return fail("ACL_NATIVE_UNEXPECTED_SUCCESS");
    }
    if (!/^fatal: .*The requested URL returned error: 403$/m.test(stderr.toString("utf8"))) {
      return fail("ACL_NATIVE_HTTP");
    }
    process.stdout.write("403 native-git\n");
    return;
  }

  // A transport failure can leave a convincing status and body in stdout.
  if (status !== 0) {
    return fail(kind === "variant" ? "ACL_VARIANT_CURL_EXIT_" + status : "ACL_DENIAL_CAPTURE");
  }
  const response = stdout.toString("utf8");
  if (kind === "variant") {
    if (stderr.length !== 0) {
      return fail("ACL_VARIANT_STDERR");
    }
    if (
      (method === "GET" || method === "HEAD") &&
      response.endsWith("\n200 application/x-git-upload-pack-advertisement\n")
    ) {
      process.stdout.write("200 upload-advertisement\n");
      return;
    }
    if (method === "HEAD") {
      // A real HEAD response has no HTTP body to attribute to REST or middleware.
      if (!response.endsWith("\n403 application/json\n")) {
        return fail("ACL_HEAD_STATUS");
      }
      process.stdout.write("403 head-http\n");
      return;
    }
  }
  const diagnostic = kind === "rest" ? "ACL_NATIVE_REST_DENIAL" : "ACL_GIT_AUTHORITY_DENIAL";
  const footer = /\n403 application\/json\n$/.exec(response);
  if (!footer) {
    const status =
      kind === "variant" ? /\n([1-5][0-9]{2}) [^\r\n]*\n$/.exec(response)?.[1] : undefined;
    return fail(status === undefined ? diagnostic : "ACL_VARIANT_HTTP_" + status);
  }
  const body = JSON.parse(response.slice(0, footer.index));
  if (
    body?.layer !== "l7" ||
    body.method !== method ||
    body.path !== path ||
    body.host !== host ||
    body.port !== 443
  ) {
    return fail(diagnostic);
  }
  if (kind === "request-authority" || (kind === "variant" && body.error === "middleware_denied")) {
    if (
      body.error !== "middleware_denied" ||
      body.middleware !== "oce-prepared-git" ||
      body.reason_code !== "request_not_allowed"
    ) {
      return fail(diagnostic);
    }
    process.stdout.write("403 git-request-authority\n");
    return;
  }
  if (
    body.error !== "policy_denied" ||
    body.protocol !== "rest" ||
    body.rule_missing?.type !== "rest_allow" ||
    body.rule_missing.layer !== "l7" ||
    body.rule_missing.method !== method ||
    body.rule_missing.path !== path
  ) {
    return fail(diagnostic);
  }
  process.stdout.write("403 native-rest-policy\n");
}
