import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { RepositoryNetworkGrant } from "@openclaw-enterprise/contracts";
import type { SandboxPolicyViewWire } from "../../packages/contracts/src/api/sandbox-policy.ts";
import type { AgentDeploymentStatusWire } from "../../packages/contracts/src/api/resources.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { wirePolicy } from "../../apps/controller/src/drivers/egress-proxy/openshell-wire-policy.ts";
import { assertGitCallbackEndpoint } from "../fixtures/openshell-git-callback-proxy.ts";
import type { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";
import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.ts";
import { observeUntil, prepareFiniteGitAgent } from "../helpers/finite-git-agent.ts";
import { ownFirstAgentWork } from "../helpers/local-first-agent-stack.mjs";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";
import { createGitAclDenialCommand } from "../helpers/openshell-git-denial.ts";

const emptyDeployRefusal = {
  status: 409,
  code: "RESOURCE_CONFLICT",
  path: "/repositoryNetworkPolicy",
  detailCode: "INVALID_VALUE",
  message:
    "The selected Compute Driver cannot enforce this Agent's repository network policy with the selected Sandbox Driver and Harness.",
};

const selected = process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";

function settleBeforeFixtureTeardown(run: (t: TestContext) => Promise<void>) {
  return (t: TestContext) => ownFirstAgentWork(t)(run(t));
}

type GitInstallation = Awaited<ReturnType<typeof createOpenShellGitInstallation>>;
type GitOrigin = Awaited<ReturnType<typeof startSkipperPrivateGitOrigin>>;
type GitTarget = { sandboxName: string; sandboxId: string };
type GitExec = ReturnType<typeof createManagedWorkloadExec>;

const curl = [
  "/usr/bin/curl",
  "-q",
  "--noproxy",
  "*",
  "--proto",
  "=https",
  "--max-time",
  "10",
  "-s",
] as const;

function savedGitAclIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type Deployed = Awaited<ReturnType<Awaited<ReturnType<typeof prepareFiniteGitAgent>>["deploy"]>>;
function savedGitProbeTools(fixture: GitInstallation, execute: GitExec) {
  const origin: GitOrigin = fixture.origin;
  const network = origin.network;
  assert.ok(network);
  type Observation = Parameters<ReturnType<typeof createGitAclDenialCommand>>[0];
  const guest = (target: GitTarget, observation: Observation, command: [string, ...string[]]) =>
    execute(
      target,
      createGitAclDenialCommand(network.issuedCredentialFingerprints())(observation, command),
    );
  const gitSetup = "export LC_ALL=C";
  const gitScript = (target: GitTarget, script: string) =>
    guest(target, { kind: "success" }, ["sh", "-ceu", `${gitSetup}; ${script}`]);
  const repositoryUrl = (name: "a" | "b" | "c") => `https://github.com/fixture/${name}.git`;

  const issuedIndex = (after: number) => {
    const observations = network
      .requests()
      .slice(after)
      .filter(({ authenticated }) => authenticated);
    const indices = new Set(observations.map(({ credentialIndex }) => credentialIndex));
    const [index] = indices;
    assert.ok(indices.size === 1 && typeof index === "number", "require one issued Git credential");
    return index;
  };

  // Calibrate discovery and direct RPC independently with the exact issued
  // credential, including on repositories that the Sandbox must deny.
  const requests = [
    { service: "upload", method: "GET", allowed: "a", denied: ["c"] },
    { service: "upload", method: "POST", allowed: "a", denied: ["c"] },
    { service: "receive", method: "GET", allowed: "b", denied: ["a", "c"] },
    { service: "receive", method: "POST", allowed: "b", denied: ["a", "c"] },
  ] as const;
  type Probe = Pick<(typeof requests)[number], "service" | "method">;
  const probeShape = (repository: "a" | "b" | "c", { service, method }: Probe) => {
    const gitService = `git-${service}-pack`;
    const path = `/fixture/${repository}.git/${method === "GET" ? "info/refs" : gitService}`;
    const target = method === "GET" ? `${path}?service=${gitService}` : path;
    const body = service === "upload" ? `0032want ${origin.initialSha}\n00000009done\n` : "0000";
    const rpc =
      method === "GET"
        ? []
        : ["-H", `Content-Type: application/x-${gitService}-request`, "--data-binary", body];
    return {
      gitService,
      path,
      url: `https://github.com${target}`,
      body,
      rpc,
      responseType: `application/x-${gitService}-${method === "GET" ? "advertisement" : "result"}`,
    };
  };
  const checkCalibration = (before: number, index: number, repository: string, request: Probe) => {
    const observed = network.requests().slice(before);
    assert.equal(observed.length, 1, "ACL_CALIBRATION_COUNT");
    const [entry] = observed;
    assert.ok(
      entry?.repository === `fixture/${repository}` &&
        entry.operation ===
          `${request.service}-${request.method === "GET" ? "advertise" : "pack"}` &&
        entry.method === request.method &&
        entry.authenticated &&
        entry.credentialIndex === index,
      "ACL_CALIBRATION_ORIGIN",
    );
  };
  const allowReplay = async (
    target: GitTarget,
    index: number,
    repository: "a" | "b" | "c",
    request: Probe,
  ) => {
    const shape = probeShape(repository, request);
    const before = network.requests().length;
    const result = await guest(target, { kind: "success" }, [
      "sh",
      "-ceu",
      'exec "$@" -u "x-access-token:$GITHUB_TOKEN"',
      "--",
      ...curl,
      "-X",
      request.method,
      ...shape.rpc,
      shape.url,
      "-o",
      "/dev/null",
      "-w",
      "%{http_code} %{content_type}",
    ]);
    assert.ok(
      result.stdout.toString("utf8") === `200 ${shape.responseType}`,
      "ACL_CALIBRATION_HTTP",
    );
    checkCalibration(before, index, repository, request);
  };
  return {
    guest,
    gitSetup,
    gitScript,
    repositoryUrl,
    issuedIndex,
    requests,
    probeShape,
    checkCalibration,
    allowReplay,
  };
}

type IssuedDeployment = Deployed & { credentialIndex: number };

async function deployWithIssuance(
  origin: GitOrigin,
  deploy: () => Promise<Deployed>,
): Promise<IssuedDeployment> {
  const previous = new Set(origin.snapshot().tokens.map(({ index }) => index));
  const deployed = await deploy();
  const issued = origin.snapshot().tokens.filter(({ index }) => !previous.has(index));
  assert.equal(issued.length, 1, `Revision ${deployed.revision.id} must issue one credential`);
  const [credential] = issued;
  assert.ok(credential && !credential.revoked);
  return { ...deployed, credentialIndex: credential.index };
}

async function calibratePermissiveSavedGit(
  t: TestContext,
  fixture: GitInstallation,
  execute: GitExec,
  deployed: IssuedDeployment,
) {
  const origin: GitOrigin = fixture.origin;
  const network = origin.network;
  assert.ok(network);

  const { guest, allowReplay } = savedGitProbeTools(fixture, execute);
  const run = (command: [string, ...string[]]) =>
    guest(deployed.target, { kind: "success" }, command);
  const checkExecution = async () => {
    assert.ok(Date.now() < deployed.deadlineWallMs, "The finite Git grant expired");
    assert.deepEqual((await deployed.readExecution()).identity, deployed.original.identity);
  };

  // Use a separate ref so the restricted run can still prove A's attempted write had no effect.
  const ref = "refs/heads/permissive-control-a";
  const url = "https://github.com/fixture/a.git";
  await checkExecution();
  assert.equal(await network.ref("fixture/a", ref), undefined);
  const pushStart = network.requests().length;
  const push = await run([
    "sh",
    "-ceu",
    `export LC_ALL=C
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
git clone -q '${url}' "$work/checkout"
git -C "$work/checkout" -c user.name=Fixture -c user.email=fixture@example.test commit -q --allow-empty -m 'Permissive A control'
git -C "$work/checkout" push -q origin 'HEAD:${ref}'
git -C "$work/checkout" rev-parse HEAD`,
  ]);
  const pushedOid = push.stdout.toString("utf8").trim();
  assert.ok(/^[a-f0-9]{40}$/.test(pushedOid), "Permissive push must return a commit OID");
  assert.notEqual(pushedOid, origin.initialSha);
  assert.equal(await network.ref("fixture/a", ref), pushedOid);
  assert.equal(await network.hasObject("fixture/a", pushedOid), true);

  const pushRequests = network.requests().slice(pushStart);
  assert.ok(pushRequests.every(({ repository }) => repository === "fixture/a"));
  const authenticated = pushRequests.filter(({ authenticated }) => authenticated);
  const { credentialIndex } = deployed;
  assert.ok(authenticated.length > 0, "Expected a managed credential at the origin");
  assert.ok(authenticated.every((entry) => entry.credentialIndex === credentialIndex));
  assert.deepEqual(
    new Set(authenticated.map(({ method, operation }) => `${method} ${operation}`)),
    new Set([
      "GET upload-advertise",
      "POST upload-pack",
      "GET receive-advertise",
      "POST receive-pack",
    ]),
  );

  const fetch = await run([
    "sh",
    "-ceu",
    `export LC_ALL=C
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
git init -q --bare "$work"
git -C "$work" fetch -q '${url}' '${ref}:${ref}'
git -C "$work" rev-parse '${ref}^{commit}'`,
  ]);
  assert.ok(
    fetch.stdout.toString("utf8").trim() === pushedOid,
    "Fresh fetch must return the pushed commit",
  );

  const controls = [
    { repository: "a", service: "receive", method: "GET" },
    { repository: "a", service: "receive", method: "POST" },
    { repository: "c", service: "upload", method: "GET" },
    { repository: "c", service: "upload", method: "POST" },
    { repository: "c", service: "receive", method: "GET" },
    { repository: "c", service: "receive", method: "POST" },
  ] as const;

  for (const control of controls) {
    await allowReplay(deployed.target, credentialIndex, control.repository, control);
  }

  await checkExecution();
  t.diagnostic(
    JSON.stringify({
      event: "saved-git-acl-permissive-control",
      sandbox: savedGitAclIdentity(deployed.target.sandboxId),
      credentialIndex,
      ref,
      pushedOid,
      controls,
    }),
  );
}

async function exerciseSavedGitAcl(
  t: TestContext,
  fixture: GitInstallation,
  execute: GitExec,
  owner: IssuedDeployment,
  replace: ((credentialIndex: number) => Promise<IssuedDeployment>) | undefined,
  expectedCallbacks: number,
  lent = false,
) {
  const origin: GitOrigin = fixture.origin;
  const network = origin.network;
  assert.ok(network);
  const verifyCallbackCount = async () => {
    assert.ok(fixture.callbacks);
    assert.equal(await fixture.callbacks.read(), expectedCallbacks, "Unexpected Git callback");
  };
  const {
    guest,
    gitSetup,
    gitScript,
    repositoryUrl,
    issuedIndex,
    requests,
    probeShape,
    checkCalibration,
    allowReplay,
  } = savedGitProbeTools(fixture, execute);
  type Probe = Parameters<typeof probeShape>[1];
  const original = owner.target;
  // Repeat the same restricted controls on the same Sandbox around renewal.
  // Use independent checkouts, commits and remote refs for the first pass.
  const dir = replace ? "/tmp" : "/tmp/before-rotation";
  const branch = replace ? "approved" : "before-rotation";
  const allowedStart = network.requests().length;
  const success = await gitScript(
    original,
    `mkdir -p "${dir}" && cd "${dir}";
git clone -q '${repositoryUrl("a")}' a; git -C a fetch -q origin;
git clone -q '${repositoryUrl("b")}' b; git -C b fetch -q origin;
git -C b -c user.name=Fixture -c user.email=fixture@example.test commit -q --allow-empty -m ${branch};
git -C b push -q origin HEAD:refs/heads/${branch}; git -C b rev-parse HEAD`,
  );
  const pushed = success.stdout.toString("utf8").trim();
  assert.ok(/^[a-f0-9]{40}$/.test(pushed), "ACL_PUSH_IDENTITY");
  assert.equal(await network.ref("fixture/b", `refs/heads/${branch}`), pushed);
  assert.equal(await network.hasObject("fixture/b", pushed), true);
  const originalIndex = owner.credentialIndex;
  assert.equal(issuedIndex(allowedStart), originalIndex);
  const allowed = network.requests().slice(allowedStart);
  for (const [repository, operation] of [
    ["fixture/a", "upload-pack"],
    ["fixture/b", "upload-pack"],
    ["fixture/b", "receive-pack"],
  ]) {
    assert.ok(
      allowed.some(
        (request) =>
          request.repository === repository &&
          request.operation === operation &&
          request.authenticated &&
          request.credentialIndex === originalIndex,
      ),
      "ACL_ALLOWED_GIT_ORIGIN",
    );
  }
  const fresh = await gitScript(
    original,
    `local_dir=$(mktemp -d)
git init -q --bare "$local_dir"
git -C "$local_dir" fetch -q '${repositoryUrl("b")}' refs/heads/${branch}:refs/heads/${branch}
git -C "$local_dir" rev-parse 'refs/heads/${branch}^{commit}'`,
  );
  assert.ok(
    fresh.stdout.toString("utf8").trim() === pushed,
    "Fresh fetch must see the pushed B ref",
  );
  assert.equal(issuedIndex(allowedStart), originalIndex);

  const denyReplay = async (
    target: GitTarget,
    index: number,
    repository: "a" | "b" | "c",
    request: Probe,
  ) => {
    const shape = probeShape(repository, request);
    const calibration = network.requests().length;
    const witness = await network.probeIssued(index, `fixture/${repository}`, {
      method: request.method,
      service: shape.gitService,
      ...(request.method === "POST" && { body: shape.body }),
    });
    assert.deepEqual(witness, { status: 200, type: shape.responseType });
    checkCalibration(calibration, index, repository, request);
    const before = origin.snapshot();
    const response = await guest(
      target,
      { kind: "rest", method: request.method, path: shape.path, host: "github.com" },
      [...curl, "-X", request.method, ...shape.rpc, shape.url],
    );
    const after = origin.snapshot();
    assert.equal(after.requests, before.requests, "ACL_DENIAL_ORIGIN");
    const decision = "native-rest-policy";
    assert.ok(response.stdout.toString("utf8") === `403 ${decision}\n`, "ACL_DENIAL_PROVENANCE");
    t.diagnostic(
      JSON.stringify({
        event: "saved-git-acl-denial",
        sandbox: savedGitAclIdentity(target.sandboxId),
        credentialIndex: index,
        repository,
        method: request.method,
        service: request.service,
        status: 403,
        decision,
        originHttpDelta: after.requests - before.requests,
        originTcpDelta: after.connections - before.connections,
      }),
    );
  };
  const denyGit = async (target: GitTarget, args: string[]) => {
    const before = origin.snapshot().requests;
    const response = await guest(target, { kind: "git" }, [
      "sh",
      "-ceu",
      `${gitSetup}; exec git "$@"`,
      "--",
      ...args,
    ]);
    assert.ok(response.stdout.toString("utf8") === "403 native-git\n", "ACL_NATIVE_HTTP");
    assert.equal(origin.snapshot().requests, before, "ACL_NATIVE_DENIAL_ORIGIN");
  };
  const denyC = async (target: GitTarget, local: string) => {
    const deniedRef = "refs/heads/acl-denied";
    await denyGit(target, ["ls-remote", repositoryUrl("c")]);
    await denyGit(target, ["-C", local, "push", "-q", repositoryUrl("c"), `HEAD:${deniedRef}`]);
    assert.equal(await network.ref("fixture/c", deniedRef), undefined);
  };

  // A response with no credential must not count as the affirmative bypass control.
  const missing = await network.probeIssued(undefined, "fixture/a", {
    method: "GET",
    service: "git-upload-pack",
  });
  assert.deepEqual(missing, { status: 401, type: "application/json" });
  assert.equal(network.requests().at(-1)?.authenticated, false);
  for (const request of requests) {
    await allowReplay(original, originalIndex, request.allowed, request);
    for (const repository of request.denied) {
      await denyReplay(original, originalIndex, repository, request);
    }
  }
  await denyGit(original, ["-C", `${dir}/a`, "push", "-q", "origin", "HEAD:refs/heads/approved"]);
  await denyC(original, `${dir}/a`);
  await verifyCallbackCount();
  if (!replace) {
    assert.equal(await network.ref("fixture/a", "refs/heads/approved"), undefined);
    return { originalIndex, replacementIndex: undefined };
  }
  const successor = await replace(originalIndex);
  const replacement = successor.target;
  const main = "refs/heads/main";
  const approved = "refs/heads/approved";
  const retained = [
    ["a", main, origin.initialSha],
    ["b", approved, pushed],
  ] as const;
  const fetchStart = network.requests().length;
  for (const [name, ref, expected] of retained) {
    const before: number = network.requests().length;
    const local = `/tmp/fresh-${name}`;
    const result = await gitScript(
      replacement,
      `test ! -e '${local}'; git init -q --initial-branch=acl-empty '${local}';
git -C '${local}' fetch -q '${repositoryUrl(name)}' '${ref}:${ref}';
git -C '${local}' rev-parse '${ref}^{commit}'`,
    );
    assert.ok(result.stdout.toString("utf8").trim() === expected, "ACL_DOWNGRADE_FETCH_REF");
    assert.ok(
      network
        .requests()
        .slice(before)
        .some(
          (entry) =>
            entry.repository === `fixture/${name}` &&
            entry.operation === "upload-pack" &&
            entry.authenticated,
        ),
      "ACL_DOWNGRADE_FRESH_FETCH_ORIGIN",
    );
  }
  const replacementIndex = successor.credentialIndex;
  assert.equal(issuedIndex(fetchStart), replacementIndex);
  if (lent) {
    // A token source lends the same Secret value to every revision until it is replaced.
    assert.equal(replacementIndex, originalIndex, "TOKEN_REDEPLOY_SAME_SOURCE");
  } else {
    assert.notEqual(replacementIndex, originalIndex, "redeploy must issue a new credential");
  }
  for (const [name, ref, expected] of retained) {
    // Make a real fast-forward candidate so a no-op or cached object cannot
    // count as an enforced write denial.
    const local = `/tmp/fresh-${name}`;
    const result = await gitScript(
      replacement,
      `git -C '${local}' checkout -q --detach '${ref}';
printf '%s\\n' acl-downgrade > '${local}/acl-downgrade';
git -C '${local}' add acl-downgrade;
git -C '${local}' -c user.name=Fixture -c user.email=fixture@example.test commit -q -m acl-downgrade;
git -C '${local}' rev-parse HEAD HEAD^`,
    );
    const candidate = result.stdout.toString("utf8").trim().split("\n");
    const [attempted, parent] = candidate;
    assert.ok(
      candidate.length === 2 && attempted && /^[a-f0-9]{40}$/.test(attempted),
      "ACL_DOWNGRADE_CANDIDATE",
    );
    assert.ok(parent === expected && attempted !== expected, "ACL_DOWNGRADE_CANDIDATE_PARENT");
    const repository = `fixture/${name}`;
    assert.equal(await network.hasObject(repository, attempted), false);
    await denyGit(replacement, ["-C", local, "push", "-q", repositoryUrl(name), `HEAD:${ref}`]);
    assert.equal(await network.ref(repository, ref), expected);
    assert.equal(await network.hasObject(repository, attempted), false);
  }
  await denyC(replacement, "/tmp/fresh-a");
  for (const request of requests) {
    if (request.service === "upload") {
      await allowReplay(replacement, replacementIndex, "a", request);
      await allowReplay(replacement, replacementIndex, "b", request);
    }
    const deniedRepositories =
      request.service === "upload" ? (["c"] as const) : (["a", "b", "c"] as const);
    for (const repository of deniedRepositories) {
      await denyReplay(replacement, replacementIndex, repository, request);
    }
  }
  await allowReplay(replacement, replacementIndex, "a", requests[0]);
  await allowReplay(replacement, replacementIndex, "b", requests[0]);
  await verifyCallbackCount();
  assert.equal(await network.ref("fixture/a", main), origin.initialSha);
  assert.equal(await network.ref("fixture/a", approved), undefined);
  assert.equal(await network.ref("fixture/b", approved), pushed);
  t.diagnostic("Saved Git ACL downgrade kept A/B reads and refused A/B writes and all C routes");
  return { originalIndex, replacementIndex };
}

/**
 * The repository credential source of a journey: the controlled GitHub App issuer, or an
 * operator's fine-grained token in the Installation's token Secret (fake values only), with the
 * second fine-grained value that replaces it and the classic value the Worker must refuse.
 */
type JourneyCredential =
  { kind: "app" } | { kind: "token"; value: string; replacement: string; classic: string };

function fakeTokenCredential(): JourneyCredential {
  const fake = (prefix: string) => `${prefix}FAKE0${randomBytes(24).toString("hex")}`;
  return {
    kind: "token",
    value: fake("github_pat_"),
    replacement: fake("github_pat_"),
    classic: fake("ghp_"),
  };
}

/** A lent token is never issued: the deploy must not mint, and Git carries the lent value. */
async function deployWithLentToken(
  origin: GitOrigin,
  deploy: () => Promise<Deployed>,
  credentialIndex: number,
): Promise<IssuedDeployment> {
  const issued = origin.snapshot().issued;
  const deployed = await deploy();
  assert.equal(origin.snapshot().issued, issued, "TOKEN_DEPLOY_ISSUES_NOTHING");
  return { ...deployed, credentialIndex };
}

/**
 * Digest search for token values in the workload: every readable process environment and
 * argument list, the effective Git configuration, and the files under the workload's writable and
 * configuration roots. Each fingerprint carries a public prefix (the token class prefix, or the
 * Base64 of `x-access-token:`) so the guest hashes only candidate offsets. Only counts and the
 * categories with a hit leave the guest.
 */
function tokenFingerprints(values: readonly string[]) {
  const digest = (form: string) => createHash("sha256").update(form).digest("hex");
  return values.flatMap((value) => {
    const basic = Buffer.from(`x-access-token:${value}`).toString("base64");
    return [
      [Buffer.byteLength(value), digest(value), value.slice(0, value.indexOf("_") + 1)],
      [Buffer.byteLength(basic), digest(basic), basic.slice(0, 20)],
    ] as const;
  });
}

function searchWorkloadForTokens() {
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const childProcess = require("node:child_process");
  const prints: [number, string, string][] = JSON.parse(process.argv[1] ?? "[]");
  const hit = (buffer: Buffer) =>
    prints.some(([length, hex, prefix]) => {
      for (let at = buffer.indexOf(prefix); at !== -1; at = buffer.indexOf(prefix, at + 1)) {
        const candidate = buffer.subarray(at, at + length);
        if (
          candidate.length === length &&
          crypto.createHash("sha256").update(candidate).digest("hex") === hex
        ) {
          return true;
        }
      }
      return false;
    });
  const found = new Set<string>();
  const counts = { environ: 0, cmdline: 0, gitconfig: 0, files: 0, bytes: 0, skipped: 0 };
  for (const pid of fs.readdirSync("/proc").filter((name: string) => /^\d+$/.test(name))) {
    for (const kind of ["environ", "cmdline"] as const) {
      try {
        const buffer = fs.readFileSync(`/proc/${pid}/${kind}`);
        counts[kind] += 1;
        if (hit(buffer)) found.add(kind);
      } catch {}
    }
  }
  try {
    const config = childProcess.execFileSync("git", ["config", "--list", "--show-origin"], {
      cwd: "/",
      stdio: ["ignore", "pipe", "ignore"],
    });
    counts.gitconfig += 1;
    if (hit(config)) found.add("gitconfig");
  } catch {}
  const roots = new Set(
    ["/sandbox", "/home", "/root", "/tmp", "/var/tmp", "/etc", "/run", process.env.HOME]
      .concat(process.cwd())
      .filter((root): root is string => typeof root === "string" && root.length > 0),
  );
  const seen = new Set<string>();
  const walk = (path: string) => {
    if (counts.files >= 20_000 || seen.has(path)) return;
    seen.add(path);
    let stat;
    try {
      stat = fs.lstatSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(path);
      } catch {
        counts.skipped += 1;
      }
      for (const name of names) walk(path === "/" ? `/${name}` : `${path}/${name}`);
    } else if (stat.isFile()) {
      if (stat.size > 4 * 1024 * 1024) {
        counts.skipped += 1;
        return;
      }
      try {
        const buffer = fs.readFileSync(path);
        counts.files += 1;
        counts.bytes += buffer.length;
        if (hit(buffer)) found.add(path.startsWith("/tmp/") ? "file:/tmp" : `file:${path}`);
      } catch {
        counts.skipped += 1;
      }
    }
  };
  for (const root of roots) walk(root);
  process.stdout.write(JSON.stringify({ found: [...found].sort(), ...counts }));
}

