import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as gitDenial from "../helpers/openshell-git-denial.mjs";

import { selfSigned } from "../helpers/certificates.mjs";

const { createOpenShellGitDenial, gitHttp403Command } = gitDenial;

// The installed test may retain only this owner-assigned stage, never raw errors.
function refusalAt(stage, message) {
  return (error) => {
    assert.match(error.message, message);
    assert.equal(gitDenial.openShellGitDenialFailureStage?.(error), stage);
    return true;
  };
}

const executable = "/usr/lib/git-core/git-remote-http";
const startedAt = Date.parse("2026-11-05T12:00:00.000Z");
const endedAt = startedAt + 2;
const markerHost = "git-retention-11111111-1111-4111-8111-111111111111.invalid";
const markerEndedAt = endedAt + 2;
const interval = { startedAt, endedAt, markerHost, markerEndedAt };
const denial = {
  sandboxId: "sandbox-one",
  source: "sandbox",
  level: "OCSF",
  target: "ocsf",
  time: "2026-11-05T12:00:00.002999999Z",
  message: `NET:OPEN [MED] DENIED ${executable}(0) -> github.com:443 [reason:transparent_tcp_policy_denied]`,
  fields: {},
};
const warning = {
  ...denial,
  level: "WARN",
  target: "openshell_supervisor_network::proxy",
  time: "2026-11-05T12:00:00.001000000Z",
  message: "Denied staged transparent connection",
  fields: {
    reason: "endpoint github.com:443 is not allowed by any policy",
    destination: "198.18.0.1:443",
  },
};
const marker = {
  ...denial,
  time: "2026-11-05T12:00:00.003000000Z",
  message: `NET:REFUSE [MED] DENIED ${markerHost} [reason:policy_dns_ineligible]`,
};
const line = (index) => ({ ...denial, message: `unrelated event ${index}` });

// This transport supplies log records to the evidence reader. It tests receipt
// attribution and refusal only; it does not simulate or prove network enforcement.
function fixture(initial, signal = new AbortController().signal) {
  const supervisor = {
    sandboxId: "sandbox-one",
    supervisorPodUid: "supervisor-one",
    containerId: "container-one",
  };
  let identity = supervisor;
  let current = initial;
  let total;
  let afterRead = () => {};
  const observer = createOpenShellGitDenial({
    gatewayClient: {
      async getSandboxLogs(request) {
        assert.deepEqual(request, {
          workspace: "workspace-one",
          sandbox: "sandbox-name",
          lines: 2000,
        });
        afterRead();
        return { lines: current, bufferTotal: total ?? current.length };
      },
    },
    workspace: "workspace-one",
    sandbox: "sandbox-name",
    sandboxId: "sandbox-one",
    supervisor,
    readSupervisor: async () => identity,
    executable,
    signal,
  });
  return {
    observer,
    set(lines, bufferTotal) {
      current = lines;
      total = bufferTotal;
    },
    replaceSupervisor() {
      identity = { ...supervisor, containerId: "replacement" };
    },
    afterRead(callback) {
      afterRead = callback;
    },
  };
}

test("Git denial receipt requires fresh evidence and retains the final millisecond bucket", async () => {
  const baseline = [warning, denial, line(1)];
  const f = fixture(baseline);
  const before = await f.observer.snapshot();
  assert.deepEqual(before, {});
  f.set([...baseline, warning, denial, marker]);
  assert.deepEqual(await f.observer.expectAfter(before, interval), {
    count: 1,
    reason: "transparent_tcp_policy_denied",
    policyReason: "endpoint-not-admitted",
    marker: "policy-dns-ineligible",
    executable,
    host: "github.com",
    port: 443,
    startedAt,
    endedAt,
  });
  f.set([
    ...baseline,
    { ...warning, fields: { ...warning.fields, destination: "[fd23:6f70:656e::1]:443" } },
    denial,
    { ...marker, time: "2026-11-05T12:00:00.004999999Z" },
  ]);
  assert.equal((await f.observer.expectAfter(before, interval)).count, 1);

  // A valid trailing warning may arrive before its OCSF record. Do not accept
  // the first complete pair until every observed staged denial is paired.
  const split = fixture([line(1)]);
  const splitBefore = await split.observer.snapshot();
  let reads = 0;
  split.afterRead(() => {
    reads += 1;
    split.set(
      reads === 1
        ? [line(1), warning, denial, warning]
        : [line(1), warning, denial, warning, denial, marker],
    );
  });
  assert.equal((await split.observer.expectAfter(splitBefore, interval)).count, 2);
  assert.equal(reads, 2);
});

