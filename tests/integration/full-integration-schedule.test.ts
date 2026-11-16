import assert from "node:assert/strict";
import test from "node:test";

import {
  validateFullIntegrationPreflight,
  type GithubReader,
} from "../../scripts/ci/full-integration-preflight.ts";

import { approvalApi, mainRun } from "./full-integration-approval-fixture.ts";

test("scheduled preflight admits the exact main SHA and fails closed on uncertain history", async (t) => {
  const sha = "a".repeat(40);
  const env = {
    ...mainRun,
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_SHA: sha,
    INPUT_LANE: "docker-model",
  };
  const main = (head = sha) => ({ ref: "refs/heads/main", object: { type: "commit", sha: head } });
  const sentinel = "synthetic-history-response";
  const fixtures = (
    mainReads: string[],
    artifactResponse?: () => { artifacts: string; total_count: number },
  ) => {
    const calls: string[] = [];
    const authorized = approvalApi();
    const github: GithubReader = async (request) => {
      calls.push(request.path);
      if (request.path === "/git/ref/heads/main") {
        return main(mainReads.shift());
      }
      if (request.path.startsWith("/actions/artifacts?")) {
        return artifactResponse ? artifactResponse() : { artifacts: [], total_count: 0 };
      }
      if (request.path.startsWith("/actions/workflows/351990468/runs?")) {
        return { workflow_runs: [], total_count: 0 };
      }
      return authorized(request);
    };
    return { calls, github };
  };
  const clean = fixtures([sha, sha, sha]);
  assert.deepEqual(await validateFullIntegrationPreflight({ env, github: clean.github }), {
    selectedLane: "all",
    runAll: true,
  });
  assert.deepEqual(
    clean.calls.filter((path) => path.startsWith("/environments")),
    ["/environments/integration-main", "/environments/integration-main/deployment-branch-policies"],
  );

  type PreviousRunFixture = {
    startedAgo: number;
    finishedAgo: number;
    active?: boolean;
    covered?: boolean;
    split?: boolean;
    id?: number;
    event?: string;
  };
  const previousRun = ({
    startedAgo,
    finishedAgo,
    active = false,
    covered = false,
    split = false,
    id = 99,
    event = "schedule",
  }: PreviousRunFixture) => {
    const earlier = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const repository = { id: 1350208775 };
    const run = {
      id,
      run_attempt: 1,
      workflow_id: 351990468,
      head_sha: sha,
      repository,
      head_repository: repository,
      head_branch: "main",
      event,
      status: active ? "in_progress" : "completed",
      conclusion: active ? null : "failure",
      updated_at: earlier(finishedAgo),
    };
    const job = (name: string, step: string | null, finished: number) => ({
      name,
      run_id: run.id,
      run_attempt: 1,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      started_at: earlier(startedAgo),
      completed_at: earlier(finished),
      steps: step
        ? [
            {
              name: step,
              status: "completed",
              conclusion: "success",
              completed_at: earlier(finished),
            },
          ]
        : [],
    });
    const prefix = split ? "Execute / " : "";
    const jobs = [
      ...(split ? [job("Dispatch Preflight", null, startedAgo + 1)] : []),
      job(prefix + "Dispatch Preflight", "Confirm full admission marker", startedAgo),
      job(prefix + "OpenShell (openshell-policy)", null, finishedAgo),
      job(prefix + "Full Integration Aggregate", "Confirm full coverage marker", finishedAgo),
    ];
    return async ({ path }: Parameters<GithubReader>[0]) => {
      if (path === "/git/ref/heads/main") {
        return main();
      }
      if (path.startsWith("/actions/artifacts?")) {
        const name = new URLSearchParams(path.split("?")[1]).get("name");
        if (name !== "full-integration-admitted-v1" && !covered) {
          return { artifacts: [], total_count: 0 };
        }
        return {
          total_count: 1,
          artifacts: [
            {
              id: 100 + id,
              name,
              expired: false,
              created_at: earlier(startedAgo),
              workflow_run: {
                id: run.id,
                repository_id: repository.id,
                head_repository_id: repository.id,
                head_branch: "main",
                head_sha: sha,
              },
            },
          ],
        };
      }
      if (path.startsWith("/actions/workflows/351990468/runs?")) {
        return event === "workflow_dispatch" && path.includes("event=workflow_dispatch")
          ? { workflow_runs: [run], total_count: 1 }
          : { workflow_runs: [], total_count: 0 };
      }
      if (path === `/actions/runs/${id}/attempts/1`) {
        return run;
      }
      if (path === `/actions/runs/${id}/attempts/1/jobs?per_page=100`) {
        return { jobs, total_count: jobs.length };
      }
      assert.fail(`Unexpected metadata read for skipped schedule: ${path}`);
    };
  };
  for (const [history, reason] of [
    [{ startedAgo: 40, finishedAgo: 30 }, "cooldown"],
    [{ startedAgo: 100, finishedAgo: 5 }, "cooldown"],
    [{ startedAgo: 100, finishedAgo: 5, split: true, event: "workflow_dispatch" }, "cooldown"],
    [{ startedAgo: 100, finishedAgo: 0, active: true }, "active-full"],
    [{ startedAgo: 100, finishedAgo: 80, covered: true }, "unchanged-main"],
    [{ startedAgo: 100, finishedAgo: 80, covered: true, split: true }, "unchanged-main"],
  ] as const) {
    assert.deepEqual(
      await validateFullIntegrationPreflight({ env, github: previousRun(history) }),
      {
        selectedLane: "skip",
        runAll: false,
        reason,
      },
    );
  }

  // A superseded split push can retain a started-at timestamp on its queued
  // reusable preflight even though no execution runner acquired the lock.
  const cancelledPush = {
    id: 97,
    run_attempt: 1,
    workflow_id: 351990468,
    head_sha: sha,
    repository: { id: 1350208775 },
    head_repository: { id: 1350208775 },
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "cancelled",
    updated_at: new Date().toISOString(),
  };
  const cancelledJobs = ["Dispatch Preflight", "Execute / Dispatch Preflight"].map(
    (name, index) => ({
      name,
      run_id: cancelledPush.id,
      run_attempt: 1,
      head_sha: sha,
      status: "completed",
      conclusion: index === 0 ? "success" : "cancelled",
      started_at: cancelledPush.updated_at,
      completed_at: cancelledPush.updated_at,
      steps: [],
    }),
  );
  const withoutExecution = fixtures([sha, sha, sha]);
  assert.deepEqual(
    await validateFullIntegrationPreflight({
      env,
      github: async (request) => {
        const { path } = request;
        if (path.startsWith("/actions/workflows/351990468/runs?") && path.includes("event=push")) {
          return { workflow_runs: [cancelledPush], total_count: 1 };
        }
        if (path === "/actions/runs/97/attempts/1") {
          return cancelledPush;
        }
        if (path === "/actions/runs/97/attempts/1/jobs?per_page=100") {
          return { jobs: cancelledJobs, total_count: cancelledJobs.length };
        }
        return withoutExecution.github(request);
      },
    }),
    { selectedLane: "all", runAll: true },
  );

  const olderAutomatic = previousRun({ id: 98, startedAgo: 160, finishedAgo: 2 });
  const newerManual = previousRun({
    id: 99,
    event: "workflow_dispatch",
    startedAgo: 110,
    finishedAgo: 80,
  });
  const overlapping: GithubReader = async (request) => {
    if (request.path.startsWith("/actions/artifacts?")) {
      const earlier = await olderAutomatic(request);
      const later = await newerManual(request);
      assert.ok("artifacts" in earlier && "artifacts" in later);
      return {
        total_count: earlier.total_count + later.total_count,
        artifacts: [...earlier.artifacts, ...later.artifacts],
      };
    }
    if (request.path.startsWith("/actions/runs/98/")) {
      return olderAutomatic(request);
    }
    if (request.path.startsWith("/environments/")) {
      return approvalApi()(request);
    }
    return newerManual(request);
  };
  assert.deepEqual(await validateFullIntegrationPreflight({ env, github: overlapping }), {
    selectedLane: "skip",
    runAll: false,
    reason: "cooldown",
  });

  const earlier = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  type ManualRun = {
    active?: boolean;
    finishedAgo?: number;
    result?: { conclusion?: string | null };
  };
  const manualHistory = (
    jobs: readonly (ReturnType<typeof job> & { steps?: readonly object[] | null })[],
    {
      active = true,
      finishedAgo = 0,
      result = { conclusion: active ? null : "success" },
    }: ManualRun = {},
  ): GithubReader => {
    const repository = { id: 1350208775 };
    const run = {
      id: 97,
      run_attempt: 1,
      workflow_id: 351990468,
      head_sha: sha,
      repository,
      head_repository: repository,
      head_branch: "main",
      event: "workflow_dispatch",
      status: active ? "in_progress" : "completed",
      ...result,
      updated_at: earlier(finishedAgo),
    };
    const { github } = fixtures([sha, sha, sha]);
    return async (request) => {
      const { path } = request;
      if (
        path.startsWith("/actions/workflows/351990468/runs?") &&
        path.includes("event=workflow_dispatch")
      ) {
        return { total_count: 1, workflow_runs: [run] };
      }
      if (path === "/actions/runs/97/attempts/1") {
        return run;
      }
      if (path === "/actions/runs/97/attempts/1/jobs?per_page=100") {
        return {
          total_count: jobs.length,
          jobs: jobs.map((job) => ({ run_id: run.id, run_attempt: 1, head_sha: sha, ...job })),
        };
      }
      return github(request);
    };
  };
  const job = (
    name: string,
    start: number | null,
    finish: number | null,
    conclusion: string | null = "success",
  ) => ({
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    started_at: start === null ? null : earlier(start),
    completed_at: finish === null ? null : earlier(finish),
  });
  const reuseName = "Execute / Reuse successful same-SHA CI";
  const imageName = "Execute / Shared Runtime Image / Build ordinary CI runtime";
  const approved = job("Approve manual integration", 125, 124);
  const preflight = job("Execute / Dispatch Preflight", 123, 122);
  const skippedReuse = job(reuseName, 121, 121, "skipped");
  const admitted = { selectedLane: "all", runAll: true };
  const skipped = (reason: string) => ({ selectedLane: "skip", runAll: false, reason });

  for (const lane of ["Gateway Routing", "Production TUI"]) {
    for (const active of [true, false]) {
      await t.test(
        `targeted ${lane} with shared image: ${active ? "live" : "completed"}`,
        async () => {
          // Both targeted lanes can build the image while the full-only job is skipped.
          const jobs = [
            approved,
            {
              ...preflight,
              steps: [
                { name: "Prepare fresh lane fallback", status: "completed", conclusion: "skipped" },
                {
                  name: "Prepare full admission marker",
                  status: "completed",
                  conclusion: "skipped",
                },
              ],
            },
            skippedReuse,
            job(imageName, 40, 35),
            job("Execute / " + lane, 34, active ? null : 10, active ? null : "success"),
          ];
          assert.deepEqual(
            await validateFullIntegrationPreflight({
              env,
              github: manualHistory(jobs, { active, finishedAgo: active ? 0 : 9 }),
            }),
            admitted,
          );
        },
      );
    }
  }

  await t.test("completed skipped reuse still requires a run conclusion", async () => {
    const github = manualHistory([preflight, skippedReuse, job(imageName, 8, 4)], {
      active: false,
      finishedAgo: 3,
      result: {},
    });
    await assert.rejects(
      validateFullIntegrationPreflight({ env, github }),
      /could not verify admission metadata/,
    );
  });

  for (const [startedAgo, finishedAgo, expected] of [
    [40, 20, skipped("cooldown")],
    [100, 5, skipped("cooldown")],
    [100, 20, admitted],
  ] as const) {
    await t.test(`unmarked full clock: start ${startedAgo}m, finish ${finishedAgo}m`, async () => {
      // Start is measured from suite work, excluding early preflight and CI reuse.
      const jobs = [
        approved,
        preflight,
        job(reuseName, 121, 110, startedAgo === 40 ? "failure" : "success"),
        job(imageName, startedAgo, startedAgo - 5),
        job("Execute / Gateway Routing", startedAgo - 4, finishedAgo + 1),
      ];
      assert.deepEqual(
        await validateFullIntegrationPreflight({
          env,
          github: manualHistory(jobs, { active: false, finishedAgo }),
        }),
        expected,
      );
    });
  }

  await t.test("completed full without reuse metadata keeps its cooldown", async () => {
    const jobs = [preflight, job(imageName, 30, 25), job("Execute / Runtime Image Fixture", 28, 2)];
    const github = manualHistory(jobs, { active: false, finishedAgo: 1 });
    assert.deepEqual(await validateFullIntegrationPreflight({ env, github }), skipped("cooldown"));
  });

  await t.test(
    "completed shared work without reuse metadata holds during the possible cooldown",
    async () => {
      const gateway = job("Execute / Gateway Routing", 39, 30);
      const recent = manualHistory([preflight, job(imageName, 45, 40), gateway], {
        active: false,
        finishedAgo: 29,
      });
      await assert.rejects(
        validateFullIntegrationPreflight({ env, github: recent }),
        /could not verify admission metadata/,
      );
      // A long attempt with the same finish is outside both cadence bounds.
      const expired = manualHistory([preflight, job(imageName, 70, 40), gateway], {
        active: false,
        finishedAgo: 29,
      });
      assert.deepEqual(await validateFullIntegrationPreflight({ env, github: expired }), admitted);
    },
  );

  // Marker upload is best effort. A skipped reuse job cannot undo earlier full selection.
  const preparation = job("Execute / Dispatch Preflight", 11, 10);
  const steps = [
    ["Prepare fresh lane fallback", "success"],
    ["Prepare full admission marker", "success"],
    ["Upload full admission marker", "failure"],
  ].map(([name, conclusion]) => ({
    name,
    status: "completed",
    conclusion,
    completed_at: preparation.completed_at,
  }));
  const preparedFullJobs = [
    { ...preparation, steps },
    job(imageName, 8, 4),
    job(reuseName, 3, 3, "skipped"),
  ];

  for (const [name, metadata] of [
    ["absent", {}],
    ["nonarray", { steps: null }],
    ["incomplete", { steps: [{ ...steps[0], conclusion: "skipped" }] }],
  ] as const) {
    await t.test(`live shared work with ${name} preparation metadata stays active`, async () => {
      // Cancellation can skip reuse before the run reaches its final conclusion.
      // Missing full-only steps do not establish that the caller selected a targeted lane.
      const jobs = [{ ...preparation, ...metadata }, ...preparedFullJobs.slice(1)];
      assert.deepEqual(
        await validateFullIntegrationPreflight({ env, github: manualHistory(jobs) }),
        skipped("active-full"),
      );
    });
  }

  for (const [name, active, result] of [
    ["cancelled", false, { conclusion: "cancelled" }],
    ["missing conclusion", false, {}],
    ["null conclusion", false, { conclusion: null }],
    ["still active", true, { conclusion: null }],
  ] as const) {
    await t.test(`skipped reuse after full preparation and shared work: ${name}`, async () => {
      const github = manualHistory(preparedFullJobs, { active, finishedAgo: 3, result });
      const admission = validateFullIntegrationPreflight({ env, github });
      if (active) {
        assert.deepEqual(await admission, skipped("active-full"));
      } else {
        await assert.rejects(admission, /could not verify admission metadata/);
      }
    });
  }

  await t.test("failed or cancelled preflight without suite work admits", async () => {
    for (const conclusion of ["failure", "cancelled"]) {
      const jobs = [approved, job("Dispatch Preflight", 10, 9, conclusion)];
      const github = manualHistory(jobs, { active: false, finishedAgo: 8, result: { conclusion } });
      assert.deepEqual(await validateFullIntegrationPreflight({ env, github }), admitted);
    }
  });

  for (const [name, jobs, expected] of [
    ["unapproved manual run", [], admitted],
    [
      "live true full",
      [approved, preflight, job(reuseName, 110, null, null)],
      skipped("active-full"),
    ],
    [
      "manual preflight still resolving selection",
      [approved, job("Execute / Dispatch Preflight", 123, null, null)],
      skipped("active-full"),
    ],
    [
      "shared build without a reuse record leaves selection uncertain",
      [approved, preflight, job(imageName, 40, 35)],
      skipped("active-full"),
    ],
    ["approved manual run with no visible selection", [approved], null],
    ["duplicate same-SHA CI reuse metadata", [preflight, skippedReuse, { ...skippedReuse }], null],
  ] as const) {
    await t.test(name, async () => {
      const result = validateFullIntegrationPreflight({ env, github: manualHistory(jobs) });
      if (expected === null) {
        await assert.rejects(result, /could not verify admission metadata/);
      } else {
        assert.deepEqual(await result, expected);
      }
    });
  }

  const moved = fixtures([sha, sha, "b".repeat(40)]);
  assert.deepEqual(await validateFullIntegrationPreflight({ env, github: moved.github }), {
    selectedLane: "skip",
    runAll: false,
    reason: "stale-event",
  });
  // The same marker lookup can reject or return unusable metadata. Neither
  // outcome may select a lane, read policy, or put supplied text in the error.
  for (const [kind, response] of [
    [
      "request-failed",
      () => {
        throw new Error(sentinel);
      },
    ],
    ["invalid-metadata", () => ({ artifacts: sentinel, total_count: 1 })],
  ] as const) {
    const unavailable = fixtures([sha], response);
    await assert.rejects(validateFullIntegrationPreflight({ env, github: unavailable.github }), {
      message: `Full Integration schedule could not verify admission metadata (admission-markers: ${kind}).`,
    });
    assert.deepEqual(unavailable.calls, [
      "/git/ref/heads/main",
      "/actions/artifacts?name=full-integration-admitted-v1&per_page=100",
    ]);
  }
  for (const [name, kind, response] of [
    ["malformed JSON", "invalid-metadata", () => new Response(sentinel)],
    ["HTTP failure", "request-failed", () => new Response(sentinel, { status: 503 })],
    [
      "transport SyntaxError",
      "request-failed",
      () => {
        throw new SyntaxError(sentinel);
      },
    ],
    [
      "body-read SyntaxError",
      "request-failed",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new SyntaxError(sentinel));
            },
          }),
        ),
    ],
  ] as const) {
    await t.test(`default GitHub reader classifies ${name}`, async (t) => {
      const calls: string[] = [];
      // Supply HTTP responses at the transport boundary so the production
      // reader must consume and decode the body before history classifies it.
      t.mock.method(globalThis, "fetch", async (url: string) => {
        const { pathname, search } = new URL(url);
        const path = pathname.slice("/repos/openclaw/openclaw-enterprise".length) + search;
        calls.push(path);
        return path === "/git/ref/heads/main" ? Response.json(main()) : response();
      });
      await assert.rejects(validateFullIntegrationPreflight({ env }), {
        message: `Full Integration schedule could not verify admission metadata (admission-markers: ${kind}).`,
      });
      assert.deepEqual(calls, [
        "/git/ref/heads/main",
        "/actions/artifacts?name=full-integration-admitted-v1&per_page=100",
      ]);
    });
  }
  await assert.rejects(
    validateFullIntegrationPreflight({
      env: { ...env, GITHUB_RUN_ATTEMPT: "2" },
      github: clean.github,
    }),
    /Scheduled integration reruns are refused/,
  );
});