async function assertTokensAbsentFromWorkload(
  t: TestContext,
  execute: GitExec,
  target: GitTarget,
  values: readonly string[],
  stage: string,
) {
  const script = `(${searchWorkloadForTokens.toString()})()`;
  const result = await execute(target, [
    "node",
    "--eval",
    script,
    "--",
    JSON.stringify(tokenFingerprints(values)),
  ]);
  const report = JSON.parse(result.stdout.toString("utf8"));
  t.diagnostic(
    JSON.stringify({
      event: "saved-git-token-digest-search",
      stage,
      sandbox: savedGitAclIdentity(target.sandboxId),
      ...report,
    }),
  );
  assert.ok(report.environ > 0 && report.cmdline > 0 && report.files > 0, "TOKEN_SEARCH_COVERAGE");
  assert.equal(report.gitconfig, 1, "TOKEN_SEARCH_GIT_CONFIG");
  assert.deepEqual(report.found, [], "TOKEN_ABSENT_FROM_WORKLOAD");
}

function patchTokenSecret(fixture: GitInstallation, value: string) {
  return fixture.kube(
    [
      "patch",
      "secret",
      "git-fixture-token",
      "-n",
      fixture.platform,
      "--type=merge",
      "--patch-file=/dev/stdin",
    ],
    { input: JSON.stringify({ stringData: { token: value } }) },
  );
}