test(
  "Git denial receipt requires the adjacent endpoint-not-admitted warning",
  { timeout: 5000 },
  async () => {
    // A complete first batch must not hide a later evaluator-error batch from
    // the same command. The scoped DNS marker closes the observation window.
    const late = fixture([line(1)]);
    const lateBefore = await late.observer.snapshot();
    let lateReads = 0;
    late.afterRead(() => {
      lateReads += 1;
      late.set(
        lateReads === 1
          ? [line(1), warning, denial]
          : [
              line(1),
              warning,
              denial,
              {
                ...warning,
                fields: { ...warning.fields, reason: "policy evaluation failed: runtime error" },
              },
              denial,
              marker,
            ],
      );
    });
    await assert.rejects(
      late.observer.expectAfter(lateBefore, interval),
      refusalAt("policy-pair", /competing or unpaired/),
    );
    // Two concurrent denials must not lend each other their warning reason.
    const interleaved = fixture([line(1)]);
    const interleavedBefore = await interleaved.observer.snapshot();
    interleaved.set([
      line(1),
      {
        ...warning,
        fields: { ...warning.fields, reason: "policy evaluation failed: runtime error" },
      },
      warning,
      denial,
      { ...denial, message: denial.message.replace(executable, "/usr/bin/curl") },
    ]);
    await assert.rejects(
      interleaved.observer.expectAfter(interleavedBefore, interval),
      /competing or unpaired/,
    );
    const alteredWarnings = [
      { source: "gateway" },
      { level: "INFO" },
      { target: "other" },
      { message: "different warning" },
      { fields: { ...warning.fields, reason: "policy evaluation failed: runtime error" } },
      { fields: { ...warning.fields, destination: "198.18.0.1:80" } },
      { fields: { ...warning.fields, destination: "github.com:443" } },
      { fields: { ...warning.fields, destination: "999.18.0.1:443" } },
      { fields: { ...warning.fields, destination: "[invalid]:443" } },
      { fields: { ...warning.fields, destination: 443 } },
      { time: "2026-11-05T11:59:59.999999999Z" },
      { time: "2026-11-05T12:00:00.003000000Z" },
    ];
    const sequences = [
      [denial],
      [denial, warning],
      [warning, line("intervening"), denial],
      ...alteredWarnings.map((change) => [{ ...warning, ...change }, denial]),
      // Within one millisecond bucket, the OCSF record still cannot precede WARN.
      [
        { ...warning, time: "2026-11-05T12:00:00.002999999Z" },
        { ...denial, time: "2026-11-05T12:00:00.002000000Z" },
      ],
    ];
    for (const sequence of sequences) {
      const f = fixture([line(1)]);
      const before = await f.observer.snapshot();
      f.set([line(1), ...sequence]);
      await assert.rejects(f.observer.expectAfter(before, interval), /competing or unpaired/);
    }
    // A fresh OCSF line cannot borrow its warning from the pre-attempt baseline.
    const f = fixture([line(1), warning]);
    const before = await f.observer.snapshot();
    f.set([line(1), warning, denial]);
    await assert.rejects(f.observer.expectAfter(before, interval), /competing or unpaired/);
  },
);

