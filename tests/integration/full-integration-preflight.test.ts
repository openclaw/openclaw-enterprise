import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertNetworkProxyAcceptance,
  assertSourceRef,
  requiredEnvironmentsForLane,
  selectLane,
  validateEnvironmentPolicy,
  validateFullIntegrationPreflight,
} from "../../scripts/ci/full-integration-preflight.ts";
import {
  networkProxyAcceptance,
  assertAcceptanceWindow,
  slackRead,
  validateAcceptanceHello,
  validateClearanceEvidence,
  verifyAcceptanceIdentities,
  verifyAcceptanceSource,
  verifyAcceptanceDispatch,
  verifySlackQuarantine,
} from "../../scripts/ci/network-proxy-acceptance.ts";
import {
  acceptanceAuthor,
  captureAcceptanceRoots,
  reconcileAcceptanceActivity,
} from "../../scripts/ci/network-proxy-acceptance-ledger.ts";
import {
  assertObservedActivityPersists,
  recordAcceptanceTap,
} from "../../scripts/ci/network-proxy-acceptance-run.ts";

import {
  approvalApi,
  approvalEnvironment,
  approvalReview,
  integrationEnvironment,
  mainOnlyPolicies,
  mainRun,
} from "./full-integration-approval-fixture.ts";

