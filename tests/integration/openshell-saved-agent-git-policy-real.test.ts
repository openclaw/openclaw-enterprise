import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { RepositoryNetworkGrant } from "@openclaw-enterprise/contracts";
import type { SandboxPolicyViewWire } from "../../packages/contracts/src/api/sandbox-policy.ts";
import type { AgentDeploymentStatusWire } from "../../packages/contracts/src/api/resources.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { wirePolicy } from "../../apps/controller/src/drivers/egress-proxy/openshell-wire-policy.ts";
import type { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";
import {
  createManagedWorkloadExec,
  UnconfirmedManagedWorkloadExecError,
} from "../helpers/egress-managed-workload-exec.ts";
import { observeUntil, prepareFiniteGitAgent } from "../helpers/finite-git-agent.ts";
import { ownFirstAgentWork } from "../helpers/local-first-agent-stack.mjs";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";
import {
  assertGitAclVariantOutcome,
  calibrateGitAclVariant,
  createGitAclDenialCommand,
  describeGitAclFailure,
  gitAclVariantCurlArgs,
  gitAclVariants,
} from "../helpers/openshell-git-denial.ts";

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

function savedGitAclIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// A settled challenge can fail independently. A launch with an unknown outcome
// must still stop later operations on this fixture.
async function savedGitAclProbe(
  t: TestContext,
  name: string,
  run: (probe: TestContext) => Promise<void>,
) {
  let unconfirmed: UnconfirmedManagedWorkloadExecError | undefined;
  await t.test(name, async (probe) => {
    try {
      await run(probe);
    } catch (error) {
      if (error instanceof UnconfirmedManagedWorkloadExecError) {
        unconfirmed = error;
      }
      throw error;
    }
  });
  if (unconfirmed !== undefined) {
    throw unconfirmed;
  }
}

async function exerciseSavedGitAclRest(
  t: TestContext,
  fixture: GitInstallation,
  execute: GitExec,
  target: GitTarget,
  credentialIndex: number,
  pushed: string,
) {
  const origin: GitOrigin = fixture.origin;
  const network = origin.network;
  assert.ok(network);
  const guest = createGitAclDenialCommand(network.issuedCredentialFingerprints());
  const host = "api.github.com";
  let issueReads = 0;
  let deniedBeforeOrigin = 0;
  const request = async (
    repository: "fixture/a" | "fixture/b",
    operation: string,
    method: "GET" | "POST",
    command: [string, ...string[]],
  ) => {
    const before = origin.snapshot().requests;
    const offset = network.requests().length;
    const result = await execute(target, guest({ kind: "success" }, command));
    assert.equal(origin.snapshot().requests, before + 1, "Expected one origin request");
    assert.deepEqual(network.requests().slice(offset), [
      { repository, operation, method, authenticated: true, credentialIndex },
    ]);
    return result.stdout.toString("utf8");
  };

  // Use the sandbox's injected placeholder with the installed gh. Both reads
  // must reach the controlled origin under the same credential as the Git push.
  for (const [route, operation] of [
    ["issues", "rest-issue-list"],
    ["issues/42", "rest-issue-read"],
  ] as const) {
    await savedGitAclProbe(t, "REST " + operation, async () => {
      const json = await request("fixture/a", operation, "GET", [
        "sh",
        "-ceu",
        'unset GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG; export GH_PROMPT_DISABLED=1; exec gh api --hostname github.com "$1"',
        "--",
        `repos/fixture/a/${route}`,
      ]);
      const issue = { number: 42, title: "Fixture issue in fixture/a", state: "open" };
      assert.ok(
        isDeepStrictEqual(JSON.parse(json), route === "issues" ? [issue] : issue),
        "Unexpected controlled issue response",
      );
      issueReads++;
    });
  }

  const title = "Create a fixture pull";
  const pull = { title, head: "approved", base: "main" };
  const bearerCurl = (
    method: "GET" | "POST",
    path: string,
    payload?: object,
  ): [string, ...string[]] => [
    "sh",
    "-ceu",
    'printf "Authorization: Bearer %s\\n" "$GITHUB_TOKEN" | "$@" --header @-',
    "--",
    "/usr/bin/curl",
    "-q",
    "--noproxy",
    "*",
    "--proto",
    "=https",
    "--max-redirs",
    "0",
    "--max-time",
    "10",
    "--silent",
    "--show-error",
    "--max-filesize",
    "8192",
    "--write-out",
    "\n%{http_code} %{content_type}\n",
    "--request",
    method,
    ...(payload === undefined ? [] : ["--json", JSON.stringify(payload)]),
    `https://${host}${path}`,
  ];
  const bPulls = "/repos/fixture/b/pulls";
  const nativeDenials = [
    ["A pull creation", "POST", "/repos/fixture/a/pulls", pull],
    ["C pull creation", "POST", "/repos/fixture/c/pulls", pull],
    ["C issue read", "GET", "/repos/fixture/c/issues/42", undefined],
    ["B issue creation", "POST", "/repos/fixture/b/issues", { title: "Fixture issue creation" }],
    [
      "GraphQL",
      "POST",
      "/graphql",
      { query: '{ repository(owner: "fixture", name: "b") { name } }' },
    ],
  ] as const;
  const authorityDenials = [
    ["foreign-qualified PR head", { ...pull, head: "foreign:approved" }],
    ["foreign PR head repository", { ...pull, head_repo: "foreign" }],
    ["issue-to-PR conversion", { ...pull, issue: 42 }],
  ] as const;
  const denied = async (
    method: "GET" | "POST",
    path: string,
    payload: object | undefined,
    layer: "native" | "authority",
  ) => {
    const before = origin.snapshot().requests;
    // The guest capture bounds both streams and rejects any credential match
    // before returning bytes. A completed curl transfer can carry HTTP 403.
    const result = await execute(
      target,
      guest({ kind: "success" }, bearerCurl(method, path, payload)),
    );
    assert.equal(origin.snapshot().requests, before, "Denied API request reached the origin");
    const footer = "\n403 application/json\n";
    const response = result.stdout.toString("utf8");
    assert.ok(response.endsWith(footer), "Expected HTTP 403 from the policy boundary");
    let envelope: Record<string, unknown> | undefined;
    try {
      envelope = asRecord(JSON.parse(response.slice(0, -footer.length)));
    } catch {
      assert.fail("Expected a JSON denial envelope");
    }
    assert.ok(
      envelope?.layer === "l7" &&
        envelope.method === method &&
        envelope.path === path &&
        envelope.host === host &&
        envelope.port === 443,
      "Denial must identify the attempted API request",
    );
    if (layer === "authority") {
      assert.ok(
        envelope.error === "middleware_denied" &&
          envelope.middleware === "oce-prepared-git" &&
          envelope.reason_code === "request_not_allowed",
        "Expected prepared Git request authority refusal",
      );
    } else {
      const rule = asRecord(envelope.rule_missing);
      assert.ok(
        envelope.error === "policy_denied" &&
          envelope.protocol === "rest" &&
          rule?.type === "rest_allow" &&
          rule.layer === "l7" &&
          rule.method === method &&
          rule.path === path,
        "Expected Supervisor REST policy refusal",
      );
    }
    deniedBeforeOrigin++;
  };
  for (const [name, method, path, payload] of nativeDenials) {
    await savedGitAclProbe(t, "REST refuses " + name, async () => {
      await denied(method, path, payload, "native");
    });
  }
  for (const [name, payload] of authorityDenials) {
    await savedGitAclProbe(t, "REST refuses " + name, async () => {
      await denied("POST", bPulls, payload, "authority");
    });
  }
  // Use the same Bearer client and B route as the rejected body variants.
  // Only the normal body may create a PR and reach the controlled origin.
  await savedGitAclProbe(t, "REST creates and reads back a pull request on B", async (probe) => {
    for (const repository of ["fixture/a", "fixture/b", "fixture/c"]) {
      assert.equal(network.pullRequest(repository), undefined);
    }
    const response = await request(
      "fixture/b",
      "rest-pull-create",
      "POST",
      bearerCurl("POST", bPulls, pull),
    );
    const footer = "\n201 application/json\n";
    assert.ok(response.endsWith(footer), "Expected HTTP 201 on PR creation");
    const observed = network.pullRequest("fixture/b");
    assert.ok(observed, "The origin must record the created pull request");
    assert.equal(observed.number, 1);
    assert.equal(observed.title, title);
    assert.equal(observed.state, "open");
    assert.equal(observed.draft, false);
    assert.equal(observed.head.ref, "approved");
    assert.equal(observed.head.sha, pushed);
    assert.equal(observed.base.ref, "main");
    assert.equal(observed.base.sha, origin.initialSha);
    assert.ok(
      isDeepStrictEqual(JSON.parse(response.slice(0, -footer.length)), observed),
      "Unexpected PR response",
    );
    probe.diagnostic(
      JSON.stringify({
        event: "saved-git-acl-rest",
        sandbox: savedGitAclIdentity(target.sandboxId),
        credentialIndex,
        issueReads,
        prNumber: observed.number,
        prHead: pushed,
        deniedBeforeOrigin,
      }),
    );
  });
}

async function exerciseSavedGitAcl(
  t: TestContext,
  fixture: GitInstallation,
  execute: GitExec,
  original: GitTarget,
  replace: (credentialIndex: number) => Promise<GitTarget>,
  scopedRest: boolean,
) {
  const origin: GitOrigin = fixture.origin;
  const network = origin.network;
  assert.ok(network);
  type Observation = Parameters<ReturnType<typeof createGitAclDenialCommand>>[0];
  const guest = (target: GitTarget, observation: Observation, command: [string, ...string[]]) =>
    execute(
      target,
      createGitAclDenialCommand(network.issuedCredentialFingerprints())(observation, command),
    );
  const gitSetup = `export LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 HOME=/tmp;
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false;
git config --global credential.helper '!f() { printf "%s\\n" username=x-access-token "password=$GITHUB_TOKEN"; }; f'`;
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

  const allowedStart = network.requests().length;
  const success = await gitScript(
    original,
    `cd /tmp;
git clone -q '${repositoryUrl("a")}' a; git -C a fetch -q origin;
git clone -q '${repositoryUrl("b")}' b; git -C b fetch -q origin;
git -C b -c user.name=Fixture -c user.email=fixture@example.test commit -q --allow-empty -m change;
git -C b push -q origin HEAD:refs/heads/approved; git -C b rev-parse HEAD`,
  );
  const pushed = success.stdout.toString("utf8").trim();
  assert.ok(/^[a-f0-9]{40}$/.test(pushed), "ACL_PUSH_IDENTITY");
  assert.equal(await network.ref("fixture/b", "refs/heads/approved"), pushed);
  assert.equal(await network.hasObject("fixture/b", pushed), true);
  const originalIndex = issuedIndex(allowedStart);
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
  const allowReplay = async (
    target: GitTarget,
    index: number,
    repository: "a" | "b",
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
  const denyReplay = async (
    target: GitTarget,
    index: number,
    repository: "a" | "b" | "c",
    request: Probe,
    kind: "rest" | "request-authority" = "rest",
  ) => {
    const shape = probeShape(repository, request);
    if (kind === "rest") {
      const calibration = network.requests().length;
      const witness = await network.probeIssued(index, `fixture/${repository}`, {
        method: request.method,
        service: shape.gitService,
        ...(request.method === "POST" && { body: shape.body }),
      });
      assert.deepEqual(witness, { status: 200, type: shape.responseType });
      checkCalibration(calibration, index, repository, request);
    }
    const before = origin.snapshot();
    const response = await guest(
      target,
      { kind, method: request.method, path: shape.path, host: "github.com" },
      [
        ...curl,
        "-X",
        request.method,
        ...shape.rpc,
        // This exact permitted route is separately refused by the Git authority
        // when the request advertises an unsupported protocol version.
        ...(kind === "request-authority" ? ["-H", "Git-Protocol: version=3"] : []),
        shape.url,
      ],
    );
    const after = origin.snapshot();
    assert.equal(after.requests, before.requests, "ACL_DENIAL_ORIGIN");
    const decision = kind === "rest" ? "native-rest-policy" : "git-request-authority";
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
  const adversarialReplay = async (target: GitTarget, index: number, generation: string) => {
    await savedGitAclProbe(t, generation + " adversarial Git requests", async (phase) => {
      // Confirm the fixture Service and use the normal managed hostname route.
      // The origin records the exact repository, method and issued credential.
      await fixture.readGitAclDestination();
      const start = origin.snapshot().requests;
      const noncanonical = network.noncanonicalGitRequests();
      await allowReplay(target, index, "a", requests[0]);
      assert.equal(origin.snapshot().requests - start, 1, "ACL_CANONICAL_ROUTE_ORIGIN");
      assert.equal(network.noncanonicalGitRequests(), noncanonical, "ACL_CANONICAL_ROUTE_TARGET");
      phase.diagnostic(
        JSON.stringify({
          event: "saved-git-acl-canonical",
          generation,
          credentialIndex: index,
          originHttpDelta: 1,
        }),
      );
      const variantCurl = [...curl, "--max-redirs", "0"] as const;
      for (const probe of gitAclVariants(origin.initialSha)) {
        await savedGitAclProbe(phase, probe.name, async (result) => {
          await calibrateGitAclVariant(origin, index, probe);
          const before = origin.snapshot();
          const requestsStart = network.requests().length;
          const response = await guest(
            target,
            { kind: "variant", method: probe.method, path: probe.path, host: "github.com" },
            [...variantCurl, ...gitAclVariantCurlArgs(probe), `https://github.com${probe.target}`],
          );
          const after = origin.snapshot();
          const originHttpDelta = after.requests - before.requests;
          const decision = assertGitAclVariantOutcome(
            probe,
            response.stdout.toString("utf8"),
            originHttpDelta,
            network.requests().slice(requestsStart),
            index,
          );
          result.diagnostic(
            JSON.stringify({
              event: "saved-git-acl-variant",
              sandbox: savedGitAclIdentity(target.sandboxId),
              credentialIndex: index,
              probe: probe.name,
              method: probe.method,
              decision,
              originHttpDelta,
              originTcpDelta: after.connections - before.connections,
            }),
          );
        });
      }
    });
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
    if (request.service === "upload") {
      await denyReplay(original, originalIndex, "a", request, "request-authority");
    }
    for (const repository of request.denied) {
      await denyReplay(original, originalIndex, repository, request);
    }
  }
  await denyGit(original, ["-C", "/tmp/a", "push", "-q", "origin", "HEAD:refs/heads/approved"]);
  await denyC(original, "/tmp/a");
  await adversarialReplay(original, originalIndex, "Original");
  if (scopedRest) {
    await savedGitAclProbe(t, "Original scoped GitHub REST", async (phase) => {
      await exerciseSavedGitAclRest(phase, fixture, execute, original, originalIndex, pushed);
    });
  }

  const replacement = await replace(originalIndex);
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
  const replacementIndex = issuedIndex(fetchStart);
  assert.notEqual(replacementIndex, originalIndex, "redeploy must issue a new credential");

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
      await denyReplay(replacement, replacementIndex, "a", request, "request-authority");
    }
    const deniedRepositories =
      request.service === "upload" ? (["c"] as const) : (["a", "b", "c"] as const);
    for (const repository of deniedRepositories) {
      await denyReplay(replacement, replacementIndex, repository, request);
    }
  }
  await allowReplay(replacement, replacementIndex, "a", requests[0]);
  await allowReplay(replacement, replacementIndex, "b", requests[0]);
  await adversarialReplay(replacement, replacementIndex, "Replacement");
  assert.equal(await network.ref("fixture/a", main), origin.initialSha);
  assert.equal(await network.ref("fixture/a", approved), undefined);
  assert.equal(await network.ref("fixture/b", approved), pushed);
  t.diagnostic("Saved Git ACL downgrade kept A/B reads and refused A/B writes and all C routes");
  return { originalIndex, replacementIndex };
}

// Keep this manual case outside the normal lane until the bundled driver
// admits the complete inspected Workspace route on the selected runtime.
if (process.env.OCC_TEST_OPENSHELL_SAVED_AGENT_ACL === "1") {
  test(
    "An Administrator deploys and downgrades saved Git network grants on the same OpenShell Agent",
    { timeout: 45 * 60_000 },
    settleBeforeFixtureTeardown(async (t) => {
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
      const peerSelected = process.env.OCC_TEST_OPENSHELL_SAVED_AGENT_AC5 === "1";
      const scopedRest = process.env.OCC_TEST_OPENSHELL_SAVED_AGENT_REST === "1";
      const fixture = await createOpenShellGitInstallation(t, {
        networkAcl: "issued",
        peerWorkspace: peerSelected,
        scopedRest,
        syntheticStartupModel: true,
      });
      const { gatewayClient, workspace, request } = fixture;
      const origin: GitOrigin = fixture.origin;
      const network = origin.network;
      assert.ok(network && network.token === undefined, "Require the controlled App issuer");
      assert.deepEqual(network.repositories, ["fixture/a", "fixture/b", "fixture/c"]);

      const { agent, path, deploy } = await prepareFiniteGitAgent(
        t,
        fixture,
        network.scopes.map(({ repositoryRef }) => repositoryRef),
      );
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

      const loadPolicy = async (
        deployed: Awaited<ReturnType<typeof deploy>>,
        desired: SandboxPolicyViewWire["policy"],
        mode: "read-write" | "read-only",
      ) => {
        const { target, revision } = deployed;
        const [view, status, config] = await Promise.all([
          readPolicy(),
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
        const services = config.supervisor_middleware_services;
        assert.ok(Array.isArray(services), "Require installed Supervisor middleware readback");
        const gitServices = services
          .map(asRecord)
          .filter((service) => service?.name === "oce-prepared-git");
        const [gitService] = gitServices;
        assert.equal(gitServices.length, 1);
        assert.ok(
          gitService?.audience === "oce-prepared-git" &&
            typeof gitService.grpc_endpoint === "string" &&
            gitService.grpc_endpoint.startsWith("https://") &&
            !gitService.allow_insecure_transport,
          "Require the registered private HTTPS Git request authority",
        );
        const admitted = serving.sandbox.configurationAdmission;
        assert.ok(admitted && admitted.state === 2);
        assert.equal(admitted.instance_id, config.configuration_instance_id);
        assert.equal(admitted.policy_version, config.version);
        assert.equal(admitted.policy_hash, config.policy_hash);
        assert.equal(admitted.config_revision, config.config_revision);
        assert.equal(admitted.provider_env_revision, config.provider_env_revision);
        assert.equal(
          serving.sandbox.spec?.provider_attachment_epoch,
          config.provider_attachment_epoch,
        );
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
        assert.equal(github.length, scopedRest ? 2 : 1);
        const git = github.find(({ endpoint }) => endpoint?.host === "github.com");
        assert.ok(git?.endpoint && desired.repositoryNetworkPolicy);
        const provider = serving.sandbox.spec?.providers?.find(
          (name: unknown) =>
            typeof name === "string" && "_provider_" + name.replaceAll("-", "_") === git.name,
        );
        assert.ok(typeof provider === "string" && provider.length > 0);
        assert.equal(git.endpoint.host, "github.com");
        assert.equal(git.endpoint.port, 443);
        assert.equal(git.endpoint.protocol, "rest");
        assert.equal(git.endpoint.enforcement, "NETWORK_ENFORCEMENT_MODE_ENFORCE");
        assert.equal(git.endpoint.provider_credentialed, true);
        assert.ok(!git.endpoint.allow_uninspected_credentials);
        assert.ok(
          git.endpoint.tls === undefined || git.endpoint.tls === "NETWORK_TLS_MODE_UNSPECIFIED",
        );
        if (scopedRest) {
          const api = github.find(({ endpoint }) => endpoint?.host === "api.github.com");
          assert.ok(api?.endpoint && api.name === git.name);
          assert.equal(api.endpoint.port, 443);
          assert.equal(api.endpoint.protocol, "rest");
          assert.equal(api.endpoint.enforcement, "NETWORK_ENFORCEMENT_MODE_ENFORCE");
          assert.equal(api.endpoint.provider_credentialed, true);
          assert.ok(!api.endpoint.allow_uninspected_credentials);
          assert.ok(
            api.endpoint.tls === undefined || api.endpoint.tls === "NETWORK_TLS_MODE_UNSPECIFIED",
          );
        }
        const expectedRules = [
          {
            allow: {
              method: "GET",
              path: "/fixture/a.git/info/refs",
              query: { service: { glob: "git-upload-pack" } },
            },
          },
          { allow: { method: "POST", path: "/fixture/a.git/git-upload-pack" } },
          {
            allow: {
              method: "GET",
              path: "/fixture/b.git/info/refs",
              query: { service: { glob: "git-upload-pack" } },
            },
          },
          { allow: { method: "POST", path: "/fixture/b.git/git-upload-pack" } },
        ];
        if (mode === "read-write") {
          expectedRules.push(
            {
              allow: {
                method: "GET",
                path: "/fixture/b.git/info/refs",
                query: { service: { glob: "git-receive-pack" } },
              },
            },
            { allow: { method: "POST", path: "/fixture/b.git/git-receive-pack" } },
          );
        }
        assert.ok(
          isDeepStrictEqual(wirePolicy(git.endpoint.rules), wirePolicy(expectedRules)),
          "the loaded Git endpoint rules must match the saved grants exactly",
        );
        const generation = {
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
            agent: savedGitAclIdentity(agent.id),
            revision: savedGitAclIdentity(revision.id),
            sandbox: savedGitAclIdentity(target.sandboxId),
            savedVersion: desired.version,
            policyVersion: loaded.version,
          }),
        );
        return generation;
      };

      // First-save and rollout are separate mutations. Saving must not admit
      // a revision or silently change the revision that serves the saved Agent.
      const write = await save(initial, [
        { repository: "fixture/a", access: "read" },
        { repository: "fixture/b", access: "write" },
      ]);
      assert.deepEqual(await request("GET", `${path}/revisions`), []);
      const original = await deploy();
      const installed = await loadPolicy(original, write, "read-write");
      const managed = createManagedWorkloadExec(t, {
        backend: fixture.gatewayBackend,
        gatewayClient,
        workspace,
        checkpoint: fixture.checkpoint,
        describeExitFailure: describeGitAclFailure,
      });
      const deadlines = new Map([[original.target.sandboxId, original.deadlineWallMs]]);
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
      type Deployed = Awaited<ReturnType<typeof deploy>>;
      type PeerAgent = {
        deployed: Deployed;
        workspace: string;
        provider: string;
        credentialIndex: number;
        prove(stage: string): Promise<void>;
      };
      let peerAgent: PeerAgent | undefined;
      if (peerSelected) {
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
        const prepared = await prepareFiniteGitAgent(
          t,
          peerFixture,
          network.scopes.map(({ repositoryRef }) => repositoryRef),
        );
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
        const deployed = await prepared.deploy();
        assert.notEqual(deployed.target.sandboxId, original.target.sandboxId);
        const peerView: SandboxPolicyViewWire = await request("GET", peerPolicyPath);
        assert.equal(peerView.defaultsRevisionId, deployed.revision.id);
        assert.equal(peerView.deployedPolicyVersion, peerPolicy.version);
        assert.deepEqual(peerView.policy.repositoryNetworkPolicy, peerGrants);
        const config = await gatewayClient.getSandboxConfig(
          independent.workspace,
          deployed.target.sandboxName,
          t.signal,
        );
        const status = await gatewayClient.getSandboxPolicyStatus(
          independent.workspace,
          deployed.target.sandboxName,
          t.signal,
        );
        assert.equal(config.workspace, independent.workspace);
        assert.equal(asRecord(status.revision)?.status, "POLICY_STATUS_LOADED");
        assert.equal(config.version, status.active_version);
        const services = config.supervisor_middleware_services;
        assert.ok(Array.isArray(services));
        const hooks = services
          .map(asRecord)
          .filter((service) => service?.name === "oce-prepared-git");
        assert.equal(hooks.length, 1);
        const [hook] = hooks;
        assert.ok(
          hook?.audience === "oce-prepared-git" &&
            typeof hook.grpc_endpoint === "string" &&
            hook.grpc_endpoint.startsWith("https://") &&
            !hook.allow_insecure_transport,
          "Require the peer's private HTTPS Git request authority",
        );
        const rules = asRecord(asRecord(config.policy)?.network_policies);
        assert.ok(rules);
        const gitNames = Object.entries(rules)
          .filter(([, rule]) => {
            const endpoints = asRecord(rule)?.endpoints;
            return (
              Array.isArray(endpoints) &&
              endpoints.some((endpoint) => asRecord(endpoint)?.host === "github.com")
            );
          })
          .map(([name]) => name);
        assert.equal(gitNames.length, 1);
        const provider = (await deployed.readExecution()).sandbox.spec?.providers?.find(
          (name: unknown) =>
            typeof name === "string" && "_provider_" + name.replaceAll("-", "_") === gitNames[0],
        );
        assert.ok(typeof provider === "string");
        const peerExec = createManagedWorkloadExec(t, {
          backend: fixture.gatewayBackend,
          gatewayClient,
          workspace: independent.workspace,
          checkpoint: fixture.checkpoint,
        });
        const peerGit = async (script: string) => {
          const command = createGitAclDenialCommand(network.issuedCredentialFingerprints())(
            { kind: "success" },
            [
              "sh",
              "-ceu",
              `export LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 HOME=/tmp;
git config --global credential.helper '!f() { printf "%s\\n" username=x-access-token "password=$GITHUB_TOKEN"; }; f';
${script}`,
            ],
          );
          const result = await peerExec(deployed.target, command);
          assert.equal(result.exitCode, 0);
          for (const output of [result.stdout, result.stderr]) {
            assert.ok(!network.containsIssuedCredential(output), "PEER_CREDENTIAL_IN_OUTPUT");
          }
          const oid = result.stdout.toString("utf8").trim();
          assert.ok(/^[a-f0-9]{40}$/u.test(oid), "peer Git must return one commit OID");
          return oid;
        };
        let credentialIndex: number | undefined;
        const prove = async (stage: string) => {
          assert.ok(Date.now() < deployed.deadlineWallMs, "peer finite grant must still be active");
          assert.deepEqual((await deployed.readExecution()).identity, deployed.original.identity);
          const start = network.requests().length;
          const unknownStart = network.unknownRequests();
          const noncanonicalStart = network.noncanonicalGitRequests();
          const local = `/tmp/peer-${stage}`;
          const oid = await peerGit(`git clone -q https://github.com/fixture/a.git '${local}';
git -C '${local}' fetch -q origin;
git -C '${local}' rev-parse HEAD`);
          assert.equal(oid, await network.ref("fixture/a", "refs/heads/main"));
          assert.equal(await network.hasObject("fixture/a", oid), true);
          const reads = network.requests().slice(start);
          assert.equal(
            network.unknownRequests(),
            unknownStart,
            "peer reached an unrelated endpoint",
          );
          assert.equal(
            network.noncanonicalGitRequests(),
            noncanonicalStart,
            "peer Git must use the exact repository upload paths and query",
          );
          assert.ok(
            reads.every(
              ({ repository, operation, method }) =>
                repository === "fixture/a" &&
                ((operation === "upload-advertise" && method === "GET") ||
                  (operation === "upload-pack" && method === "POST")),
            ),
            "peer fresh Git may only reach its allowed repository upload service",
          );
          // Git may first receive an anonymous Basic challenge. Only the
          // authenticated origin observations establish the peer's credential.
          const authenticated = reads.filter((entry) => entry.authenticated);
          assert.ok(
            authenticated.some(({ operation }) => operation === "upload-advertise") &&
              authenticated.some(({ operation }) => operation === "upload-pack") &&
              authenticated.every((entry) => typeof entry.credentialIndex === "number"),
            "peer fresh Git must authenticate discovery and upload RPC with an issued credential",
          );
          const indices = new Set(authenticated.map((entry) => entry.credentialIndex));
          assert.equal(indices.size, 1);
          const [index] = indices;
          assert.ok(typeof index === "number");
          if (credentialIndex === undefined) {
            credentialIndex = index;
          }
          assert.equal(index, credentialIndex, "peer must retain its own credential");
          assert.ok(Date.now() < deployed.deadlineWallMs);
        };
        await prove("before");
        assert.ok(credentialIndex !== undefined);
        peerAgent = {
          deployed,
          workspace: independent.workspace,
          provider,
          credentialIndex,
          prove,
        };
        const peerIndex = credentialIndex;
        await savedGitAclProbe(t, "Peer can push and freshly fetch A and C", async (probe) => {
          const reads = new Set(["GET upload-advertise", "POST upload-pack"]);
          const writes = new Set([...reads, "GET receive-advertise", "POST receive-pack"]);
          const observe = async (repo: string, script: string, methods: ReadonlySet<string>) => {
            assert.ok(Date.now() < deployed.deadlineWallMs);
            assert.deepEqual((await deployed.readExecution()).identity, deployed.original.identity);
            const before = origin.snapshot().requests;
            const offset = network.requests().length;
            const noncanonical = network.noncanonicalGitRequests();
            const oid = await peerGit(script);
            assert.ok(Date.now() < deployed.deadlineWallMs);
            const observed = network.requests().slice(offset);
            const originHttpDelta = origin.snapshot().requests - before;
            assert.equal(originHttpDelta, observed.length, "unexpected origin HTTP");
            assert.equal(network.noncanonicalGitRequests(), noncanonical);
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
            const local = `/tmp/peer-write-${name}`;
            const fresh = `${local}-fresh`;
            const ref = `refs/heads/peer-control-${name}`;
            const url = `https://github.com/${repository}.git`;
            assert.equal(await network.ref(repository, ref), undefined);
            const push = `git clone -q '${url}' '${local}';
git -C '${local}' -c user.name=Fixture -c user.email=fixture@example.test commit -q --allow-empty -m 'Peer control ${name}';
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
          probe.diagnostic(JSON.stringify({ event, credentialIndex: peerIndex, refs: evidence }));
        });
      }
      let successor: Deployed | undefined;
      let successorProvider: string | undefined;
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
            credential?.revoked === true
            ? true
            : undefined;
        });
        const revoked = await network.probeIssued(index, "fixture/b", {
          method: "GET",
          service: "git-upload-pack",
        });
        assert.deepEqual(revoked, { status: 401, type: "application/json" });
        t.diagnostic(
          JSON.stringify({
            event: "saved-git-acl-retired",
            agent: savedGitAclIdentity(owner.agentId),
            revision: savedGitAclIdentity(deployed.revision.id),
            sandbox: savedGitAclIdentity(deployed.target.sandboxId),
            credentialIndex: index,
            originStatus: revoked.status,
          }),
        );
      };
      const { originalIndex, replacementIndex } = await exerciseSavedGitAcl(
        t,
        fixture,
        exec,
        original.target,
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
          const replacement = await deploy();
          deadlines.set(replacement.target.sandboxId, replacement.deadlineWallMs);
          assert.equal(replacement.agent.id, agent.id);
          assert.notEqual(replacement.revision.id, original.revision.id);
          assert.notEqual(replacement.target.sandboxId, original.target.sandboxId);
          assert.notEqual(
            replacement.supervisor.workloadPodUid,
            original.supervisor.workloadPodUid,
          );
          assert.notEqual(
            replacement.supervisor.supervisorPodUid,
            original.supervisor.supervisorPodUid,
          );
          const current = await loadPolicy(replacement, read, "read-only");
          assert.notEqual(current.provider, installed.provider);
          assert.notEqual(current.hash, installed.hash);
          assert.notEqual(current.configInstance, installed.configInstance);

          await retire(original, installed.provider, index);
          if (peerAgent) {
            assert.notEqual(peerAgent.credentialIndex, index);
            await peerAgent.prove("after-downgrade");
          }
          successor = replacement;
          successorProvider = current.provider;
          return replacement.target;
        },
        scopedRest,
      );
      assert.ok(successor && successorProvider);
      if (peerAgent) {
        assert.notEqual(peerAgent.credentialIndex, replacementIndex);
      }

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
      await request("POST", `${path}/deploy`, undefined, {
        status: 409,
        code: "RESOURCE_CONFLICT",
        path: "/repositoryNetworkPolicy",
        detailCode: "INVALID_VALUE",
        message: "The Sandbox Driver must return an effective repository network policy document.",
      });
      assert.deepEqual(await request("GET", `${path}/revisions`), revisions);
      assert.equal(origin.snapshot().issued, beforeRefusal.issued);
      assert.deepEqual((await successor.readExecution()).identity, successor.original.identity);
      assert.equal((await request("GET", path)).activeRevisionId, successor.revision.id);

      // A refused deploy does not revoke the still-running predecessor. Stop the
      // exact active revision and require both generations to be fully retired.
      const stopped = await request(
        "POST",
        `${path}/stop?expectedActiveRevisionId=${encodeURIComponent(successor.revision.id)}`,
      );
      assert.equal(stopped.desiredRuntimeState, "stopped");
      await retire(successor, successorProvider, replacementIndex);
      await retire(original, installed.provider, originalIndex);
      const quiet = origin.snapshot();
      const observationEnds = Date.now() + 2_000;
      await observeUntil(
        "absence of a late Git grant after Stop",
        t.signal,
        async () => {
          const snapshot = origin.snapshot();
          assert.equal(
            snapshot.issued,
            beforeRefusal.issued,
            "Stop must not issue a late credential",
          );
          assert.equal(
            snapshot.requests,
            quiet.requests,
            "No late upstream request may follow Stop",
          );
          assert.ok(
            [originalIndex, replacementIndex].every(
              (index) => snapshot.tokens.find((token) => token.index === index)?.revoked === true,
            ),
            "Both primary credentials must remain revoked",
          );
          assert.ok(
            snapshot.tokens.every((token) =>
              peerAgent && token.index === peerAgent.credentialIndex
                ? token.revoked === false
                : token.revoked === true,
            ),
            "Only the independently admitted peer credential may remain active",
          );
          return Date.now() >= observationEnds ? true : undefined;
        },
        5_000,
      );
      assert.deepEqual((await readPolicy()).policy.repositoryNetworkPolicy, []);
      if (peerAgent) {
        assert.equal(
          origin.snapshot().tokens.find((token) => token.index === peerAgent.credentialIndex)
            ?.revoked,
          false,
        );
        await peerAgent.prove("after-stop");
        const peerStopped = await request(
          "POST",
          `${peerAgent.deployed.path}/stop?expectedActiveRevisionId=${encodeURIComponent(peerAgent.deployed.revision.id)}`,
        );
        assert.equal(peerStopped.desiredRuntimeState, "stopped");
        await retire(peerAgent.deployed, peerAgent.provider, peerAgent.credentialIndex, {
          path: peerAgent.deployed.path,
          workspace: peerAgent.workspace,
          agentId: peerAgent.deployed.agent.id,
        });
        t.diagnostic(
          "A separately admitted Agent retained fresh authorized Git in its own workspace before and after primary downgrade and Stop",
        );
      }
      t.diagnostic(
        "Saved Git ACL clear persisted; deploy refused deny-all and explicit Stop retired both generations",
      );
    }),
  );
}