test(
  "Git denial receipt refuses stale and differently attributed log records",
  { timeout: 5000 },
  async () => {
    const mismatches = [
      { source: "gateway" },
      { level: "INFO" },
      { target: "other" },
      { message: denial.message.replace(executable, "/usr/bin/curl") },
      { message: denial.message.replace("github.com", "other.invalid") },
      { message: denial.message.replace("policy_denied", "identity_unavailable") },
      { message: denial.message.replace("(0)", "(123)") },
      { time: "2026-11-05T11:59:59.999999999Z" },
      { time: "2026-11-05T12:00:00.003000000Z" },
    ];
    for (const mismatch of mismatches) {
      const baseline = [warning, denial, line(1)];
      const f = fixture(baseline);
      const before = await f.observer.snapshot();
      f.set([...baseline, warning, { ...denial, ...mismatch }]);
      await assert.rejects(f.observer.expectAfter(before, interval), /competing or unpaired/);
    }
    const stale = fixture([warning, denial, line(1)], AbortSignal.timeout(100));
    const before = await stale.observer.snapshot();
    await assert.rejects(stale.observer.expectAfter(before, interval), { name: "AbortError" });

    // A missing or different DNS marker cannot close the attempt, even when a
    // complete Git pair has arrived. A baseline marker is not fresh evidence.
    for (const observed of [
      [],
      [{ ...marker, message: marker.message.replace("11111111", "22222222") }],
    ]) {
      const f = fixture([marker, line(1)], AbortSignal.timeout(100));
      const before = await f.observer.snapshot();
      f.set([marker, line(1), warning, denial, ...observed]);
      await assert.rejects(f.observer.expectAfter(before, interval), { name: "AbortError" });
    }
    for (const change of [
      { source: "gateway" },
      { level: "INFO" },
      { target: "other" },
      { time: "2026-11-05T12:00:00.001000000Z" },
      { time: "2026-11-05T12:00:00.005000000Z" },
      // The millisecond is eligible, but nanosecond order precedes Git's event.
      { time: "2026-11-05T12:00:00.002000000Z" },
    ]) {
      const f = fixture([line(1)]);
      const before = await f.observer.snapshot();
      f.set([line(1), warning, denial, { ...marker, ...change }]);
      await assert.rejects(
        f.observer.expectAfter(before, interval),
        refusalAt("dns-marker", /DNS marker/),
      );
    }
    for (const sequence of [
      [marker, warning, denial],
      [warning, denial, marker, warning, denial],
      [warning, denial, marker, marker],
    ]) {
      const f = fixture([line(1)]);
      const before = await f.observer.snapshot();
      f.set([line(1), ...sequence]);
      await assert.rejects(
        f.observer.expectAfter(before, interval),
        refusalAt("dns-marker", /DNS marker/),
      );
    }
  },
);

test("Git denial receipt tolerates ring rollover only with unchanged retained history", async () => {
  // Keeping the original anchor is insufficient when an intermediate poll's
  // appended record disappears before the purported proof arrives.
  const rewritten = fixture([line(1)]);
  const rewrittenBefore = await rewritten.observer.snapshot();
  let reads = 0;
  rewritten.afterRead(() => {
    reads += 1;
    rewritten.set(reads === 1 ? [line(1), line("removed")] : [line(1), warning, denial]);
  });
  await assert.rejects(
    rewritten.observer.expectAfter(rewrittenBefore, interval),
    refusalAt("log-history", /Git denial (baseline anchor|log history)/),
  );
  // A repeated post-boundary record cannot be reinterpreted as its identical
  // pre-boundary copy when a later full ring rewrites the observed suffix.
  const repeated = line("repeated");
  const unique = line("unique-boundary");
  const aliased = fixture([repeated, unique]);
  const aliasedBefore = await aliased.observer.snapshot();
  let aliasedReads = 0;
  aliased.afterRead(() => {
    aliasedReads += 1;
    aliased.set(
      aliasedReads === 1
        ? [repeated, unique, repeated]
        : [
            repeated,
            unique,
            ...Array.from({ length: 1996 }, (_, index) => line(`replacement-${index}`)),
            warning,
            denial,
          ],
    );
  });
  await assert.rejects(
    aliased.observer.expectAfter(aliasedBefore, interval),
    refusalAt("log-history", /Git denial (baseline anchor|log history)/),
  );
  const baseline = Array.from({ length: 2000 }, (_, index) => line(index));
  const f = fixture(baseline);
  const before = await f.observer.snapshot();
  f.set([...baseline.slice(3), warning, denial, marker]);
  assert.equal((await f.observer.expectAfter(before, interval)).count, 1);

  for (const changed of [
    [line("reset"), warning, denial],
    [baseline.at(-1), warning, denial],
    [...baseline.slice(3), baseline.at(-1), warning, denial],
    [line("rewritten"), ...baseline.slice(3), warning, denial],
  ]) {
    f.set(changed);
    await assert.rejects(
      f.observer.expectAfter(before, interval),
      /Git denial (baseline anchor|log history)/,
    );
  }
});