test("network proxy acceptance is limited to the approved Slack dispatch boundary", () => {
  const allowed = {
    INPUT_NETWORK_PROXY_ACCEPTANCE: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    INPUT_LANE: "slack",
  };
  assert.doesNotThrow(() => assertNetworkProxyAcceptance(allowed));
  for (const change of [
    { INPUT_NETWORK_PROXY_ACCEPTANCE: "yes" },
    { GITHUB_EVENT_NAME: "schedule" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { INPUT_LANE: "all" },
  ]) {
    assert.throws(() => assertNetworkProxyAcceptance({ ...allowed, ...change }), {
      message: /first-attempt main dispatch/,
    });
  }
  assert.doesNotThrow(() =>
    assertNetworkProxyAcceptance({ INPUT_NETWORK_PROXY_ACCEPTANCE: "false" }),
  );
  assert.throws(
    () =>
      assertNetworkProxyAcceptance({
        INPUT_NETWORK_PROXY_ACCEPTANCE: "false",
        INPUT_NETWORK_PROXY_CLEARANCE_RUN: "42",
      }),
    /clearance requires/,
  );
  assert.doesNotThrow(() =>
    assertNetworkProxyAcceptance({ ...allowed, INPUT_NETWORK_PROXY_CLEARANCE_RUN: "42" }),
  );
});

test("acceptance dispatch admits only its immutable UTC activation interval", () => {
  const start = Date.parse(networkProxyAcceptance.startsAt);
  const end = Date.parse(networkProxyAcceptance.expiresAt);
  assert.throws(() => assertAcceptanceWindow(start - 1), /outside/);
  assert.doesNotThrow(() => assertAcceptanceWindow(start));
  assert.throws(() => assertAcceptanceWindow(end), /outside/);
});

test("acceptance refuses a dispatch created outside the interval even when execution starts inside it", async () => {
  const sha = "a".repeat(40);
  let created: string = networkProxyAcceptance.startsAt;
  const read = async () =>
    Response.json({
      id: 42,
      path: ".github/workflows/full-integration.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: sha,
      run_attempt: 1,
      display_title: `Network Proxy Acceptance ${networkProxyAcceptance.source}`,
      created_at: created,
    });
  const env = { GITHUB_RUN_ID: "42", GITHUB_SHA: sha };
  await verifyAcceptanceDispatch("reader", env, read);
  created = new Date(Date.parse(networkProxyAcceptance.startsAt) - 1000).toISOString();
  await assert.rejects(verifyAcceptanceDispatch("reader", env, read), /outside/);
  created = networkProxyAcceptance.expiresAt;
  await assert.rejects(verifyAcceptanceDispatch("reader", env, read), /outside/);
});

test("clearance approval binds independent VM and Socket evidence to the exact run and source", () => {
  const comment = `run=42 attempt=1 source=${networkProxyAcceptance.source}\nvm=https://github.com/openclaw/openclaw-enterprise/issues/1\nsocket=https://github.com/openclaw/openclaw-enterprise/issues/2`;
  assert.doesNotThrow(() => validateClearanceEvidence(comment, "42"));
  assert.throws(() => validateClearanceEvidence(comment, "43"), /exact run/);
  assert.throws(
    () => validateClearanceEvidence(comment.replace("socket=https", "other=https"), "42"),
    /independent VM and Socket/,
  );
  assert.throws(
    () => validateClearanceEvidence(comment + "?token=synthetic", "42"),
    /credential-free/,
  );
});

test("ordinary Slack refuses unresolved or unknown acceptance cleanup before fixture use", async () => {
  const source = networkProxyAcceptance.source;
  const provenance = { id: 42, head_branch: "main", head_sha: "a".repeat(40) };
  const marker = {
    name: `network-proxy-acceptance-posts-${source}`,
    expired: false,
    workflow_run: provenance,
  };
  const receipt = { version: 1, source, runId: "42", attempt: "1", cleanup: true };
  const archive = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('receipt.json',sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    { input: JSON.stringify(receipt) },
  ).stdout;
  const cleanup = {
    id: 123,
    name: `network-proxy-acceptance-cleanup-${source}`,
    expired: false,
    workflow_run: provenance,
    size_in_bytes: archive.length,
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
  };
  let markers: unknown[] = [];
  let cleanups: unknown[] = [];
  let run = {
    ...provenance,
    path: ".github/workflows/full-integration.yml",
    event: "workflow_dispatch",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    display_title: `Network Proxy Acceptance ${source}`,
  };
  let runs: (typeof run)[] = [];
  let acceptanceConclusion = "success";
  let deploymentRuns: number[] = [];
  let pendingId = 0;
  let jobReads = 0;
  const acceptanceName = `Execute approved network proxy acceptance / Slack Live Network Proxy Acceptance ${source}`;
  const read = async (url: string) => {
    if (url.endsWith("/artifacts/123/zip")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://fixture.blob.core.windows.net/receipt" },
      });
    }
    if (url === "https://fixture.blob.core.windows.net/receipt") {
      return new Response(archive);
    }
    if (url.includes("/deployments?environment=")) {
      return Response.json(
        deploymentRuns.map((id) => ({
          id: id + 1000,
          environment: "integration-main-approval",
          ref: "main",
          created_at: "2026-11-22T10:00:00Z",
        })),
      );
    }
    if (url.includes("/deployments/") && url.includes("/statuses")) {
      const id = Number(url.match(/deployments\/(\d+)/)?.[1]) - 1000;
      return Response.json(
        id === pendingId
          ? []
          : [
              {
                log_url: `https://github.com/openclaw/openclaw-enterprise/actions/runs/${id}/job/123`,
              },
            ],
      );
    }
    if (url.includes("/actions/workflows/full-integration.yml/runs")) {
      return Response.json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.includes("/attempts/")) {
      const id = Number(url.match(/runs\/(\d+)/)?.[1]);
      jobReads++;
      const selected = runs.find((item) => item.id === id);
      const target = selected?.display_title.match(/run ([0-9]+) attempt ([0-9]+)$/);
      const jobs = target
        ? [
            {
              name: `Execute approved network proxy acceptance / Slack Live Network Proxy Clearance ${source} run ${target[1]} attempt ${target[2]}`,
              status: "completed",
              conclusion: "success",
            },
          ]
        : [{ name: acceptanceName, status: "completed", conclusion: acceptanceConclusion }];
      return Response.json({ total_count: jobs.length, jobs });
    }
    if (url.includes("/actions/runs/")) {
      return Response.json(run);
    }
    const artifacts = url.includes("name=network-proxy-acceptance-posts-") ? markers : cleanups;
    return Response.json({ total_count: artifacts.length, artifacts });
  };
  const now = Date.parse(networkProxyAcceptance.startsAt) + 1000;
  const check = () => verifySlackQuarantine("reader", read, now);
  await check();
  runs = [{ ...run, id: 99, display_title: "Full Integration", status: "waiting" }];
  deploymentRuns = [99];
  pendingId = 99;
  await check();
  assert.equal(jobReads, 0, "Unrelated pending approvals must not trigger job history reads");
  pendingId = 0;
  runs = [run];
  deploymentRuns = [42];
  acceptanceConclusion = "skipped";
  await check();
  acceptanceConclusion = "success";
  await assert.rejects(check(), /acceptance marker is missing/);
  markers = [marker];
  await assert.rejects(check(), /verified acceptance cleanup is missing/);
  cleanups = [{ ...cleanup, workflow_run: { ...provenance, id: 43 } }];
  await assert.rejects(check(), /verified acceptance cleanup is missing/);
  cleanups = [{ ...cleanup, digest: `sha256:${"0".repeat(64)}` }];
  await assert.rejects(check(), /digest does not match/);
  cleanups = [cleanup];
  await check();
  acceptanceConclusion = "cancelled";
  await assert.rejects(check(), /active, cancelled/);
  markers = [];
  runs = [
    run,
    { ...run, id: 43, display_title: `Network Proxy Clearance ${source} run 42 attempt 1` },
  ];
  deploymentRuns = [42, 43];
  await check();
  runs = [{ ...run, id: 43, display_title: `Network Proxy Clearance ${source} run 42 attempt 1` }];
  await check();
  runs = [];
  await assert.rejects(check(), /protected dispatch is missing/);
  runs = [
    run,
    { ...run, id: 44 },
    { ...run, id: 45, display_title: `Network Proxy Clearance ${source} run 42 attempt 1` },
  ];
  deploymentRuns = [42, 44, 45];
  acceptanceConclusion = "success";
  await assert.rejects(check(), /acceptance marker is missing/);
  runs.push({
    ...run,
    id: 46,
    display_title: `Network Proxy Clearance ${source} run 44 attempt 1`,
  });
  deploymentRuns.push(46);
  await check();
  runs = [
    { ...run, run_attempt: 2 },
    { ...run, id: 45, display_title: `Network Proxy Clearance ${source} run 42 attempt 1` },
  ];
  deploymentRuns = [42, 45];
  await assert.rejects(check(), /active, cancelled, timed out, or retried/);
  runs.push({
    ...run,
    id: 46,
    display_title: `Network Proxy Clearance ${source} run 42 attempt 2`,
  });
  deploymentRuns.push(46);
  await check();

  runs = [run];
  deploymentRuns = [42];
  acceptanceConclusion = "success";
  run = { ...run, event: "push" };
  runs = [run];
  await assert.rejects(check(), /workflow run provenance is invalid/);
  await assert.rejects(
    verifySlackQuarantine("reader", async () => new Response(null, { status: 503 }), now),
    /HTTP 503/,
  );
});