/**
 * The Worker refuses a classic token at its next loan: its log names the code, reason and class
 * (never the value), and the Agent's Git stops working. Each outcome is its own assertion; the
 * measured times are reported before any of them can fail.
 */
async function refuseClassicToken(
  t: TestContext,
  fixture: GitInstallation,
  target: GitTarget,
  execute: GitExec,
  credential: Extract<JourneyCredential, { kind: "token" }>,
) {
  const origin: GitOrigin = fixture.origin;
  const network = origin.network;
  assert.ok(network);
  const code = "PREPARED_GITHUB_TOKEN_REFUSED";
  const workerLogs = () =>
    fixture.kube(
      [
        "logs",
        "-n",
        fixture.platform,
        "-l",
        "app.kubernetes.io/instance=openclaw-enterprise,app.kubernetes.io/component=worker",
        "--tail=-1",
        "--max-log-requests=10",
      ],
      { timeout: 60_000 },
    );
  const valuesAbsent = (logs: string) => {
    for (const value of [credential.value, credential.replacement, credential.classic]) {
      assert.ok(!logs.includes(value), "TOKEN_VALUE_NOT_LOGGED");
    }
  };
  const refusals = (logs: string) =>
    logs.split("\n").flatMap((line) => {
      if (!line.includes(code)) return [];
      try {
        const event = asRecord(JSON.parse(line.slice(line.indexOf("{"))));
        return [{ code: event?.code, reason: event?.reason, tokenClass: event?.tokenClass }];
      } catch {
        return [{ code: "unparsed", reason: undefined, tokenClass: undefined }];
      }
    });
  const baseline = await workerLogs();
  valuesAbsent(baseline);
  assert.deepEqual(refusals(baseline), [], "TOKEN_NO_REFUSAL_BEFORE_CLASSIC");

  const patchedAt = Date.now();
  await patchTokenSecret(fixture, credential.classic);
  let logs = "";
  const refused = await observeUntil(
    "TOKEN_CLASSIC_REFUSED_LOGGED",
    t.signal,
    async () => {
      logs = await workerLogs();
      const found = refusals(logs);
      return found.length > 0 ? found : undefined;
    },
    10 * 60_000,
  );
  const loggedSeconds = (Date.now() - patchedAt) / 1000;
  const repository = "https://github.com/fixture/a.git";
  const probe = createGitAclDenialCommand(network.issuedCredentialFingerprints());
  let attempts = 0;
  let last: { answer: string; indices: (number | undefined)[]; requests: number } | undefined;
  let gitFailedSeconds: number | undefined;
  try {
    await observeUntil(
      "TOKEN_CLASSIC_GIT_FAILS",
      t.signal,
      async () => {
        attempts += 1;
        const before = network.requests().length;
        const result = await execute(
          target,
          probe({ kind: "success" }, [
            "sh",
            "-c",
            `if git ls-remote '${repository}' >/dev/null 2>&1; then echo ok; else echo failed; fi`,
          ]),
        );
        const observed = network.requests().slice(before);
        last = {
          answer: result.stdout.toString("utf8").trim(),
          indices: [...new Set(observed.map(({ credentialIndex }) => credentialIndex))],
          requests: observed.length,
        };
        if (last.answer === "failed") {
          gitFailedSeconds = (Date.now() - patchedAt) / 1000;
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return undefined;
      },
      5 * 60_000,
    );
  } finally {
    t.diagnostic(
      JSON.stringify({
        event: "saved-git-token-classic-refusal",
        loggedSeconds,
        refusals: refused.length,
        first: refused[0],
        gitAttempts: attempts,
        gitFailedSeconds,
        lastGit: last,
      }),
    );
  }
  valuesAbsent(logs);
  valuesAbsent(await workerLogs());
  assert.ok(
    refused.every(
      (event) =>
        event.code === code && event.tokenClass === "classic" && typeof event.reason === "string",
    ),
    "TOKEN_CLASSIC_REFUSED_CLASS",
  );
  assert.equal(last?.answer, "failed", "TOKEN_CLASSIC_GIT_FAILS");
  await assertTokensAbsentFromWorkload(
    t,
    execute,
    target,
    [credential.value, credential.replacement, credential.classic],
    "classic",
  );
}

async function savedAgentGitJourney(t: TestContext, credential: JourneyCredential) {
  assert.ok(selected, "Select the owned Kubernetes/OpenShell installation");
  for (const setting of ["OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_KUBERNETES_RUNTIME_IMAGE"]) {
    assert.ok(
      /^[^@\s]+@sha256:[a-f0-9]{64}$/.test(process.env[setting] ?? ""),
      `${setting} must select a digest-pinned image for saved Agent validation`,
    );
  }
  assert.equal(
    process.env.OCC_DEVELOPMENT_STATE_DIRECTORY,
    undefined,
    "The saved ACL case must create and own a fresh installation",
  );
  assert.ok(
    process.env.OPENAI_API_KEY === "fixture-only-no-model-call" &&
      (process.env.CODEX_ACCESS_TOKEN === undefined ||
        process.env.CODEX_ACCESS_TOKEN === "fixture-only-no-model-call"),
    "Use the inert Local Setup credential with the synthetic startup model",
  );
  const app = credential.kind === "app";
  const fixture = await createOpenShellGitInstallation(t, {
    nativeGit: true,
    ...(credential.kind === "token" && { tokenSource: credential.value }),
  });
  const { callbacks, gatewayClient, workspace, request } = fixture;
  assert.ok(callbacks);
  const origin: GitOrigin = fixture.origin;
  const network = origin.network;
  assert.ok(network && network.token === undefined, "Require the controlled App issuer");
  assert.deepEqual(network.repositories, ["fixture/a", "fixture/b", "fixture/c"]);
  // The origin accepts the operator's token as one static credential; nothing is issued.
  let lentIndex = 0;
  if (!app) {
    const accepted = origin.snapshot();
    assert.equal(accepted.issued, 0);
    assert.equal(accepted.tokens.length, 1, "TOKEN_ORIGIN_ACCEPTS_ONE_VALUE");
    lentIndex = accepted.tokens[0]!.index;
  }
  const deployWith = (run: () => Promise<Deployed>) =>
    app ? deployWithIssuance(origin, run) : deployWithLentToken(origin, run, lentIndex);

  const refs = network.scopes.map(({ repositoryRef }) => repositoryRef);
  const prepareAgent = (installation: GitInstallation) =>
    prepareFiniteGitAgent(t, installation, refs);
  const { agent, path, deploy } = await prepareAgent(fixture);
  const deployPolicy = () => deployWith(deploy);
  const policyPath = `${path}/sandbox-policy/networking`;
  await request("PATCH", `${policyPath}/editing`, { enabled: true });
  const readPolicy = async (): Promise<SandboxPolicyViewWire> => request("GET", policyPath);
  const initial = await readPolicy();
  assert.equal(initial.editingEnabled, true);
  assert.equal(initial.repositoryNetworkPolicySaveSupported, true);
  assert.deepEqual(
    initial.repositoryNetworkPolicyCeiling,
    network.repositories.map((repository) => ({ repository, access: "write" })),
    "The operator's ceiling and Namespace registry must approve A, B and C",
  );
  assert.equal(initial.policy.repositoryNetworkPolicy, undefined);
  assert.equal(initial.defaultsRevisionId, undefined);
  assert.equal(initial.deployedPolicyVersion, undefined);
  const save = async (
    previous: SandboxPolicyViewWire,
    grants: readonly RepositoryNetworkGrant[],
  ) => {
    const saved: SandboxPolicyViewWire["policy"] = await request("PUT", policyPath, {
      expectedVersion: previous.policy.version,
      additions: previous.policy.additions,
      repositoryNetworkPolicy: grants,
    });
    assert.equal(saved.version, previous.policy.version + 1);
    assert.equal(saved.agentId, agent.id);
    assert.deepEqual(saved.repositoryNetworkPolicy, grants);
    const read = await readPolicy();
    assert.equal(read.defaultsRevisionId, previous.defaultsRevisionId);
    assert.equal(read.deployedPolicyVersion, previous.deployedPolicyVersion);
    assert.deepEqual(read.policy, saved);
    return saved;
  };

  const primary = { workspace, policyPath };
  const loadPolicy = async (
    deployed: Awaited<ReturnType<typeof deploy>>,
    desired: SandboxPolicyViewWire["policy"],
    mode: "permissive" | "read-write" | "read-only" | "peer",
    { workspace, policyPath } = primary,
  ) => {
    const { target, revision } = deployed;
    const [view, status, config] = await Promise.all([
      request("GET", policyPath) as Promise<SandboxPolicyViewWire>,
      gatewayClient.getSandboxPolicyStatus(workspace, target.sandboxName, t.signal),
      gatewayClient.getSandboxConfig(workspace, target.sandboxName, t.signal),
    ]);
    const serving = await deployed.readExecution();
    assert.deepEqual(serving.identity, deployed.original.identity);
    assert.equal(view.defaultsRevisionId, revision.id);
    assert.equal(view.deployedPolicyVersion, desired.version);
    assert.deepEqual(view.policy.repositoryNetworkPolicy, desired.repositoryNetworkPolicy);
    const loaded = asRecord(status.revision);
    assert.ok(loaded && Number.isSafeInteger(loaded.version));
    assert.equal(loaded.status, "POLICY_STATUS_LOADED");
    assert.ok(!loaded.load_error);
    assert.equal(status.active_version, loaded.version);
    assert.equal(config.version, loaded.version);
    assert.equal(config.workspace, workspace);
    assert.equal(config.configuration_admitted, true);
    assert.equal(config.policy_validation_failure_mode, "fail_closed");
    assertGitCallbackEndpoint(config.supervisor_middleware_services, callbacks.endpoint);
    const admitted = serving.sandbox.configurationAdmission;
    assert.ok(admitted && admitted.state === 2);
    assert.equal(admitted.instance_id, config.configuration_instance_id);
    assert.equal(admitted.policy_version, config.version);
    assert.equal(admitted.policy_hash, config.policy_hash);
    assert.equal(admitted.config_revision, config.config_revision);
    assert.equal(admitted.provider_env_revision, config.provider_env_revision);
    assert.equal(serving.sandbox.spec?.provider_attachment_epoch, config.provider_attachment_epoch);
    for (const identity of [
      config.configuration_instance_id,
      config.policy_hash,
      config.config_revision,
      config.provider_env_revision,
      config.provider_attachment_epoch,
    ]) {
      assert.ok(
        typeof identity === "string" && identity.length > 0,
        "missing loaded policy identity",
      );
    }

    // Require one private Git route with exact method, path, and service
    // grants. This expectation derives from the scenario's independent
    // A/B/C oracle and never calls the product policy compiler.
    const rules = asRecord(asRecord(config.policy)?.network_policies);
    assert.ok(rules);
    const github = Object.entries(rules).flatMap(([name, rule]) => {
      const endpoints = asRecord(rule)?.endpoints ?? [];
      assert.ok(Array.isArray(endpoints));
      return endpoints
        .map(asRecord)
        .filter(
          (endpoint) =>
            typeof endpoint?.host === "string" &&
            (endpoint.host === "*" || /(?:^|[.])github[.]com$/iu.test(endpoint.host)),
        )
        .map((endpoint) => ({ name, endpoint }));
    });
    const grants = desired.repositoryNetworkPolicy;
    assert.ok(grants);
    assert.equal(github.length, grants.length);
    const git = github.find(({ endpoint }) => endpoint?.host === "github.com");
    assert.ok(git?.endpoint && desired.repositoryNetworkPolicy);
    const providers = serving.sandbox.spec?.providers;
    const provider = asRecord(git.endpoint.credential_binding)?.provider;
    assert.ok(typeof provider === "string" && provider.length > 0);
    assert.ok(providers?.includes(provider), "Git binding must name an attached Provider");
    assert.equal(git.name, "repository-git-network");
    const sourceRules = asRecord(asRecord(loaded.policy)?.network_policies);
    const source = asRecord(sourceRules?.[git.name]);
    const sourceEndpoints = source?.endpoints;
    assert.ok(Array.isArray(sourceEndpoints));
    assert.equal(sourceEndpoints.length, github.length);
    const expectedEffective = {
      ...source,
      endpoints: sourceEndpoints.map((raw: unknown) => {
        const endpoint = asRecord(raw);
        assert.ok(endpoint);
        assert.deepEqual(endpoint.credential_binding, { provider });
        assert.ok(!endpoint.provider_credentialed && !endpoint.token_grant_owner);
        return { ...endpoint, provider_credentialed: true };
      }),
    };
    assert.ok(
      isDeepStrictEqual(wirePolicy(rules[git.name]), wirePolicy(expectedEffective)),
      "Effective Git endpoints must retain the exact Sandbox credential bindings",
    );

    const [attached, profile] = await Promise.all([
      gatewayClient.getProvider(workspace, provider, t.signal),
      gatewayClient.getProviderProfile(workspace, provider, t.signal),
    ]);
    assert.equal(attached?.type, provider);
    assert.ok(profile?.definition);
    assert.ok(attached.id);
    assert.match(profile.resourceVersion, /^[1-9]\d*$/);
    assert.equal(
      await gatewayClient.readExclusivePreviewWorkspace(
        workspace,
        target.sandboxId,
        t.signal,
        provider,
      ),
      true,
    );

    assert.match(attached.resourceVersion, /^[1-9]\d*$/);
    const identity = {
      providerId: attached.id,
      profileVersion: profile.resourceVersion,
      resourceVersion: attached.resourceVersion,
    };
    assert.deepEqual(profile.definition.endpoints ?? [], []);
    assert.deepEqual(profile.definition.binaries ?? [], []);
    const providerRuleName = "_provider_" + provider.replaceAll("-", "_");
    assert.deepEqual(
      wirePolicy(rules[providerRuleName]),
      { name: providerRuleName },
      "The attached Git Provider must contribute an empty policy layer",
    );
    const gitEndpoints = [];
    for (const { name, endpoint } of github) {
      assert.ok(name === git.name && endpoint);
      assert.equal(endpoint.host, "github.com");
      gitEndpoints.push(endpoint);
      assert.equal(endpoint.port, 443);
      assert.equal(endpoint.protocol, "rest");
      assert.equal(endpoint.enforcement, "NETWORK_ENFORCEMENT_MODE_ENFORCE");
      assert.equal(endpoint.provider_credentialed, true);
      assert.ok(!endpoint.allow_uninspected_credentials);
      assert.ok(endpoint.tls === undefined || endpoint.tls === "NETWORK_TLS_MODE_UNSPECIFIED");
    }
    const expected = grants.map(({ repository, access }) => {
      const services =
        access === "write" ? ["git-upload-pack", "git-receive-pack"] : ["git-upload-pack"];
      const rules = services.flatMap((service) => [
        {
          allow: {
            method: "GET",
            path: `/${repository}.git/info/refs`,
            query: { service: { glob: service } },
          },
        },
        { allow: { method: "POST", path: `/${repository}.git/${service}` } },
      ]);
      return { path: `/${repository}.git/**`, rules };
    });
    assert.deepEqual(
      wirePolicy(gitEndpoints.map(({ path, rules }) => ({ path, rules }))),
      wirePolicy(expected),
    );
    const generation = {
      ...identity,
      provider,
      hash: config.policy_hash,
      configInstance: config.configuration_instance_id,
      configRevision: config.config_revision,
      providerRevision: config.provider_env_revision,
      attachmentEpoch: config.provider_attachment_epoch,
    };
    // The manual receipt carries only identity digests and observed counters.
    t.diagnostic(
      JSON.stringify({
        event: "saved-git-acl-installed",
        generation: savedGitAclIdentity(generation),
        mode,
        agent: savedGitAclIdentity(deployed.agent.id),
        revision: savedGitAclIdentity(revision.id),
        sandbox: savedGitAclIdentity(target.sandboxId),
        savedVersion: desired.version,
        policyVersion: loaded.version,
      }),
    );
    return generation;
  };

  // Observe the actual deployment owner's cleanup through independent runtime,
  // Kubernetes, Provider, profile and issuer channels.
  const retire = async (
    deployed: Deployed,
    providerName: string,
    index: number,
    owner = { path, workspace, agentId: agent.id },
  ) => {
    await observeUntil("retirement of the loaded Agent revision", t.signal, async () => {
      const deployment: AgentDeploymentStatusWire = await request(
        "GET",
        `${owner.path}/deployments/${deployed.revision.id}`,
      );
      assert.notEqual(deployment.cleanup?.status, "failed");
      const sandbox = await gatewayClient.getSandbox(
        { workspace: owner.workspace, name: deployed.target.sandboxName },
        t.signal,
      );
      assert.ok(sandbox === undefined || sandbox.id === deployed.target.sandboxId);
      const ownedResource = await fixture.kube([
        "get",
        "sandboxes.agents.x-k8s.io",
        deployed.target.sandboxName,
        "-n",
        owner.workspace,
        "--ignore-not-found",
        "-o",
        "name",
      ]);
      const podIds = await fixture.kube([
        "get",
        "pods",
        "-n",
        owner.workspace,
        "-o",
        'jsonpath={range .items[*]}{.metadata.uid}{" "}{.metadata.ownerReferences[*].uid}{" "}{end}',
      ]);
      const previous = deployed.original.identity;
      const identities = new Set(podIds.split(/\s+/u));
      const priorPods = [
        previous.sandboxUid,
        previous.podUid,
        deployed.supervisor.supervisorPodUid,
      ];
      const provider = await gatewayClient.getProvider(owner.workspace, providerName, t.signal);
      const profile = await gatewayClient.getProviderProfile(
        owner.workspace,
        providerName,
        t.signal,
      );
      const credential = origin.snapshot().tokens.find((token) => token.index === index);
      return deployment.cleanup?.status === "succeeded" &&
        !sandbox &&
        ownedResource.trim() === "" &&
        priorPods.every((id) => !identities.has(id)) &&
        !provider &&
        !profile &&
        // A lent token is the operator's to revoke at GitHub; retirement removes its route.
        (app ? credential?.revoked === true : credential?.revoked === false)
        ? true
        : undefined;
    });
    const revoked = app
      ? await network.probeIssued(index, "fixture/b", {
          method: "GET",
          service: "git-upload-pack",
        })
      : undefined;
    if (app) {
      assert.deepEqual(revoked, { status: 401, type: "application/json" });
    }
    t.diagnostic(
      JSON.stringify({
        event: "saved-git-acl-retired",
        agent: savedGitAclIdentity(owner.agentId),
        revision: savedGitAclIdentity(deployed.revision.id),
        sandbox: savedGitAclIdentity(deployed.target.sandboxId),
        credentialIndex: index,
        originStatus: revoked?.status,
      }),
    );
  };
  // First-save and rollout are separate mutations. Saving must not admit
  // a revision or silently change the revision that serves the saved Agent.
  assert.deepEqual(await request("GET", `${path}/revisions`), []);
  const managed = createManagedWorkloadExec(t, {
    backend: fixture.gatewayBackend,
    gatewayClient,
    workspace,
    checkpoint: fixture.checkpoint,
  });
  const deadlines = new Map<string, number>();
  const requireTimelyGit = (target: GitTarget) => {
    const deadline = deadlines.get(target.sandboxId);
    assert.ok(
      deadline !== undefined && Date.now() < deadline,
      "The exact finite Git grant must be active",
    );
  };
  const exec: GitExec = async (target, command) => {
    requireTimelyGit(target);
    const result = await managed(target, command);
    for (const output of [result.stdout, result.stderr]) {
      assert.ok(!network.containsIssuedCredential(output), "ACL_CREDENTIAL_IN_OUTPUT");
    }
    requireTimelyGit(target);
    return result;
  };

  const stop = async (target: Deployed) => {
    const revisionId = encodeURIComponent(target.revision.id);
    const stopped = await request(
      "POST",
      `${target.path}/stop?expectedActiveRevisionId=${revisionId}`,
    );
    assert.equal(stopped.desiredRuntimeState, "stopped");
  };
  // The legacy callback route serves App installation tokens only; a token source lends to
  // native Git alone, so its journey starts at the saved policy.
  let legacyAttempts: number | undefined;
  if (app) {
    const legacy = await prepareAgent(fixture);
    const control = await deployWithIssuance(origin, legacy.deploy);
    const view: SandboxPolicyViewWire = await request(
      "GET",
      `${legacy.path}/sandbox-policy/networking`,
    );
    assert.equal(view.policy.repositoryNetworkPolicy, undefined);
    const legacyExec = createManagedWorkloadExec(t, {
      backend: fixture.gatewayBackend,
      gatewayClient,
      workspace,
      checkpoint: fixture.checkpoint,
    });
    const legacyConfig = await gatewayClient.getSandboxConfig(
      workspace,
      control.target.sandboxName,
      t.signal,
    );
    assertGitCallbackEndpoint(legacyConfig.supervisor_middleware_services, callbacks.endpoint);
    const callsBefore = await callbacks.read();
    const originBefore = network.requests().length;
    const fetch = await legacyExec(
      control.target,
      createGitAclDenialCommand(network.issuedCredentialFingerprints())({ kind: "success" }, [
        "sh",
        "-ceu",
        `export LC_ALL=C
git clone -q https://github.com/fixture/a.git /tmp/legacy-control
git -C /tmp/legacy-control fetch -q origin refs/heads/main
git -C /tmp/legacy-control rev-parse FETCH_HEAD`,
      ]),
    );
    assert.ok(fetch.stdout.toString("utf8").trim() === origin.initialSha);
    const callsAfter = await callbacks.read();
    assert.ok(callsAfter > callsBefore, "Legacy Git must reach the enabled authorization callback");
    const indices = new Set(
      network
        .requests()
        .slice(originBefore)
        .filter(
          (entry) =>
            entry.repository === "fixture/a" &&
            entry.operation === "upload-pack" &&
            entry.authenticated,
        )
        .map(({ credentialIndex }) => credentialIndex),
    );
    const [index] = indices;
    assert.ok(indices.size === 1 && typeof index === "number");
    assert.equal(index, control.credentialIndex);
    const box = await gatewayClient.getSandbox(
      { workspace, name: control.target.sandboxName },
      t.signal,
    );
    assert.equal(box?.id, control.target.sandboxId);
    const providers = box?.spec?.providers;
    assert.ok(Array.isArray(providers));
    const gitProviders = providers.filter(
      (name): name is string =>
        typeof name === "string" && name.startsWith("oce-github-installation-"),
    );
    assert.equal(gitProviders.length, 1);
    await stop(control);
    await retire(control, gitProviders[0]!, index, {
      path: legacy.path,
      workspace,
      agentId: legacy.agent.id,
    });
    legacyAttempts = callsAfter - callsBefore;
  }

  const denied = await prepareAgent(fixture);
  const deniedPath = `${denied.path}/sandbox-policy/networking`;
  await request("PATCH", `${deniedPath}/editing`, { enabled: true });
  const initialDeniedPolicy: SandboxPolicyViewWire = await request("GET", deniedPath);
  await request("PUT", deniedPath, {
    expectedVersion: initialDeniedPolicy.policy.version,
    additions: initialDeniedPolicy.policy.additions,
    repositoryNetworkPolicy: [],
  });
  const savedDeniedPolicy: SandboxPolicyViewWire = await request("GET", deniedPath);
  assert.deepEqual(savedDeniedPolicy.policy.repositoryNetworkPolicy, []);
  const issuedBeforeDenial = origin.snapshot().issued;
  await request("POST", `${denied.path}/deploy`, undefined, emptyDeployRefusal);
  assert.equal(origin.snapshot().issued, issuedBeforeDenial);
  assert.deepEqual(await request("GET", `${denied.path}/revisions`), []);

  const nativeCallbackBaseline = await callbacks.disable();
  assert.equal(nativeCallbackBaseline, 0);
  t.diagnostic(
    JSON.stringify({
      event: "saved-git-acl-callback-calibration",
      legacyAttempts,
      nativeBaseline: nativeCallbackBaseline,
    }),
  );

  const desired = await save(
    initial,
    network.repositories.map((repository) => ({
      repository,
      access: "write" as const,
    })),
  );
  assert.deepEqual(await request("GET", `${path}/revisions`), []);
  const deployed = await deployPolicy();
  deadlines.set(deployed.target.sandboxId, deployed.deadlineWallMs);
  const loaded = await loadPolicy(deployed, desired, "permissive");
  await calibratePermissiveSavedGit(t, fixture, exec, deployed);
  const permissive = { deployed, provider: loaded.provider, index: deployed.credentialIndex };
  assert.equal(await callbacks.read(), nativeCallbackBaseline);

  const write = await save(await readPolicy(), [
    { repository: "fixture/a", access: "read" },
    { repository: "fixture/b", access: "write" },
  ]);
  // Count all parsed origin HTTP, including anonymous and rejected Git.
  // Successful App token issuance is the only expected origin HTTP during startup.
  const beforeDeploy = origin.snapshot();
  const beforeDeployGit = network.requests().length;
  if (app) {
    network.shortenNextTokenForRenewal();
  }
  let original = await deployPolicy();
  const afterDeploy = origin.snapshot();
  const appIssuances =
    (afterDeploy.endpoints["issue:201"] ?? 0) - (beforeDeploy.endpoints["issue:201"] ?? 0);
  const originHttp = afterDeploy.requests - beforeDeploy.requests;
  t.diagnostic(
    JSON.stringify({
      event: "saved-git-acl-startup-origin",
      revision: savedGitAclIdentity(original.revision.id),
      originHttp,
      appIssuances,
    }),
  );
  if (app) {
    assert.ok(appIssuances > 0, "Expected App issuance during held deployment");
  } else {
    assert.equal(appIssuances, 0, "TOKEN_DEPLOY_ISSUES_NOTHING");
  }
  assert.equal(network.requests().length, beforeDeployGit, "Unexpected Git HTTP during redeploy");
  assert.equal(await callbacks.read(), nativeCallbackBaseline);
  await retire(permissive.deployed, permissive.provider, permissive.index);
  const installed = await loadPolicy(original, write, "read-write");
  deadlines.set(original.target.sandboxId, original.deadlineWallMs);
  if (app) {
    const index = original.credentialIndex;
    const before = origin.snapshot();
    const token = before.tokens.find((candidate) => candidate.index === index);
    assert.ok(token && !token.revoked);
    const { resourceVersion, providerRevision, ...binding } = installed;
    assert.ok(resourceVersion && binding.providerId);
    await exerciseSavedGitAcl(t, fixture, exec, original, undefined, nativeCallbackBaseline);
    const next = await observeUntil("same-grant Git credential renewal", t.signal, async () => {
      requireTimelyGit(original.target);
      const snapshot = origin.snapshot();
      assert.ok(snapshot.issued <= before.issued + 1, "Unexpected token issuance during renewal");
      const current = snapshot.tokens.find((candidate) => candidate.index > index);
      if (!current || !snapshot.tokens.find((candidate) => candidate.index === index)?.revoked) {
        return undefined;
      }
      const box = await gatewayClient.getSandbox(
        { workspace, name: original.target.sandboxName },
        t.signal,
      );
      assert.equal(box?.id, original.target.sandboxId);
      const admission = box.configurationAdmission;
      return admission?.state === 2 &&
        admission.provider_env_revision &&
        admission.provider_env_revision !== providerRevision
        ? current
        : undefined;
    });
    assert.ok(
      Date.now() < token.expires,
      "The first credential must retire ahead of its issuer expiry",
    );
    assert.ok(!next.revoked && next.expires > token.expires);
    assert.deepEqual(next.repositoryIds, token.repositoryIds);
    assert.deepEqual(next.permissions, token.permissions);
    const {
      resourceVersion: updated,
      providerRevision: environment,
      ...rotated
    } = await loadPolicy(original, write, "read-write");
    assert.deepEqual(rotated, binding, "Renewal must keep the same policy and attached Provider");
    assert.ok(updated && BigInt(updated) > BigInt(resourceVersion));
    assert.notEqual(environment, providerRevision);
    const old = await network.probeIssued(index, "fixture/b", {
      method: "GET",
      service: "git-upload-pack",
    });
    assert.deepEqual(old, { status: 401, type: "application/json" });
    original = { ...original, credentialIndex: next.index };
    assert.equal(await callbacks.read(), nativeCallbackBaseline);
    t.diagnostic(
      JSON.stringify({
        event: "saved-git-acl-rotation",
        revision: savedGitAclIdentity(original.revision.id),
        binding: savedGitAclIdentity(binding),
        previousIndex: index,
        credentialIndex: next.index,
        previousVersion: resourceVersion,
        currentVersion: updated,
        oldStatus: old.status,
      }),
    );
  } else {
    assert.ok(credential.kind === "token");
    const index = original.credentialIndex;
    const { resourceVersion, providerRevision, ...binding } = installed;
    assert.ok(resourceVersion && binding.providerId);
    await exerciseSavedGitAcl(t, fixture, exec, original, undefined, nativeCallbackBaseline, true);
    await assertTokensAbsentFromWorkload(
      t,
      exec,
      original.target,
      [credential.value],
      "read-write",
    );
    // Replace the Secret's value with a second fine-grained token, without a redeploy: the
    // Worker reads the projected file at each loan and the runtime re-reads its material on
    // every refresh tick. Measure from the patch to the rotated Provider environment.
    const next = network.acceptStaticToken(credential.replacement);
    const issued = origin.snapshot().issued;
    const patchStartedAt = Date.now();
    await patchTokenSecret(fixture, credential.replacement);
    const patchedAt = Date.now();
    const deliveredAt = await observeUntil(
      "TOKEN_REPLACEMENT_DELIVERED",
      t.signal,
      async () => {
        requireTimelyGit(original.target);
        const box = await gatewayClient.getSandbox(
          { workspace, name: original.target.sandboxName },
          t.signal,
        );
        assert.equal(box?.id, original.target.sandboxId, "TOKEN_REPLACEMENT_NO_REDEPLOY");
        const admission = box.configurationAdmission;
        return admission?.state === 2 &&
          admission.provider_env_revision &&
          admission.provider_env_revision !== providerRevision
          ? Date.now()
          : undefined;
      },
      15 * 60_000,
    );
    t.diagnostic(
      JSON.stringify({
        event: "saved-git-token-replacement",
        revision: savedGitAclIdentity(original.revision.id),
        previousIndex: index,
        credentialIndex: next,
        patchSeconds: (patchedAt - patchStartedAt) / 1000,
        deliveredSeconds: (deliveredAt - patchedAt) / 1000,
        mechanism: "provider-environment-rotation",
        withinOneLoan: deliveredAt - patchedAt < 1_800_000,
      }),
    );
    const { gitScript, issuedIndex } = savedGitProbeTools(fixture, exec);
    const fetchStart = network.requests().length;
    const fetched = await gitScript(
      original.target,
      `local_dir=$(mktemp -d)
git init -q --bare "$local_dir"
git -C "$local_dir" fetch -q 'https://github.com/fixture/a.git' refs/heads/main:refs/heads/main
git -C "$local_dir" rev-parse 'refs/heads/main^{commit}'`,
    );
    assert.equal(fetched.stdout.toString("utf8").trim(), origin.initialSha);
    assert.equal(issuedIndex(fetchStart), next, "TOKEN_REPLACEMENT_AT_ORIGIN");
    assert.deepEqual(
      (await original.readExecution()).identity,
      original.original.identity,
      "TOKEN_REPLACEMENT_NO_REDEPLOY",
    );
    const {
      resourceVersion: updated,
      providerRevision: environment,
      ...rotated
    } = await loadPolicy(original, write, "read-write");
    assert.deepEqual(
      rotated,
      binding,
      "Replacement must keep the same policy and attached Provider",
    );
    assert.ok(updated && BigInt(updated) > BigInt(resourceVersion));
    assert.notEqual(environment, providerRevision);
    assert.equal(origin.snapshot().issued, issued, "TOKEN_REPLACEMENT_ISSUES_NOTHING");
    lentIndex = next;
    original = { ...original, credentialIndex: next };
    assert.equal(await callbacks.read(), nativeCallbackBaseline);
    await assertTokensAbsentFromWorkload(
      t,
      exec,
      original.target,
      [credential.value, credential.replacement],
      "replaced",
    );
  }
  const startPeer = async () => {
    const independent = fixture.independent;
    assert.ok(independent?.modelSource);
    assert.notEqual(independent.namespace.id, fixture.namespace.id);
    assert.notEqual(independent.workspace, workspace);
    const peerFixture = {
      ...fixture,
      ...independent,
      verifySupervisorImage: (target: GitTarget) =>
        fixture.verifySupervisorImage(target, independent.workspace),
    };
    const prepared = await prepareAgent(peerFixture);
    assert.notEqual(prepared.agent.id, agent.id);
    const peerPolicyPath = `${prepared.path}/sandbox-policy/networking`;
    await request("PATCH", `${peerPolicyPath}/editing`, { enabled: true });
    const initialPeer: SandboxPolicyViewWire = await request("GET", peerPolicyPath);
    const peerGrants = [
      { repository: "fixture/a", access: "write" },
      { repository: "fixture/c", access: "write" },
    ] as const;
    const peerPolicy: SandboxPolicyViewWire["policy"] = await request("PUT", peerPolicyPath, {
      expectedVersion: initialPeer.policy.version,
      additions: initialPeer.policy.additions,
      repositoryNetworkPolicy: peerGrants,
    });
    const deployed = await deployWith(prepared.deploy);
    assert.notEqual(deployed.target.sandboxId, original.target.sandboxId);
    const peerIndex = deployed.credentialIndex;
    if (app) {
      assert.notEqual(peerIndex, original.credentialIndex);
    } else {
      // The same credential: a second Agent lends the same Secret value.
      assert.equal(peerIndex, original.credentialIndex, "TOKEN_PEER_SAME_CREDENTIAL");
    }
    const readPeer = () =>
      loadPolicy(deployed, peerPolicy, "peer", {
        workspace: independent.workspace,
        policyPath: peerPolicyPath,
      });
    const generation = await readPeer();
    const { provider } = generation;
    assert.notEqual(provider, installed.provider);
    const peerExec = createManagedWorkloadExec(t, {
      backend: fixture.gatewayBackend,
      gatewayClient,
      workspace: independent.workspace,
      checkpoint: fixture.checkpoint,
    });
    const { gitScript, guest } = savedGitProbeTools(fixture, peerExec);
    const peerGit = async (script: string) => {
      const result = await gitScript(deployed.target, script);
      const oid = result.stdout.toString("utf8").trim();
      assert.ok(/^[a-f0-9]{40}$/u.test(oid), "peer Git must return one commit OID");
      return oid;
    };
    const denyB = async () => {
      const path = "/fixture/b.git/info/refs";
      const calibration = await network.probeIssued(peerIndex, "fixture/b", {
        method: "GET",
        service: "git-upload-pack",
      });
      assert.deepEqual(calibration, {
        status: 200,
        type: "application/x-git-upload-pack-advertisement",
      });
      const before = origin.snapshot().requests;
      const denied = await guest(
        deployed.target,
        { kind: "rest", method: "GET", path, host: "github.com" },
        [...curl, `https://github.com${path}?service=git-upload-pack`],
      );
      assert.equal(denied.stdout.toString("utf8"), "403 native-rest-policy\n");
      assert.equal(origin.snapshot().requests, before);
    };
    const prove = async (stage: string) => {
      await denyB();
      assert.deepEqual(await readPeer(), generation);

      const reads = new Set(["GET upload-advertise", "POST upload-pack"]);
      const writes = new Set([...reads, "GET receive-advertise", "POST receive-pack"]);
      const observe = async (repo: string, script: string, methods: ReadonlySet<string>) => {
        assert.ok(Date.now() < deployed.deadlineWallMs);
        assert.deepEqual((await deployed.readExecution()).identity, deployed.original.identity);
        const before = origin.snapshot().requests;
        const offset = network.requests().length;
        const oid = await peerGit(script);
        assert.ok(Date.now() < deployed.deadlineWallMs);
        const observed = network.requests().slice(offset);
        const originHttpDelta = origin.snapshot().requests - before;
        assert.equal(originHttpDelta, observed.length, "unexpected origin HTTP");
        const authenticated = new Set<string>();
        for (const entry of observed) {
          const operation = `${entry.method} ${entry.operation}`;
          assert.ok(entry.repository === repo && methods.has(operation));
          if (entry.authenticated) {
            assert.equal(entry.credentialIndex, peerIndex);
            authenticated.add(operation);
          }
        }
        assert.deepEqual(authenticated, methods);
        return { oid, originHttpDelta };
      };
      const evidence = [];
      for (const { repository } of peerGrants) {
        const name = repository.slice("fixture/".length);
        const local = `/tmp/peer-write-${stage}-${name}`;
        const fresh = `${local}-fresh`;
        const ref = `refs/heads/peer-control-${stage}-${name}`;
        const url = `https://github.com/${repository}.git`;
        assert.equal(await network.ref(repository, ref), undefined);
        const push = `git clone -q '${url}' '${local}';
git -C '${local}' -c user.name=Fixture -c user.email=fixture@example.test commit -q --allow-empty -m 'Peer control ${stage} ${name}';
git -C '${local}' push -q origin 'HEAD:${ref}';
git -C '${local}' rev-parse HEAD`;
        const pushed = await observe(repository, push, writes);
        assert.notEqual(pushed.oid, origin.initialSha);
        assert.equal(await network.ref(repository, ref), pushed.oid);
        assert.equal(await network.hasObject(repository, pushed.oid), true);
        const fetch = `test ! -e '${fresh}'; git init -q --initial-branch=peer-empty '${fresh}';
git -C '${fresh}' fetch -q '${url}' '${ref}:${ref}';
git -C '${fresh}' rev-parse '${ref}^{commit}'`;
        const fetched = await observe(repository, fetch, reads);
        assert.equal(fetched.oid, pushed.oid);
        evidence.push({ repository, ref, pushed, fetched });
      }
      assert.equal(new Set(evidence.map(({ pushed }) => pushed.oid)).size, 2);
      const event = "saved-git-acl-peer-controls";
      t.diagnostic(JSON.stringify({ event, stage, credentialIndex: peerIndex, refs: evidence }));
      assert.deepEqual(await readPeer(), generation);
      assert.equal(await callbacks.read(), nativeCallbackBaseline);
    };
    await prove("before");
    if (credential.kind === "token") {
      await assertTokensAbsentFromWorkload(
        t,
        peerExec,
        deployed.target,
        [credential.value, credential.replacement],
        "peer",
      );
    }
    return {
      deployed,
      workspace: independent.workspace,
      provider,
      credentialIndex: peerIndex,
      prove,
      exec: peerExec,
    };
  };
  const peer = await startPeer();
  let successor: Deployed | undefined;
  let successorProvider: string | undefined;
  const { originalIndex, replacementIndex } = await exerciseSavedGitAcl(
    t,
    fixture,
    exec,
    original,
    async (index) => {
      requireTimelyGit(original.target);
      const beforeDowngrade = await readPolicy();
      assert.equal(beforeDowngrade.policy.version, write.version);
      assert.equal(beforeDowngrade.defaultsRevisionId, original.revision.id);
      const read = await save(beforeDowngrade, [
        { repository: "fixture/a", access: "read" },
        { repository: "fixture/b", access: "read" },
      ]);
      assert.deepEqual((await original.readExecution()).identity, original.original.identity);
      requireTimelyGit(original.target);
      const replacement = await deployPolicy();
      deadlines.set(replacement.target.sandboxId, replacement.deadlineWallMs);
      assert.equal(replacement.agent.id, agent.id);
      assert.notEqual(replacement.revision.id, original.revision.id);
      assert.notEqual(replacement.target.sandboxId, original.target.sandboxId);
      assert.notEqual(replacement.supervisor.workloadPodUid, original.supervisor.workloadPodUid);
      assert.notEqual(
        replacement.supervisor.supervisorPodUid,
        original.supervisor.supervisorPodUid,
      );
      const current = await loadPolicy(replacement, read, "read-only");
      assert.notEqual(current.provider, installed.provider);
      assert.notEqual(current.hash, installed.hash);
      assert.notEqual(current.configInstance, installed.configInstance);

      await retire(original, installed.provider, index);
      requireTimelyGit(original.target);
      await peer.prove("after-downgrade");
      successor = replacement;
      successorProvider = current.provider;
      return replacement;
    },
    nativeCallbackBaseline,
    !app,
  );
  assert.ok(successor && successorProvider && replacementIndex !== undefined);
  assert.notEqual(
    permissive.index,
    originalIndex,
    "restricted deployment must issue its own credential",
  );
  // [] withdraws desired authority, but this Driver cannot launch deny-all.
  // An unrelated save that omits the field must retain the explicit list.
  const beforeClear = await readPolicy();
  const cleared = await save(beforeClear, []);
  const omitted: SandboxPolicyViewWire["policy"] = await request("PUT", policyPath, {
    expectedVersion: cleared.version,
    additions: cleared.additions,
  });
  assert.equal(omitted.version, cleared.version + 1);
  assert.equal(omitted.repositoryNetworkPolicy, undefined);
  const persisted = await readPolicy();
  assert.equal(persisted.policy.version, omitted.version);
  assert.deepEqual(persisted.policy.repositoryNetworkPolicy, []);
  assert.equal(persisted.defaultsRevisionId, successor.revision.id);
  assert.equal(persisted.deployedPolicyVersion, beforeClear.deployedPolicyVersion);

  const beforeRefusal = origin.snapshot();
  const revisions = await request("GET", `${path}/revisions`);
  await request("POST", `${path}/deploy`, undefined, emptyDeployRefusal);
  assert.deepEqual(await request("GET", `${path}/revisions`), revisions);
  assert.equal(origin.snapshot().issued, beforeRefusal.issued);
  assert.deepEqual((await successor.readExecution()).identity, successor.original.identity);
  assert.equal((await request("GET", path)).activeRevisionId, successor.revision.id);

  // A refused deploy does not revoke the still-running predecessor. Stop the
  // exact active revision and require both generations to be fully retired.
  await stop(successor);
  await retire(successor, successorProvider, replacementIndex);
  await retire(original, installed.provider, originalIndex);
  const quiet = origin.snapshot();
  const observationEnds = Date.now() + 2_000;
  await observeUntil(
    "absence of a late Git grant after Stop",
    t.signal,
    async () => {
      const snapshot = origin.snapshot();
      assert.equal(snapshot.issued, beforeRefusal.issued, "Stop must not issue a late credential");
      assert.equal(snapshot.requests, quiet.requests, "No late upstream request may follow Stop");
      if (app) {
        assert.ok(
          [originalIndex, replacementIndex].every(
            (index) => snapshot.tokens.find((token) => token.index === index)?.revoked === true,
          ),
          "Both primary credentials must remain revoked",
        );
        assert.ok(
          snapshot.tokens.every(
            (token) => token.revoked === (token.index !== peer.credentialIndex),
          ),
        );
      } else {
        assert.ok(snapshot.tokens.every((token) => !token.revoked));
      }
      return Date.now() >= observationEnds ? true : undefined;
    },
    5_000,
  );
  assert.deepEqual((await readPolicy()).policy.repositoryNetworkPolicy, []);
  await peer.prove("after-stop");
  if (credential.kind === "token") {
    await refuseClassicToken(t, fixture, peer.deployed.target, peer.exec, credential);
  }
  await stop(peer.deployed);
  await retire(peer.deployed, peer.provider, peer.credentialIndex, {
    path: peer.deployed.path,
    workspace: peer.workspace,
    agentId: peer.deployed.agent.id,
  });
  assert.equal(await callbacks.read(), 0);
  t.diagnostic(
    "Saved Git ACL clear persisted; deploy refused deny-all and explicit Stop retired both generations",
  );
}

if (process.env.OCC_TEST_OPENSHELL_SAVED_AGENT_ACL === "1") {
  test(
    "An Administrator deploys and downgrades saved Git network grants on the same OpenShell Agent",
    { timeout: 45 * 60_000 },
    settleBeforeFixtureTeardown((t) => savedAgentGitJourney(t, { kind: "app" })),
  );
  test(
    "An Administrator deploys, replaces and narrows a fine-grained token source on saved OpenShell Agents",
    { timeout: 60 * 60_000 },
    settleBeforeFixtureTeardown((t) => savedAgentGitJourney(t, fakeTokenCredential())),
  );
}
