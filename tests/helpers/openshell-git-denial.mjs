import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { openShellSandboxLogReader } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

/**
 * Require HTTP 403; never export Git's potentially sensitive error. Nonzero codes
 * describe observed error text, not its cause: 1 access succeeded, 2 unclassified,
 * 10 DNS, 11 connection, 12 TLS verification, 13 other HTTP, 14 timeout.
 */
export function gitHttp403Command(git) {
  return [
    "sh",
    "-ceu",
    "if error=$(LC_ALL=C " +
      git +
      ' 2>&1); then exit 1; fi; case "$error" in ' +
      '*"returned error: 403"*|*"response 403"*) exit 0 ;; ' +
      '*"Could not resolve host"*|*"Could not resolve proxy"*) exit 10 ;; ' +
      '*"Failed to connect"*|*"Could not connect to server"*) exit 11 ;; ' +
      '*"SSL certificate problem"*|*"server certificate verification failed"*) exit 12 ;; ' +
      '*"returned error: "*|*"HTTP code "*) exit 13 ;; ' +
      '*"Operation timed out"*|*"Connection timed out"*|*"Operation too slow"*) exit 14 ;; ' +
      "*) exit 2 ;; esac",
  ];
}

// Only stages assigned by this observer can reach the installed test's safe report.
// Preserve the original error for direct callers without exporting its message.
const failureStages = new WeakMap();

export function openShellGitDenialFailureStage(error) {
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

function fingerprint(line) {
  const { fields, ...metadata } = line;
  return createHash("sha256")
    .update(
      JSON.stringify([metadata, Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))]),
    )
    .digest("hex");
}

function eventTime(value) {
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
  return time;
}

function policyWarning(line) {
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
  return (ipv4 !== null && isIP(ipv4[1]) === 4) || (ipv6 !== null && isIP(ipv6[1]) === 6);
}

function appendedIndex(baseline, current) {
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

function stagedDenial(line) {
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
}) {
  assert.ok(executables.has(executable), "unsupported Git HTTPS executable");
  assert.ok(
    workspace && sandbox && sandboxId && supervisor.sandboxId === sandboxId,
    "Git denial requires the selected Sandbox identity",
  );
  const identity = structuredClone(supervisor);
  const reader = openShellSandboxLogReader(gatewayClient);
  const snapshots = new WeakMap();
  const message = `NET:OPEN [MED] DENIED ${executable}(0) -> github.com:443 [reason:${reason}]`;

  async function sameSupervisor() {
    signal.throwIfAborted();
    assert.ok(
      isDeepStrictEqual(await readSupervisor(), identity),
      "Git denial supervisor identity changed",
    );
  }

  async function read(timeoutMs) {
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, 5000))]);
    const { lines, bufferTotal } = await reader.getSandboxLogs(
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
    async snapshot() {
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

    async expectAfter(before, { startedAt, endedAt, markerHost, markerEndedAt }) {
      let stage = "input";
      try {
        assert.ok(snapshots.has(before), "Git denial requires its own baseline");
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
        const baseline = snapshots.get(before);
        let previous = [];
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
          let lastGitTime;
          // Examine every staged denial, including other executables and evaluator
          // errors. Interleaved warnings must not lend their reason to a Git OCSF
          // event. Only a trailing valid warning may await the next pushed batch.
          for (let index = appendedAt; index < lines.length; index += 1) {
            stage = "event-time";
            const warning = lines[index];
            if (warning.message === markerMessage) {
              const time = eventTime(warning.time);
              stage = "dns-marker";
              assert.ok(
                !observedMarker &&
                  warning.source === "sandbox" &&
                  warning.level === "OCSF" &&
                  warning.target === "ocsf" &&
                  time >= endedAt &&
                  time <= markerEndedAt &&
                  lastGitTime !== undefined &&
                  lastGitTime <= warning.time,
                "Git denial DNS marker is invalid or precedes its evidence",
              );
              observedMarker = true;
              continue;
            }
            if (!stagedDenial(warning)) {
              continue;
            }
            const warningTime = eventTime(warning.time);
            if (warningTime < startedAt || warningTime > endedAt) {
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
              warningTime <= time && time <= endedAt && warning.time <= line.time,
              "Git denial has competing or unpaired staged records",
            );
            count += 1;
            if (lastGitTime === undefined || lastGitTime < line.time) {
              lastGitTime = line.time;
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