test("network proxy acceptance refuses a changed PR head or missing exact-head green checks", async () => {
  const source = networkProxyAcceptance.source;
  let head: string = source;
  let smoke = "success";
  const read = async (url: string) => {
    if (url.includes("/pulls/")) {
      return Response.json({
        state: "open",
        draft: false,
        user: { login: "kevinlin-openai" },
        head: { sha: head, repo: { full_name: networkProxyAcceptance.repository } },
      });
    }
    if (url.includes("/actions/runs/")) {
      return Response.json({
        id: networkProxyAcceptance.ciRun,
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        head_sha: source,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        check_suite_id: networkProxyAcceptance.ciSuite,
      });
    }
    const check_runs = [
      ["CI Required", 137044220983],
      ["First Agent Smoke", 137042487295],
    ].map(([name, id]) => ({
      id,
      name,
      head_sha: source,
      status: "completed",
      conclusion: name === "First Agent Smoke" ? smoke : "success",
      app: { id: networkProxyAcceptance.actionsApp, slug: "github-actions" },
      check_suite: { id: networkProxyAcceptance.ciSuite },
      details_url: `https://github.com/${networkProxyAcceptance.repository}/actions/runs/${networkProxyAcceptance.ciRun}/job/${id}`,
    }));
    return Response.json({ total_count: check_runs.length, check_runs });
  };
  await verifyAcceptanceSource("synthetic-read-token", read);
  head = "0".repeat(40);
  await assert.rejects(verifyAcceptanceSource("synthetic-read-token", read), /exact head changed/);
  head = source;
  smoke = "failure";
  await assert.rejects(verifyAcceptanceSource("synthetic-read-token", read), /First Agent Smoke/);
});

test("network proxy acceptance stops on mismatched protected Slack identities before channel access", async () => {
  const calls: string[] = [];
  const read = async (url: string, init?: RequestInit) => {
    calls.push(new URL(url).pathname);
    const receiver = new Headers(init?.headers).get("authorization") === "Bearer receiver";
    return Response.json({
      ok: true,
      team_id: networkProxyAcceptance.team,
      user_id: receiver ? networkProxyAcceptance.receiver : "UWRONG",
    });
  };
  await assert.rejects(
    verifyAcceptanceIdentities("receiver", "sender", networkProxyAcceptance.channel, read),
    /fixture identities/,
  );
  assert.deepEqual(calls, ["/api/auth.test", "/api/auth.test"]);
});

