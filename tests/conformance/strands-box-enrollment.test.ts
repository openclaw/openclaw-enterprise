import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeReleasePublicKey,
  harnessEgressEnrollment,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { HARNESS_EGRESS_ENROLLMENT_HELPER } from "../../apps/controller/src/drivers/compute/harness-egress-enrollment.ts";
import { PROTECTED_CODEX_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { relayEnrollment } from "../../deploy/examples/strands-box/host/control.ts";
import {
  type EnrollmentAnswer,
  type EnrollmentRequest,
  hostConfig,
  smokeInput,
  start,
} from "../../deploy/examples/strands-box/host/launch.ts";
import { PORT } from "../../deploy/examples/strands-box/host/transport.ts";
import type { EgressInstallation, ProxyPlan } from "../../packages/contracts/src/index.ts";
import { modelSource, pairedFixture, sha } from "../helpers/strands-box-protected-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

// Finding 3309: Compute's protected Harness program holds until its OWN startup challenge is
// released. These cases run that program (the helper Compute renders into it) behind the
// example's pre-ready enrollment bridge (box-agent, pinned by the host before its gate opens),
// with the Strands Driver's enrollHarness and Compute's real signer.

const unsupported = process.platform !== "linux" || process.getuid?.() === 0;
const boxAgent = fileURLToPath(
  new URL("../../deploy/examples/strands-box/host/box-agent.ts", import.meta.url),
);
const ENROLLMENT_PATH = "/openclaw/runtime/egress-enrollment";
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** `ip`, to bring up loopback in the private network namespace the Box stand-in runs in. */
function ipBinary(): string | undefined {
  for (const candidate of ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
const ip = ipBinary();
const netns =
  !unsupported &&
  ip !== undefined &&
  spawnSync("unshare", ["-rn", ip, "link", "set", "lo", "up"], { timeout: 5_000 }).status === 0;
const boxSkip = unsupported
  ? true
  : netns
    ? false
    : "needs unprivileged user and network namespaces (unshare -rn) and ip";

/** The function the rendered program defines and the helper uses, taken from the program. */
function renderedFunction(name: string): string {
  const start = PROTECTED_CODEX_RUNTIME_ENTRYPOINT.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, name);
  const end = PROTECTED_CODEX_RUNTIME_ENTRYPOINT.indexOf("\n}\n", start);
  return PROTECTED_CODEX_RUNTIME_ENTRYPOINT.slice(start + 1, end + 2);
}

interface HeldHarness {
  readonly directory: string;
  readonly runtimeDir: string;
  readonly execution: ReturnType<typeof start>;
  /** Created once Codex's stand-in listens: only after the program accepted its release. */
  readonly codexMarker: string;
  readonly enrollSocket: string;
  /** The current program process (the test kills it to stand in for a Harness restart). */
  runnerPid(): number;
  log(): string;
}

/**
 * A held protected run: the host's real `start` (launch.ts) with a `box run` stand-in that runs
 * the real box-agent in a private network namespace. The command is Compute's enrollment helper,
 * exactly as rendered into the protected program, which serves its challenge on `PORT` and, once
 * released, starts a Codex stand-in (a copy of node at `codexBin`) that answers 401.
 */
async function heldHarness(
  t: TestContext,
  f: Awaited<ReturnType<typeof pairedFixture>>,
  enrollment: unknown = harnessEgressEnrollment(f.plan),
): Promise<HeldHarness> {
  const directory = await temporaryDirectory(t, "strands-enroll-");
  const runtimeDir = join(directory, "run");
  const workspace = join(directory, "workspace");
  const agentBuildDir = join(directory, "build");
  const bin = join(directory, "bin");
  for (const path of [runtimeDir, workspace, agentBuildDir, bin]) {
    mkdirSync(path, { mode: 0o700 });
  }
  for (const file of ["box-agent.js", "transport.js", "diagnostics.js"]) {
    writeFileSync(join(agentBuildDir, file), "", { mode: 0o600 });
  }
  const node = realpathSync(process.execPath);
  const codexBin = join(bin, "codex");
  copyFileSync(node, codexBin, constants.COPYFILE_FICLONE);
  const codexMarker = join(directory, "codex-listening");
  const pidRecord = join(directory, "runner.pid");
  const enrollmentFile = join(directory, "enrollment.json");
  writeFileSync(enrollmentFile, JSON.stringify(enrollment), { mode: 0o600 });
  // The program: Compute's helper as the protected program carries it, on its manifest's
  // `egressEnrollment`; resolved, it exits 0 and the supervisor starts Codex.
  assert.ok(PROTECTED_CODEX_RUNTIME_ENTRYPOINT.includes(HARNESS_EGRESS_ENROLLMENT_HELPER));
  const runner = join(directory, "runner.cjs");
  writeFileSync(
    runner,
    `${renderedFunction("isPlainObject")}\n${HARNESS_EGRESS_ENROLLMENT_HELPER}\n` +
      `const enrollment = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));\n` +
      `waitForHarnessEgressEnrollment(enrollment).then(() => process.exit(0), () => process.exit(4));\n`,
    { mode: 0o600 },
  );
  const standin = join(directory, "codex-standin.cjs");
  writeFileSync(
    standin,
    `const { createServer } = require("node:http");
     const server = createServer((request, response) => response.writeHead(401).end());
     server.on("upgrade", (request, socket) =>
       socket.end("HTTP/1.1 401 Unauthorized\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n"));
     server.listen(${PORT}, "127.0.0.1", () =>
       require("node:fs").writeFileSync(process.argv[2], "listening"));
     process.on("SIGTERM", () => process.exit(0));`,
    { mode: 0o600 },
  );
  // A SIGTERM'd program is a restarted Harness: a fresh process with a fresh challenge.
  const supervisor = join(directory, "supervisor.cjs");
  writeFileSync(
    supervisor,
    `const { spawn } = require("node:child_process");
     const { writeFileSync } = require("node:fs");
     const [runner, enrollment, codex, standin, record, marker] = process.argv.slice(2);
     let child;
     function program() {
       child = spawn(process.execPath, [runner, enrollment], { stdio: "inherit" });
       writeFileSync(record, String(child.pid));
       child.once("exit", (code, signal) => {
         if (code === 0) {
           child = spawn(codex, [standin, marker], { stdio: "inherit" });
           child.once("exit", (status) => process.exit(status ?? 1));
         } else if (signal === "SIGTERM") program();
         else process.exit(3);
       });
     }
     program();
     process.on("SIGTERM", () => { child?.kill("SIGTERM"); process.exit(0); });`,
    { mode: 0o600 },
  );
  // `box run`: the agent command line and [agent.env] from the host's box.toml, then the real
  // box-agent in its own network namespace (Box's own), stdout/stderr to a log.
  const boxLog = join(directory, "box.log");
  const fixtureBox = join(directory, "fixture-box.mjs");
  writeFileSync(
    fixtureBox,
    `import { readFileSync, openSync } from "node:fs";
     import { spawn } from "node:child_process";
     const config = readFileSync(process.argv[2], "utf8");
     const command = JSON.parse(config.match(/^command = (.*)$/m)[1]);
     const env = {};
     const section = config.split("[agent.env]\\n")[1].split("\\n\\n")[0];
     for (const line of section.split("\\n")) {
       const match = /^([A-Z][A-Z0-9_]*) = (".*")$/.exec(line);
       if (match) env[match[1]] = JSON.parse(match[2]);
     }
     const log = openSync(${JSON.stringify(boxLog)}, "a");
     const agent = spawn("unshare", ["-rn", "sh", "-c", ${JSON.stringify(`${ip} link set lo up && exec "$@"`)},
       "sh", ${JSON.stringify(node)}, ${JSON.stringify(boxAgent)}, command[3]],
       { env, stdio: ["ignore", log, log] });
     process.on("SIGTERM", () => agent.kill("SIGTERM"));
     agent.once("exit", (code) => process.exit(code ?? 1));`,
    { mode: 0o600 },
  );
  const boxBin = join(directory, "fixture-box");
  writeFileSync(
    boxBin,
    `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(fixtureBox)} "$3"\n`,
    { mode: 0o700 },
  );
  const config = hostConfig({
    boxBin,
    nodeBin: node,
    codexBin,
    agentBuildDir,
    runtimeDir,
    workspace,
    read: [],
    exec: [],
    linuxPreview: true,
  });
  const { input } = smokeInput(config);
  const execution = start(config, {
    ...input,
    command: [node, supervisor, runner, enrollmentFile, codexBin, standin, pidRecord, codexMarker],
    environment: {
      ...input.environment,
      APP_TOKEN_SHA: sha(f.harness.transportToken),
      OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: f.revision.id,
      OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY: computeReleasePublicKey(f.keys.privateKey),
    },
    releaseGate: true,
    reservationGeneration: randomBytes(32).toString("hex"),
    credentialSource: {
      socket: join(runtimeDir, "source", "oce.sock"),
      bearer: randomBytes(32).toString("base64url"),
    },
  });
  t.after(async () => {
    await execution.stop().catch(() => undefined);
  });
  await execution.spawned;
  // The paired host serves this run: its gate and its bridge, ready when Codex listens.
  f.host.readyOnRelease = false;
  f.host.onRelease = () => execution.release();
  f.host.enrollment = (request) => execution.enrollment(request);
  void execution.ready.then(
    () => {
      f.host.state = "running";
    },
    () => undefined,
  );
  return {
    directory,
    runtimeDir,
    execution,
    codexMarker,
    enrollSocket: join(runtimeDir, "bridge", "enroll.sock"),
    runnerPid: () => Number(readFileSync(pidRecord, "utf8")),
    log: () => (existsSync(boxLog) ? readFileSync(boxLog, "utf8") : ""),
  };
}

async function until<T>(
  action: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeout = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await action();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The program's challenge, read directly through the host's pinned bridge. */
async function challengeOf(held: HeldHarness, bearer: string) {
  return until(async () => {
    const answer = await held.execution.enrollment({ method: "GET", bearer });
    return answer?.status === 200 ? (answer.document as Record<string, unknown>) : undefined;
  }, "the program's challenge");
}

/** Raw bytes to the visible in-Box bridge path; what comes back before it closes. */
async function raw(path: string, bytes: string): Promise<string> {
  const socket = createConnection({ path });
  socket.setTimeout(3_000, () => socket.destroy());
  let received = "";
  socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
  socket.on("error", () => undefined);
  socket.write(bytes);
  await once(socket, "close");
  return received;
}

test("the Driver's enrollment binding is Compute's own projection of the plan", async (t) => {
  const f = await pairedFixture(t);
  const { enrollmentBinding } = (await import(
    pathToFileURL(
      join(
        f.root,
        "controller/node_modules/@openclaw-enterprise/example-strands-box-driver/dist/protected.js",
      ),
    ).href
  )) as { enrollmentBinding(plan: ProxyPlan): Record<string, unknown> };
  const inference = {
    binding: { grant: { kind: "inference" } },
  } as unknown as ProxyPlan["routes"][number];
  const { repositoryGitAuthorization: _authorization, repositoryGit: _git, ...ungated } = f.plan;
  for (const plan of [
    f.plan,
    { ...f.plan, harnessCredentialSource: modelSource } as ProxyPlan,
    { ...f.plan, routes: [inference] },
    ungated as ProxyPlan,
  ]) {
    assert.deepEqual(enrollmentBinding(plan), harnessEgressEnrollment(plan));
  }
});

test(
  "Compute's protected Harness program, behind box-agent's bridge, is released only by the challenge the Strands Driver relays",
  { skip: boxSkip, timeout: 90_000 },
  async (t) => {
    const f = await pairedFixture(t);
    const held = await heldHarness(t, f);
    const token = f.harness.transportToken;
    const wiring = await f.release.configure(f.context);
    const signed: string[] = [];
    let restart: (() => Promise<void>) | undefined;
    const sign = async (startupId: string, current: EgressInstallation) => {
      signed.push(startupId);
      const record = signComputeExecutionRelease(f.keys.privateKey, startupId, current);
      const before = restart;
      restart = undefined;
      await before?.();
      return record;
    };
    // Compute's signer is synchronous; this one may first restart the program (pass 2), and
    // ProtectedExecutionDriver.enroll's `release` awaits whatever it returns.
    const pass = () =>
      f.release.enroll(
        f.context,
        wiring,
        f.custody,
        async () => true,
        async () => f.harness,
        (startupId, current) => sign(startupId, current) as never,
      );

    // Pass 1: the host's own gate (a startupId the Driver chose); box run starts the program.
    assert.equal(await pass(), true);
    assert.equal(signed.length, 1);
    assert.equal(f.host.startup?.startupId, signed[0]);
    const first = await challengeOf(held, token);
    assert.equal(first.profile, "oce-compute-execution-release-v1");
    assert.match(String(first.startupId), UUID_V4);
    assert.notEqual(first.startupId, signed[0]);
    // Held: the program serves its challenge and Codex is not started.
    assert.equal(existsSync(held.codexMarker), false);
    assert.equal(f.host.state, "starting");

    // The program refuses what is not Compute's release of its own challenge.
    const committed = f.committed()!;
    const post = (release: unknown, bearer = token) =>
      held.execution.enrollment({ method: "POST", bearer, body: JSON.stringify(release) });
    assert.equal(
      (await held.execution.enrollment({ method: "GET", bearer: "wrong" }))?.status,
      401,
    );
    assert.equal(
      (await post(signComputeExecutionRelease(f.keys.privateKey, randomUUID(), committed)))?.status,
      409,
    );
    const other = generateKeyPairSync("ed25519");
    assert.equal(
      (
        await post(
          signComputeExecutionRelease(other.privateKey, String(first.startupId), committed),
        )
      )?.status,
      409,
    );
    // Without a bearer it is refused too; the bridge reaches only the program's port.
    const unauthenticated = await raw(
      held.enrollSocket,
      `GET ${ENROLLMENT_PATH} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    );
    assert.match(unauthenticated, /^HTTP\/1\.1 401 /);
    // Any other request on the pre-ready path is closed unanswered, never dialled elsewhere.
    let canaryHits = 0;
    const canary = createServer((socket) => {
      canaryHits += 1;
      socket.destroy();
    });
    canary.listen(0, "127.0.0.1");
    await once(canary, "listening");
    t.after(() => canary.close());
    const canaryPort = (canary.address() as { port: number }).port;
    for (const line of [
      "GET / HTTP/1.1",
      `PUT ${ENROLLMENT_PATH} HTTP/1.1`,
      `GET http://127.0.0.1:${canaryPort}${ENROLLMENT_PATH} HTTP/1.1`,
      `CONNECT 127.0.0.1:${canaryPort} HTTP/1.1`,
      `GET ${ENROLLMENT_PATH}?x=1 HTTP/1.1`,
    ]) {
      assert.equal(
        await raw(held.enrollSocket, `${line}\r\nHost: 127.0.0.1:${canaryPort}\r\n\r\n`),
        "",
        line,
      );
    }
    assert.equal(canaryHits, 0);
    // Exactly one bounded request per connection: no upgrade, no chunked or oversized body, no
    // keep-alive, and nothing pipelined after it.
    const get = `GET ${ENROLLMENT_PATH} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}`;
    const post = (length: number, extra = "") =>
      `POST ${ENROLLMENT_PATH} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}` +
      `\r\nContent-Type: application/json${extra}\r\nContent-Length: ${length}\r\n\r\n` +
      "{".repeat(Math.min(length, 5_000));
    for (const [name, bytes] of [
      ["upgrade", `${get}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`],
      ["keep-alive", `${get}\r\nConnection: keep-alive\r\n\r\n`],
      ["chunked", `${get}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`],
      ["GET body", `${get}\r\nContent-Length: 2\r\n\r\n{}`],
      ["oversized body", post(4_097)],
      ["expect", post(2, "\r\nExpect: 100-continue")],
      ["pipelined", `${get}\r\n\r\n${get}\r\n\r\n`],
      ["oversized head", `${get}\r\nX-Fill: ${"a".repeat(5_000)}\r\n\r\n`],
    ] as const) {
      assert.equal(await raw(held.enrollSocket, bytes), "", name);
    }
    assert.match(await raw(held.enrollSocket, `${get}\r\n\r\n`), /^HTTP\/1\.1 200 /);
    // The host dials only the inode it pinned before the gate: a socket put at the visible path
    // (as a workload could) gets neither the bearer nor a release, and the program still answers.
    const visible = held.enrollSocket;
    const moved = `${visible}.moved`;
    renameSync(visible, moved);
    let impostorBytes = "";
    const impostor = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => (impostorBytes += chunk.toString("latin1")));
      socket.end();
    });
    impostor.listen(visible);
    await once(impostor, "listening");
    t.after(() => impostor.close());
    assert.deepEqual(await held.execution.enrollment({ method: "GET", bearer: token }), {
      status: 200,
      document: first,
    });
    assert.equal(impostorBytes, "");
    // A wrong transport bearer stops at the host: nothing relayed, nothing signed.
    await assert.rejects(
      f.sandbox.enrollHarness!({ ...f.harness, transportToken: "wrong-token" }, committed, () => {
        throw new Error("release must not be requested");
      }),
      /host refused the Harness enrollment/,
    );
    assert.deepEqual(f.host.enrollmentRefusals, ["transport_bearer_refused"]);
    assert.equal(existsSync(held.codexMarker), false);

    // Pass 2: the Harness restarts between the read and the release: the stale release is
    // refused (409), the pass ends without error, and Codex still waits.
    const replaced = held.runnerPid();
    restart = async () => {
      process.kill(replaced, "SIGTERM");
      await until(async () => {
        const fresh = await held.execution.enrollment({ method: "GET", bearer: token });
        const document = fresh?.document as Record<string, unknown> | undefined;
        return fresh?.status === 200 && document?.startupId !== first.startupId ? true : undefined;
      }, "the restarted program's challenge");
    };
    assert.equal(await pass(), true);
    assert.deepEqual(signed.slice(1), [first.startupId]);
    assert.notEqual(held.runnerPid(), replaced);
    assert.equal(existsSync(held.codexMarker), false);
    assert.equal(f.host.state, "starting");

    // Pass 3: the fresh challenge is read and released; the program accepts it, Codex starts.
    const fresh = await challengeOf(held, token);
    assert.notEqual(fresh.startupId, first.startupId);
    assert.equal(await pass(), true);
    assert.deepEqual(signed.slice(2), [fresh.startupId]);
    await until(() => (existsSync(held.codexMarker) ? true : undefined), "Codex's listener");
    await held.execution.ready;
    assert.equal(f.host.state, "running");
    // Three distinct startups, each signed by Compute once: the host gate and two challenges.
    assert.equal(new Set(signed).size, 3);
    const posts = f.host.enrollments.filter((request) => request.release !== undefined);
    assert.equal(posts.length, 2);
    for (const request of f.host.enrollments) {
      assert.deepEqual(
        Object.keys(request).sort(),
        [
          "executionId",
          "owner",
          "requirementsDigest",
          "transportToken",
          ...(request.release === undefined ? [] : ["release"]),
        ].sort(),
      );
    }

    // Ready: the Driver does nothing more, and the pre-ready path is gone on both sides. The
    // host neither dials the visible path (still the impostor) nor relays for a ready run.
    assert.equal(await pass(), true);
    assert.equal(signed.length, 3);
    assert.equal(await held.execution.enrollment({ method: "GET", bearer: token }), undefined);
    assert.equal(readdirSync(held.runtimeDir).includes("enroll-pinned.sock"), false);
    await until(
      () => (/source=inner stage=enrollment reason=closed/.test(held.log()) ? true : undefined),
      "box-agent closing the bridge",
    );
    const before = f.host.enrollments.length;
    f.host.state = "starting";
    await assert.doesNotReject(
      f.sandbox.enrollHarness!(f.harness, committed, () => {
        throw new Error("release must not be requested");
      }),
    );
    f.host.state = "running";
    assert.equal(f.host.enrollments.length, before + 1);
    assert.equal(impostorBytes, "");
  },
);