test("Git denial receipt refuses foreign, incomplete, and ambiguous log histories", async () => {
  const privateError = Object.assign(new Error("private transport failure"), {
    stage: "private stage must not escape",
  });
  assert.equal(gitDenial.openShellGitDenialFailureStage?.(privateError), undefined);
  const unavailable = fixture([line(1)]);
  const unavailableBefore = await unavailable.observer.snapshot();
  unavailable.afterRead(() => {
    throw privateError;
  });
  await assert.rejects(unavailable.observer.expectAfter(unavailableBefore, interval), (error) => {
    assert.equal(error, privateError);
    assert.equal(gitDenial.openShellGitDenialFailureStage?.(error), "log-read");
    return true;
  });
  const f = fixture([line(1)]);
  const before = await f.observer.snapshot();
  f.set([line(1), warning, { ...denial, sandboxId: "sandbox-two" }]);
  await assert.rejects(f.observer.expectAfter(before, interval), /different Sandbox/);
  f.set([line(1), warning, denial, { ...marker, sandboxId: "sandbox-two" }]);
  await assert.rejects(f.observer.expectAfter(before, interval), /different Sandbox/);
  f.set([line(1), warning, denial], 4);
  await assert.rejects(f.observer.expectAfter(before, interval), /incomplete/);
  f.set([line(1), line(1)]);
  await assert.rejects(f.observer.snapshot(), /ambiguous/);
  await assert.rejects(f.observer.expectAfter({}, interval), /own baseline/);

  const empty = fixture([]);
  const emptyBefore = await empty.observer.snapshot();
  empty.set([...Array.from({ length: 1998 }, (_, index) => line(index)), warning, denial]);
  await assert.rejects(
    empty.observer.expectAfter(emptyBefore, interval),
    /lost its empty baseline/,
  );
});

test("Git denial receipt rejects normalized or noncanonical event dates", async () => {
  const f = fixture([line(1)]);
  const before = await f.observer.snapshot();
  for (const time of [null, "2026-11-05T12:00:00.002Z", "2026-11-31T12:00:00.002000000Z"]) {
    f.set([line(1), warning, { ...denial, time }]);
    await assert.rejects(
      f.observer.expectAfter(before, interval),
      refusalAt("event-time", /event time/),
    );
    f.set([line(1), { ...warning, time }, denial]);
    await assert.rejects(
      f.observer.expectAfter(before, interval),
      refusalAt("event-time", /event time/),
    );
  }
});

test("Git denial receipt refuses a replaced supervisor before or during the read", async () => {
  for (const duringRead of [false, true]) {
    const f = fixture([line(1)]);
    const before = await f.observer.snapshot();
    f.set([line(1), warning, denial]);
    if (duringRead) {
      f.afterRead(() => f.replaceSupervisor());
    } else {
      f.replaceSupervisor();
    }
    await assert.rejects(
      f.observer.expectAfter(before, interval),
      refusalAt("supervisor-identity", /supervisor identity changed/),
    );
  }
});

test(
  "Git denial command retains non-403 failure categories without output",
  { timeout: 20_000 },
  async (t) => {
    // Run the installed proof's exact shell command with real Git. Loopback HTTP
    // responses exercise Git's errors, not a replacement Git executable.
    const directory = await mkdtemp(join(tmpdir(), "git-denial-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const run = promisify(execFile);
    const options = { env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 };
    const repository = join(directory, "repository.git");
    await run("git", ["init", "--bare", repository], options);
    await run("git", ["--git-dir", repository, "update-server-info"], options);
    let status = 403;
    let stall = false;
    let valid = true;
    const server = createServer(async (request, response) => {
      if (stall) {
        return;
      }
      if (status !== 200) {
        response.writeHead(status);
        response.end("private server response must never escape");
        return;
      }
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      if (path !== "/info/refs" && path !== "/HEAD") {
        response.writeHead(404).end();
        return;
      }
      if (!valid) {
        response.setHeader("Content-Type", "application/x-git-upload-pack-advertisement");
        response.end("private invalid Git response");
        return;
      }
      response.end(await readFile(join(repository, path.slice(1))));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const verify = async (expected, target = url) => {
      const [command, ...args] = gitHttp403Command(
        `git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=1 ls-remote '${target}'`,
      );
      const result = await run(command, args, options).then(
        (value) => ({ ...value, code: 0 }),
        (error) => error,
      );
      assert.equal(result.code, expected);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    };
    await t.test("HTTP 403 is the only accepted denial", async () => verify(0));
    status = 503;
    await t.test("other HTTP errors remain distinct failures", async () => verify(13));
    stall = true;
    await t.test("a timed out request remains a failure", async () => verify(14));
    stall = false;
    status = 200;
    valid = false;
    await t.test("unclassified errors stay private and fail closed", async () => verify(2));
    valid = true;
    await t.test("successful Git access remains a failure", async () => verify(1));
    const tls = createHttpsServer(await selfSigned(directory), (_, response) => response.end());
    t.after(() => new Promise((resolve) => tls.close(resolve)));
    tls.listen(0, "127.0.0.1");
    await once(tls, "listening");
    await t.test("TLS verification failures remain failures", async () =>
      verify(12, `https://127.0.0.1:${tls.address().port}`),
    );
    await new Promise((resolve) => server.close(resolve));
    await t.test("connection failure cannot qualify as authorization denial", async () =>
      verify(11),
    );
  },
);