test("acceptance ledger counts null-user Gateway roots and replies on pre-existing threads", async () => {
  const receiver = {
    user: null,
    bot_id: networkProxyAcceptance.receiverBot,
    app_id: networkProxyAcceptance.app,
  };
  const sender = {
    user: networkProxyAcceptance.sender,
    bot_id: networkProxyAcceptance.senderBot,
    app_id: networkProxyAcceptance.senderApp,
  };
  assert.equal(acceptanceAuthor(receiver), "receiver");
  const read = async (method: string) =>
    method === "conversations.history"
      ? {
          messages: [
            { ts: "101.000002", ...sender },
            { ts: "101.000001", ...receiver },
            { ts: "100.000001", reply_count: 1, latest_reply: "102.000001" },
          ],
        }
      : { messages: [{ ts: "102.000001", thread_ts: "100.000001", ...receiver }] };
  const inventory = { "100.000001": { replies: 0, latest: null } };
  assert.deepEqual(await reconcileAcceptanceActivity("observer", "101.000000", inventory, read), {
    total: 3,
    receiver: 2,
    sender: 1,
    seenIds: ["101.000001", "101.000002", "102.000001"],
  });
  await assert.rejects(
    reconcileAcceptanceActivity("observer", "101.000000", inventory, async () => ({
      messages: [],
      has_more: true,
    })),
    /cursor is incomplete/,
  );
  assert.throws(() => acceptanceAuthor({ user: "UOTHER" }), /Unexpected/);
});

test("acceptance root baseline completes a mature three-page channel inventory", async () => {
  const roots = Array.from({ length: 560 }, (_, index) => ({
    ts: `${1000 - index}.000001`,
    reply_count: 0,
  }));
  let calls = 0;
  const read = async (_method: string, _token: string, fields: Record<string, string>) => {
    calls++;
    const offset = Number(fields.cursor ?? 0);
    const next = offset + 200 < roots.length ? String(offset + 200) : "";
    return {
      messages: roots.slice(offset, offset + 200),
      has_more: !!next,
      response_metadata: { next_cursor: next },
    };
  };
  assert.equal(
    Object.keys(await captureAcceptanceRoots("observer", "2000.000000", read)).length,
    560,
  );
  assert.equal(calls, 4, "three pages plus the pagination-consistency check");
});

test("acceptance refuses extra Socket Mode consumers and never retries a Slack write method", async () => {
  validateAcceptanceHello({
    type: "hello",
    num_connections: 1,
    connection_info: { app_id: networkProxyAcceptance.app },
  });
  assert.throws(
    () =>
      validateAcceptanceHello({
        type: "hello",
        num_connections: 2,
        connection_info: { app_id: networkProxyAcceptance.app },
      }),
    { message: /exactly the approved isolated app connection/ },
  );
  let calls = 0;
  await assert.rejects(
    slackRead("chat.postMessage", "synthetic", {}, async () => {
      calls++;
      return Response.json({ ok: true });
    }),
    { message: /Only approved Slack read methods/ },
  );
  assert.equal(calls, 0);
});

test("acceptance TAP evidence distinguishes selected skips from unrelated filtered skips", () => {
  const result = {
    tests: 0,
    pass: 0,
    skipped: 0,
    selected: [] as string[],
    selectedSkipped: [] as string[],
  };
  recordAcceptanceTap(result, "ok 1 - unrelated # SKIP test name does not match", ["selected"]);
  recordAcceptanceTap(result, "ok 2 - selected # SKIP missing prerequisite", ["selected"]);
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.selectedSkipped, ["selected"]);
});

test("acceptance refuses disappearance of an already observed new root or reply", () => {
  const previous = { seen: ["101.000001"], observed: { total: 1, sender: 0, receiver: 1 } };
  assert.throws(
    () =>
      assertObservedActivityPersists(previous, { seenIds: [], total: 0, sender: 0, receiver: 0 }),
    /disappeared/,
  );
});

const credentialedLanes = [
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "gateway-routing",
  "production-tui",
  "slack",
  "openshell",
  "k3d-otel",
];