test(
  "a program whose challenge is not this execution's is never released",
  { skip: boxSkip, timeout: 60_000 },
  async (t) => {
    const f = await pairedFixture(t);
    // The program in Box was rendered for another plan generation than the admitted one.
    const held = await heldHarness(t, f, {
      ...harnessEgressEnrollment(f.plan),
      plan: { id: f.plan.id, generation: f.plan.generation + 1 },
    });
    const wiring = await f.release.configure(f.context);
    const signed: string[] = [];
    const pass = () =>
      f.release.enroll(
        f.context,
        wiring,
        f.custody,
        async () => true,
        async () => f.harness,
        (startupId, current) => {
          signed.push(startupId);
          return signComputeExecutionRelease(f.keys.privateKey, startupId, current);
        },
      );
    assert.equal(await pass(), true);
    await challengeOf(held, f.harness.transportToken);
    await assert.rejects(pass(), /challenge does not match the admitted execution/);
    // Only the host gate was signed; the program keeps holding.
    assert.equal(signed.length, 1);
    assert.equal(existsSync(held.codexMarker), false);
    assert.equal(f.host.state, "starting");
  },
);

/** A held, gate-released paired fixture whose program answers are scripted. */
async function scripted(t: TestContext) {
  const f = await pairedFixture(t);
  f.host.readyOnRelease = false;
  const wiring = await f.release.configure(f.context);
  const signed: string[] = [];
  const pass = () =>
    f.release.enroll(
      f.context,
      wiring,
      f.custody,
      async () => true,
      async () => f.harness,
      (startupId, current) => {
        signed.push(startupId);
        return signComputeExecutionRelease(f.keys.privateKey, startupId, current);
      },
    );
  assert.equal(await pass(), true);
  assert.equal(signed.length, 1);
  const sent: EnrollmentRequest[] = [];
  const answers: (EnrollmentAnswer | undefined)[] = [];
  f.host.enrollment = async (request) => {
    sent.push(request);
    return answers.shift();
  };
  const challenge = (startupId: string = randomUUID()) => ({
    profile: "oce-compute-execution-release-v1",
    ...harnessEgressEnrollment(f.plan),
    startupId,
  });
  return { f, pass, signed, sent, answers, challenge };
}

test("the Driver checks the program's untrusted challenge before Compute is asked", async (t) => {
  const s = await scripted(t);
  const valid = s.challenge();
  for (const document of [
    { ...valid, profile: "another-profile" },
    { ...valid, startupId: "not-a-uuid" },
    { ...valid, startupId: valid.startupId.toUpperCase() },
    { ...valid, startupId: "2f1c1b8e-0d6a-1c3e-8f00-0123456789ab" },
    { ...valid, routeCount: 2 },
    { ...valid, inference: true },
    { ...valid, execution: { ...valid.execution, executionId: "another" } },
    { ...valid, plan: { ...valid.plan, generation: 2 } },
    { ...valid, extra: true },
    null,
  ]) {
    s.answers.push({ status: 200, document });
    await assert.rejects(s.pass(), /challenge does not match the admitted execution/);
  }
  assert.equal(s.signed.length, 1);
  assert.ok(s.sent.every((request) => request.method === "GET"));
});

test("a program still starting, restarted, or expired stays pending; only its own acknowledgement completes", async (t) => {
  const s = await scripted(t);
  // Not listening yet, or answering something other than a challenge: pending, nothing signed.
  s.answers.push(undefined);
  assert.equal(await s.pass(), true);
  s.answers.push({ status: 410, document: { error: "expired" } });
  assert.equal(await s.pass(), true);
  assert.equal(s.signed.length, 1);
  // Restarted (409) or expired (410) at the release: pending, the next pass reads afresh.
  for (const status of [409, 410]) {
    const challenge = s.challenge();
    s.answers.push({ status: 200, document: challenge });
    s.answers.push({ status, document: { error: "stale_enrollment" } });
    assert.equal(await s.pass(), true);
    assert.equal(s.signed.at(-1), challenge.startupId);
  }
  // Any other answer to the release, or an acknowledgement of another startup, is an error.
  for (const answer of [
    { status: 200, document: { enrolled: true, startupId: randomUUID() } },
    { status: 200, document: { enrolled: false } },
    { status: 400, document: { error: "invalid_request" } },
  ]) {
    s.answers.push({ status: 200, document: s.challenge() });
    s.answers.push(answer);
    await assert.rejects(s.pass(), /enrollment was not acknowledged/);
  }
  const last = s.challenge();
  s.answers.push({ status: 200, document: last });
  s.answers.push({ status: 200, document: { enrolled: true, startupId: last.startupId } });
  assert.equal(await s.pass(), true);
  // Exactly the two requests, the release with Compute's record for that challenge.
  const lastPost = s.sent.at(-1)!;
  assert.equal(lastPost.method, "POST");
  assert.deepEqual(
    JSON.parse((lastPost as { body: string }).body).challenge,
    JSON.parse(JSON.stringify(last)),
  );
  assert.ok(s.sent.every((request) => request.bearer === s.f.harness.transportToken));
});