test("full integration preflight selects automatic main pushes and manual main lanes", () => {
  assert.equal(selectLane({ eventName: "push", ref: "refs/heads/main" }), "all");
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "docker-model" }),
    "docker-model",
  );
  for (const eventName of ["pull_request", "pull_request_target"]) {
    assert.throws(() => selectLane({ eventName, ref: "refs/heads/main" }), /Unsupported/);
  }
  assert.throws(
    () =>
      selectLane({ eventName: "push", ref: "refs/heads/dev/kevinlin/integration-main-cutover" }),
    /Unsupported/,
  );
  assert.throws(() => requiredEnvironmentsForLane("provider-account"), /Unknown lane/);
  for (const lane of [...credentialedLanes, "all"]) {
    assert.deepEqual(requiredEnvironmentsForLane(lane), ["integration-main"]);
  }
  for (const lane of [
    "helper-timeout",
    "logging-collector",
    "dev-up-k3d",
    "skipper-prepared-git-installed",
  ]) {
    assert.deepEqual(requiredEnvironmentsForLane(lane), []);
  }
});

test("integration environment policy rejects broad, incomplete or bypassable rules", () => {
  assert.doesNotThrow(() =>
    validateEnvironmentPolicy("integration-main", integrationEnvironment(), mainOnlyPolicies),
  );
  for (const can_admins_bypass of [undefined, true]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy(
          "integration-main",
          integrationEnvironment({ can_admins_bypass }),
          mainOnlyPolicies,
        ),
      /disable administrator bypass/,
    );
  }
  for (const deployment_branch_policy of [
    null,
    { custom_branch_policies: false, protected_branches: true },
    { custom_branch_policies: true, protected_branches: true },
  ]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy(
          "integration-main",
          integrationEnvironment({ deployment_branch_policy }),
          mainOnlyPolicies,
        ),
      /main-only policy/,
    );
  }
  assert.throws(
    () => validateEnvironmentPolicy("integration-main", approvalEnvironment, mainOnlyPolicies),
    /must not require reviewers/,
  );
  for (const policies of [
    undefined,
    { total_count: 0, branch_policies: [] },
    { total_count: 2, branch_policies: mainOnlyPolicies.branch_policies },
    { branch_policies: mainOnlyPolicies.branch_policies },
    { total_count: 1, branch_policies: [{ name: "main", type: "tag" }] },
    { total_count: 1, branch_policies: [{ name: "main" }] },
    ...["*", "release", "refs/pull/*/merge", "dev/kevinlin/integration-main-cutover", "main"].map(
      (name) => ({
        total_count: 2,
        branch_policies: [...mainOnlyPolicies.branch_policies, { name, type: "branch" }],
      }),
    ),
  ]) {
    assert.throws(
      () => validateEnvironmentPolicy("integration-main", integrationEnvironment(), policies),
      /only the main branch/,
    );
  }
});

test("verified docs pushes omit runtime lanes while keeping environment policy checks", async () => {
  const fetched: string[] = [];
  assert.deepEqual(
    await validateFullIntegrationPreflight({
      env: mainRun,
      github: approvalApi({}, fetched),
      impactMode: "docs",
    }),
    { selectedLane: "docs", runAll: false },
  );
  assert.deepEqual(fetched, [
    "/environments/integration-main",
    "/environments/integration-main/deployment-branch-policies",
  ]);
  await assert.rejects(
    validateFullIntegrationPreflight({
      env: mainRun,
      github: approvalApi({
        "/environments/integration-main": { ...integrationEnvironment(), can_admins_bypass: true },
      }),
      impactMode: "docs",
    }),
    /disable administrator bypass/,
  );
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "all", impactMode: "docs" }),
    "all",
  );
  assert.equal(
    selectLane({ eventName: "push", ref: "refs/heads/main", impactMode: "tests" }),
    "all",
  );
});

test("main pushes and retries require no manual approval or team credential", async () => {
  for (const attempt of ["1", "2"]) {
    const fetched: string[] = [];
    assert.deepEqual(
      await validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_RUN_ATTEMPT: attempt },
        github: approvalApi({}, fetched),
      }),
      { selectedLane: "all", runAll: true },
    );
    assert.deepEqual(fetched, [
      "/environments/integration-main",
      "/environments/integration-main/deployment-branch-policies",
    ]);
  }
});

test("manual preflight checks native team approval before reading integration credentials policy", async () => {
  for (const lane of [
    ...credentialedLanes,
    "all",
    "dev-up-k3d",
    "skipper-prepared-git-installed",
  ]) {
    const fetched: string[] = [];
    assert.deepEqual(
      await validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_LANE: lane },
        github: approvalApi({}, fetched),
      }),
      { selectedLane: lane, runAll: lane === "all" },
    );
    assert.deepEqual(fetched.slice(0, 3), [
      "/environments/integration-main-approval",
      "/environments/integration-main-approval/deployment-branch-policies",
      "/actions/runs/123/approvals",
    ]);
    assert.equal(
      fetched.includes("/environments/integration-main"),
      credentialedLanes.includes(lane) || lane === "all",
    );
  }
});

test("preflight denies foreign sources, old branch routes and manual reruns before metadata reads", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    for (const patch of [
      { GITHUB_REPOSITORY: "other-owner/openclaw-enterprise" },
      { GITHUB_REF: "refs/tags/main", GITHUB_REF_TYPE: "tag" },
      { GITHUB_REF_TYPE: undefined },
      { GITHUB_REF: "refs/pull/1/merge" },
      { GITHUB_REF: "refs/heads/dev/kevinlin/integration-main-cutover" },
      { GITHUB_REF: "refs/heads/reviewed-branch", INPUT_LANE: "dev-up-k3d" },
      { GITHUB_REF: "refs/heads/reviewed-branch", INPUT_LANE: "skipper-prepared-git-installed" },
      ...(eventName === "workflow_dispatch"
        ? [{ GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_RUN_ATTEMPT: undefined }]
        : []),
    ]) {
      const fetched: string[] = [];
      await assert.rejects(
        validateFullIntegrationPreflight({
          env: { ...mainRun, GITHUB_EVENT_NAME: eventName, ...patch },
          github: approvalApi({}, fetched),
        }),
        /main|this repository|reruns/,
      );
      assert.deepEqual(fetched, []);
    }
  }
  assert.throws(() => assertSourceRef("refs/heads/reviewed-branch"), /main/);
});

test("manual preflight binds review to original actor ID and actual triggering actor", async () => {
  for (const patch of [
    { GITHUB_TRIGGERING_ACTOR: "other-user" },
    { GITHUB_TRIGGERING_ACTOR: undefined },
    { GITHUB_ACTOR: undefined },
    { GITHUB_ACTOR_ID: undefined },
    { GITHUB_ACTOR_ID: "0" },
    { GITHUB_ACTOR_ID: "9007199254740992" },
    { GITHUB_RUN_ID: "123/approvals" },
  ]) {
    const fetched: string[] = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch", ...patch },
        github: approvalApi({}, fetched),
      }),
      /identified dispatcher/,
    );
    assert.deepEqual(fetched, []);
  }
});

test("manual preflight refuses missing, rejected, duplicate and wrong-identity reviews", async () => {
  for (const reviews of [
    [],
    null,
    {},
    [{ ...approvalReview, state: "pending" }],
    [{ ...approvalReview, state: "rejected" }],
    [approvalReview, approvalReview],
    [approvalReview, { ...approvalReview, state: "rejected" }],
    [{ ...approvalReview, user: { ...approvalReview.user, id: 43 } }],
    [{ ...approvalReview, user: { ...approvalReview.user, login: "other-user" } }],
    [{ ...approvalReview, user: undefined }],
    [{ ...approvalReview, environments: [{ id: 1, name: "integration-main-approval" }] }],
    [{ ...approvalReview, environments: [{ id: 26285522718, name: "other-environment" }] }],
  ]) {
    const fetched: string[] = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: approvalApi({ "/actions/runs/123/approvals": reviews }, fetched),
      }),
      /approval|approved environment review/,
    );
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

test("manual preflight rejects altered approval environment protection before history reads", async () => {
  for (const environment of [
    { ...approvalEnvironment, id: 1 },
    { ...approvalEnvironment, name: "other" },
    { ...approvalEnvironment, can_admins_bypass: true },
    { ...approvalEnvironment, protection_rules: [] },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: approvalEnvironment.protection_rules[0].reviewers,
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "Team", reviewer: { id: 1 } }],
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: 42 } }],
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [
            ...approvalEnvironment.protection_rules[0].reviewers,
            { type: "User", reviewer: { id: 42 } },
          ],
        },
      ],
    },
  ]) {
    const fetched: string[] = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: approvalApi({ "/environments/integration-main-approval": environment }, fetched),
      }),
      /approval|administrator bypass|main-only policy|main branch/,
    );
    assert.equal(fetched.includes("/actions/runs/123/approvals"), false);
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

test("manual approval API failures stop before protected environment access", async () => {
  for (const failurePath of [
    "/environments/integration-main-approval",
    "/environments/integration-main-approval/deployment-branch-policies",
    "/actions/runs/123/approvals",
  ]) {
    const fetched: string[] = [];
    const valid = approvalApi({}, fetched);
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: async (request) => {
          if (request.path === failurePath) {
            throw new Error("GitHub API unavailable");
          }
          return valid(request);
        },
      }),
      /API unavailable/,
    );
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});