test("the host relays a release only for the challenge it relayed, signed by Compute for this execution", async () => {
  const keys = generateKeyPairSync("ed25519");
  const plan = {
    id: "plan_pilot",
    generation: 1,
    execution: {
      installationId: "installation",
      namespaceId: "ns",
      agentId: "agt",
      servicePrincipalId: "sp",
      revisionId: "rev",
      executionId: "compute-execution",
    },
    routes: [],
    repositoryGitAuthorization: "online-request",
    repositoryGit: { bindings: [{ profile: "github-repository" }] },
  } as unknown as ProxyPlan;
  const expected = {
    executionId: "box-execution",
    processInstanceId: "boot:1:2",
    bearerSha256: "b".repeat(64),
  };
  const installation = {
    plan,
    sandboxId: expected.executionId,
    sender: { id: "sender", generation: 1 },
    enforcement: {
      instanceId: expected.executionId,
      configurationId: "configuration",
      policyHash: "policy",
      authorityScope: "execution",
      repositoryGitRecipient: {
        providerId: "sender",
        attachmentEpoch: expected.executionId,
        processInstanceId: expected.processInstanceId,
        networkInstanceId: `box-source-sha256:${expected.bearerSha256}`,
        authorization: "online-request",
        deliveryProfile: "github_repository",
      },
    },
  } as unknown as EgressInstallation;
  const token = "transport-bearer";
  const held: Parameters<typeof relayEnrollment>[0] = {
    startup: {
      releaseKey: keys.publicKey,
      plan: plan as never,
      transportSha256: createHash("sha256").update(token).digest("hex"),
    },
    expected,
  };
  const sent: EnrollmentRequest[] = [];
  const challenge = {
    profile: "oce-compute-execution-release-v1",
    ...harnessEgressEnrollment(plan),
    startupId: randomUUID(),
  };
  const send = async (request: EnrollmentRequest) => {
    sent.push(request);
    return request.method === "GET"
      ? { status: 200, document: challenge }
      : { status: 200, document: { enrolled: true, startupId: challenge.startupId } };
  };
  const refused = async (data: Record<string, unknown>, message: string) => {
    await assert.rejects(relayEnrollment(held, data, send), { message });
  };
  // The transport bearer: missing, malformed or another one; nothing is sent.
  await refused({}, "transport_bearer_refused");
  await refused({ transportToken: "" }, "transport_bearer_refused");
  await refused({ transportToken: "a b" }, "transport_bearer_refused");
  await refused({ transportToken: "another-bearer" }, "transport_bearer_refused");
  assert.equal(sent.length, 0);
  // A release before any challenge was relayed.
  const release = signComputeExecutionRelease(keys.privateKey, challenge.startupId, installation);
  await refused({ transportToken: token, release }, "release_outside_harness_challenge");
  assert.equal(sent.length, 0);
  assert.deepEqual(await relayEnrollment(held, { transportToken: token }, send), {
    status: 200,
    document: challenge,
  });
  assert.deepEqual(held.harnessChallenge, challenge);
  // Another startup, another key, another execution, or expired: refused before relaying.
  const other = generateKeyPairSync("ed25519");
  await refused(
    {
      transportToken: token,
      release: signComputeExecutionRelease(keys.privateKey, randomUUID(), installation),
    },
    "release_outside_harness_challenge",
  );
  await refused(
    {
      transportToken: token,
      release: signComputeExecutionRelease(other.privateKey, challenge.startupId, installation),
    },
    "release_signature_refused",
  );
  await refused(
    {
      transportToken: token,
      release: signComputeExecutionRelease(keys.privateKey, challenge.startupId, {
        ...installation,
        sandboxId: "another-execution",
      }),
    },
    "release_outside_held_execution",
  );
  await assert.rejects(
    relayEnrollment(held, { transportToken: token, release }, send, release.expiresAt),
    { message: "release_signature_refused" },
  );
  assert.equal(sent.length, 1);
  // Compute's release of exactly that challenge goes in as the one POST, with the bearer.
  assert.deepEqual(await relayEnrollment(held, { transportToken: token, release }, send), {
    status: 200,
    document: { enrolled: true, startupId: challenge.startupId },
  });
  assert.deepEqual(sent.at(-1), { method: "POST", bearer: token, body: JSON.stringify(release) });
});
