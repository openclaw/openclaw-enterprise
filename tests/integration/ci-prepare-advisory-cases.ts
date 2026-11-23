import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { asRecord } from "../../packages/utils/src/index.ts";
import { fixture } from "../helpers/ci-prepare-fixture.ts";
import { getJob, getSteps, parseWorkflow } from "./ci-prepare-inputs.ts";

const matrixJobs = ["local-installation", "qa", "openshell"] as const;
type EventName = "pull_request" | "push" | "schedule" | "workflow_dispatch";

// Only the Actions expression syntax and functions used by this workflow.
function evaluate(expression: unknown, context: object): unknown {
  assert.ok(typeof expression === "string" && expression, "Missing workflow expression");
  return runInNewContext(
    expression
      .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .replaceAll("labels.*.name", "labels.map(({ name }) => name)")
      .replace(/\.([a-zA-Z][\w]*-[\w-]+)/g, '["$1"]'),
    {
      // Actions label comparisons ignore case.
      contains: (list: string[], value: string) =>
        list.some((entry) => entry.toLowerCase() === value.toLowerCase()),
      always: () => true,
      format: (text: string, value: string) => text.replace("{0}", value),
      fromJSON: JSON.parse,
      ...context,
    },
  );
}

function bash(script: string, cwd: string, overrides: NodeJS.ProcessEnv) {
  const args = ["--noprofile", "--norc", "-e", "-c", script];
  const env = { ...process.env, ...overrides };
  return spawnSync("bash", args, { cwd, encoding: "utf8", env });
}

function qaRow(
  installation: "compose" | "kubernetes",
  preset: "Codex" | "OpenClaw",
  scenarios: string,
  focused: boolean,
) {
  return { installation, preset, scenarios, focused };
}
const fullQa = [
  qaRow("compose", "Codex", "console-secrets,agent-audit,http-chat", false),
  qaRow("kubernetes", "Codex", "console-secrets,http-chat", false),
  qaRow("kubernetes", "OpenClaw", "http-chat", true),
  qaRow("compose", "OpenClaw", "http-chat", true),
];

const manifestDirectory = "scripts/ci/test-suites";

function parseManifest(text: string): { files: { path: string; expectedTests?: unknown }[] } {
  const value: unknown = JSON.parse(text);
  const manifest = asRecord(value);
  const files = manifest?.files;
  assert.ok(manifest && Array.isArray(files));
  return {
    ...manifest,
    files: files.map((file: unknown) => {
      const entry = asRecord(file);
      const path = entry?.path;
      assert.ok(entry && typeof path === "string");
      return { ...entry, path };
    }),
  };
}

async function createPrMerge(repo: string, root: string) {
  const source = join(root, "source");
  await mkdir(source);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");

  await mkdir(join(source, manifestDirectory), { recursive: true });
  async function copyManifest(lane: string) {
    const path = join(manifestDirectory, lane + ".json");
    const text = await readFile(join(repo, path), "utf8");
    await writeFile(join(source, path), text);
    return parseManifest(text).files;
  }
  const openshellFiles = await copyManifest("openshell");
  const full = {
    "local-installation": (await copyManifest("dev-up-k3d")).map(({ path }) => path),
    qa: fullQa,
    openshell: openshellFiles.map(({ path }) => path),
  };
  await copyManifest("gateway-routing");
  await copyManifest("qa-matrix");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(source, "checkout", "-b", "feature");
  git(source, "commit", "--allow-empty", "-m", "head");
  const head = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "main");
  git(source, "commit", "--allow-empty", "-m", "base advance");
  const base = git(source, "rev-parse", "HEAD");
  git(source, "merge", "--no-ff", "feature", "-m", "merge");
  const sha = git(source, "rev-parse", "HEAD");
  // Checkout uses shallow history: parent identity must come from the commit headers.
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  git(checkout, "init", "-b", "main");
  const copyObject = (type: string, object: string) => {
    const bytes = execFileSync("git", ["cat-file", type, object], { cwd: source });
    const written = execFileSync("git", ["hash-object", "-t", type, "-w", "--stdin"], {
      cwd: checkout,
      input: bytes,
      encoding: "utf8",
    }).trim();
    assert.equal(written, object);
  };
  copyObject("commit", sha);
  copyObject("tree", git(source, "rev-parse", `${sha}^{tree}`));
  for (const row of git(source, "ls-tree", "-r", "-t", sha).split("\n")) {
    const [, type, object] = row.split(/\s+/, 3);
    assert.ok(type && object);
    copyObject(type, object);
  }
  await writeFile(join(checkout, ".git", "shallow"), sha + "\n");
  git(checkout, "checkout", "--detach", sha);
  assert.equal(git(checkout, "rev-parse", "--is-shallow-repository"), "true");
  for (const parent of [base, head]) {
    assert.notEqual(spawnSync("git", ["cat-file", "-e", parent], { cwd: checkout }).status, 0);
  }
  return { checkout, base, head, sha, full, openshellFiles };
}

export function registerAdvisoryCases(repo: string) {
  async function loadAdvisoryWorkflow() {
    const yaml = await readFile(join(repo, ".github/workflows/qa-advisory.yml"), "utf8");
    const workflow = parseWorkflow(yaml);
    const qa = getJob(workflow, "qa");
    const steps = getSteps(qa);
    const selected = steps.find(({ name }) => name === "Materialize focused OpenClaw credentials");
    const ordinary = steps.find(({ name }) => name === "Materialize selected QA credentials");
    assert.ok(selected && ordinary);
    return { workflow, selected, ordinary };
  }
  test("advisory labels select only requested jobs and bind focused proof to the PR merge", async (t) => {
    const { workflow, selected, ordinary } = await loadAdvisoryWorkflow();
    const eligibility = getJob(workflow, "eligibility");
    const qa = getJob(workflow, "qa");
    const selector = getSteps(eligibility).find(({ id }) => id === "selection")?.run;
    assert.ok(typeof selector === "string" && selector);
    const prEnv = "integration-qa-pr";
    const gateway = getJob(workflow, "oidc-agent-chat");
    const gatewaySteps = getSteps(gateway);
    const gatewayAction = gatewaySteps.find(({ id }) => id === "native-browser-lane");
    const media = gatewaySteps.find(({ name }) => name === "Retain native browser review media");
    const mediaMissing = asRecord(media?.with)?.["if-no-files-found"];
    const gatewayFile = asRecord(gatewayAction?.with)?.["test-file"];
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.equal(eligibility.environment, undefined);
    assert.equal(gateway.environment, prEnv);
    assert.equal(gatewayAction?.uses, "./.github/actions/run-ci-lane");
    assert.partialDeepStrictEqual(gatewayAction?.with, {
      lane: "gateway-routing",
      profile: "full",
    });
    const local = getJob(workflow, "local-installation");
    const shard = "${{ matrix.shard }}";
    const file = "${{ matrix.file }}";
    // Matrix selection must reach the same narrow leaf invocation and isolated evidence.
    for (const [job, runner, env, lane, testFile, artifact] of [
      [getJob(workflow, "openshell"), "ubuntu-24.04", prEnv, "openshell", file, shard],
      [local, "ubuntu-22.04", undefined, "dev-up-k3d", file, "local-installation-" + shard],
      [
        qa,
        "blacksmith-8vcpu-ubuntu-2404",
        prEnv,
        "qa-matrix",
        "tests/integration/qa-matrix-real.test.mjs",
        "${{ matrix.installation }}-${{ matrix.preset }}",
      ],
    ] as const) {
      assert.equal(job["runs-on"], runner);
      assert.equal(job.environment, env);
      assert.equal(asRecord(job.strategy)?.["fail-fast"], false);
      const action = getSteps(job).find((step) => step.uses === "./.github/actions/run-ci-lane");
      const prefix = "qa-advisory-" + artifact;
      assert.partialDeepStrictEqual(action?.with, {
        lane,
        "test-file": testFile,
        "artifact-prefix": prefix,
      });
    }
    const root = await fixture(t);
    const { base, head, sha, checkout, full, openshellFiles } = await createPrMerge(repo, root);
    const event = (
      labels: readonly string[],
      {
        author = "contributor",
        repo = "example/oce",
        baseSha = base,
        testFile = undefined,
      }: { author?: string; repo?: string; baseSha?: string; testFile?: string | undefined } = {},
    ) => ({
      action: "synchronize",
      number: 7,
      inputs: testFile === undefined ? undefined : { test_file: testFile },
      pull_request: {
        user: { login: author },
        labels: labels.map((name) => ({ name })),
        base: { sha: baseSha },
        head: { sha: head, repo: { full_name: repo } },
      },
    });
    const context = (
      payload: ReturnType<typeof event>,
      name: EventName = "pull_request",
      actor = "contributor",
    ) => ({
      github: {
        event: payload,
        event_name: name,
        ref: name === "pull_request" ? "refs/pull/7/merge" : "refs/heads/main",
        repository: "example/oce",
        actor,
        sha,
        run_id: "123",
      },
      vars: { QA_ADVISORY_ON_PUSH: "true" },
    });
    const keycloak = "qa-keycloak-installation";
    const model = "qa-openclaw-model-ui";
    const compose = "qa-openshell-compose";
    const input = join(root, "event.json");
    const output = join(root, "output");
    const summary = join(root, "summary");
    const run = async (
      payload: ReturnType<typeof event>,
      name: EventName = "pull_request",
      overrides: NodeJS.ProcessEnv = {},
    ) => {
      await writeFile(input, JSON.stringify(payload));
      await writeFile(output, "");
      await writeFile(summary, "");
      const { github } = context(payload, name);
      const result = bash(selector, checkout, {
        GITHUB_EVENT_PATH: input,
        GITHUB_EVENT_NAME: name,
        GITHUB_REF: github.ref,
        GITHUB_SHA: github.sha,
        GITHUB_RUN_ID: github.run_id,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...overrides,
      });
      return {
        ...result,
        output: await readFile(output, "utf8"),
        summary: await readFile(summary, "utf8"),
      };
    };
    const keycloakFile = "tests/integration/dev-up-k3d-keycloak-real.test.ts";
    const keycloakOnly = { "local-installation": [keycloakFile] };
    const openshellFile = "tests/integration/local-first-agent-openshell-real.test.mjs";
    const openshell = [openshellFile];
    const modelOnly = { qa: [qaRow("kubernetes", "OpenClaw", "model-ui", true)] };
    const keycloakModel = { ...keycloakOnly, ...modelOnly };
    const routingFile = "tests/integration/harness-topology-k3d-routing-real.test.mjs";
    const browserFile = "tests/integration/oidc-agent-chat-k3d-real.test.ts";
    const qaFile = "tests/integration/qa-matrix-real.test.mjs";
    const ranked = openshellFiles
      .map(({ path, expectedTests }) => ({
        path,
        count: Array.isArray(expectedTests) ? expectedTests.length : 0,
      }))
      .sort((a, b) => b.count - a.count);
    const largest = ranked[0]?.path;
    const first = full.openshell[0];
    assert.ok(first && largest);
    const scheduled = { ...full, openshell: [...full.openshell] };
    scheduled.openshell[0] = largest;
    scheduled.openshell[full.openshell.indexOf(largest)] = first;
    type Selection = [
      labels: string[],
      expected: Partial<typeof full>,
      name?: EventName,
      input?: string,
      gatewaySelection?: { file: string; media: boolean },
    ];
    const cases: Selection[] = [
      [["Full-QA", model], full],
      [["QA-Keycloak-Installation", "qa-OpenClaw-model-ui"], keycloakModel],
      [[keycloak, "QA-KEYCLOAK-INSTALLATION"], keycloakOnly],
      [[keycloak], keycloakOnly],
      [[model], modelOnly],
      [[compose], { openshell }],
      [[keycloak, model], keycloakModel],
      [[compose, model], { openshell, ...modelOnly }],
      [[compose, keycloak], { openshell, ...keycloakOnly }],
      [[compose, keycloak, model], { openshell, ...keycloakModel }],
      [["full-qa"], full],
      [["full-qa", compose, keycloak, model], full],
      [[], scheduled, "schedule"],
      [[], full, "workflow_dispatch"],
      [[], full, "workflow_dispatch", ""],
      [[], full, "workflow_dispatch", "all"],
      [[], {}, "workflow_dispatch", routingFile, { file: routingFile, media: false }],
      [[], {}, "workflow_dispatch", browserFile, { file: browserFile, media: true }],
      [[], { openshell }, "workflow_dispatch", openshellFile],
      [[], keycloakOnly, "workflow_dispatch", keycloakFile],
      [[], { qa: fullQa }, "workflow_dispatch", qaFile],
      [[], scheduled, "schedule", routingFile],
      [[keycloak], keycloakOnly, "pull_request", routingFile],
      [[], { ...full, "local-installation": [] }, "push"],
      [[], { ...full, "local-installation": [] }, "push", routingFile],
    ];
    for (const [labels, expected, name = "pull_request", testFile, gatewaySelection] of cases) {
      const isFull = name !== "pull_request" || labels.some((s) => s.toLowerCase() === "full-qa");
      const payload = event(labels, { testFile });
      const ctx = context(payload, name);
      assert.equal(evaluate(eligibility.if, ctx), true);
      const result = await run(payload, name);
      assert.equal(result.status, 0, result.stderr);
      const stepOutputs: Record<string, string> = {};
      for (const entry of result.output.trimEnd().split("\n")) {
        const at = entry.indexOf("=");
        assert.ok(at > 0, "Expected name=value in GITHUB_OUTPUT");
        stepOutputs[entry.slice(0, at)] = entry.slice(at + 1);
      }
      const selection = { ...ctx, steps: { selection: { outputs: stepOutputs } } };
      const declaredOutputs = asRecord(eligibility.outputs);
      assert.ok(declaredOutputs);
      const outputs = Object.fromEntries(
        Object.entries(declaredOutputs).map(([key, expr]) => [
          key,
          evaluate(expr, selection) ?? "",
        ]),
      );
      const jobContext = { ...ctx, needs: { eligibility: { outputs } } };
      const selectedManual = name === "workflow_dispatch" && testFile && testFile !== "all";
      const gatewayEnabled = selectedManual ? gatewaySelection !== undefined : isFull;
      assert.equal(evaluate(gateway.if, jobContext), gatewayEnabled);
      if (gatewayEnabled) {
        assert.equal(
          gatewayFile === undefined ? "" : evaluate(gatewayFile, jobContext),
          gatewaySelection?.file ?? "",
          "The selected gateway file must reach the existing lane action",
        );
        for (const outcome of ["success", "failure"]) {
          const mediaContext = {
            ...jobContext,
            steps: { "native-browser-lane": { outcome } },
          };
          assert.equal(evaluate(media?.if, mediaContext), true);
          assert.equal(
            evaluate(mediaMissing, mediaContext),
            outcome === "success" && gatewaySelection?.media !== false ? "error" : "warn",
          );
        }
      }
      for (const group of matrixJobs) {
        const job = getJob(workflow, group);
        const label = [name, ...labels, group].join("/");
        const enabled = Boolean(expected[group]?.length);
        assert.equal(evaluate(job.if, jobContext), enabled, label);
        if (!enabled) {
          continue;
        }
        const rows = asRecord(evaluate(asRecord(job.strategy)?.matrix, jobContext))?.include;
        assert.ok(Array.isArray(rows), label);
        if (group !== "qa") {
          const files = rows.map(asRecord);
          const paths = files.map((row) => row?.file);
          assert.deepEqual(paths, expected[group], label);
          assert.equal(new Set(files.map((row) => row?.shard)).size, rows.length, label);
          continue;
        }
        assert.deepEqual(rows, expected.qa, label);
        assert.ok(expected.qa, label);
        for (const matrix of expected.qa) {
          const rowContext = { ...jobContext, matrix };
          for (const [variable, value] of [
            ["OCC_TEST_QA_INSTALLATION", matrix.installation],
            ["OCC_TEST_QA_PRESET", matrix.preset],
            ["OCC_TEST_QA_SCENARIOS", matrix.scenarios],
            ["OCC_TEST_QA_SOURCE_SHA", matrix.focused ? sha : "working-tree"],
            ["OCC_TEST_BROWSER_EXECUTABLE", matrix.focused ? "/usr/bin/google-chrome" : ""],
          ] as const) {
            assert.equal(
              evaluate(asRecord(qa.env)?.[variable], rowContext),
              value,
              label + ": " + variable,
            );
          }
          assert.equal(evaluate(selected.if, rowContext), matrix.focused, label);
          assert.equal(evaluate(ordinary.if, rowContext), !matrix.focused, label);
        }
      }
      assert.match(result.summary, new RegExp(sha));
      if (!isFull) {
        assert.match(result.summary, new RegExp(base));
        assert.match(result.summary, new RegExp(head));
      }
    }
    // Admission and cancellation use the added label, while selection uses all current labels.
    const concurrencyGroup = asRecord(workflow.concurrency)?.group;
    assert.ok(typeof concurrencyGroup === "string", "Missing advisory concurrency group");
    for (const label of [keycloak, model, compose, "full-qa", "unrelated"]) {
      const payload = { ...event([keycloak, label]), action: "labeled", label: { name: label } };
      const ctx = context(payload);
      const allowed = label !== "unrelated";
      assert.equal(evaluate(eligibility.if, ctx), allowed);
      const group = concurrencyGroup.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
        String(evaluate(expression, ctx)),
      );
      assert.match(group, allowed ? /pr-7/ : /run-123/);
    }
    const bot = "dependabot[bot]";
    const manual = context(event([], { testFile: routingFile }), "workflow_dispatch");
    for (const ctx of [
      context(event([])),
      context(event([keycloak], { repo: "fork/oce" })),
      context(event([keycloak]), "pull_request", bot),
      context(event([keycloak], { author: bot })),
      { ...context(event([]), "push"), vars: { QA_ADVISORY_ON_PUSH: "false" } },
      context(event([], { testFile: routingFile }), "workflow_dispatch", bot),
      { ...manual, github: { ...manual.github, ref: "refs/heads/feature" } },
    ]) {
      assert.equal(evaluate(eligibility.if, ctx), false);
    }
    async function assertRefused(
      selection: ReturnType<typeof run>,
      reason: string,
      diagnostic?: RegExp,
    ) {
      const result = await selection;
      assert.notEqual(result.status, 0, reason);
      assert.equal(result.output, "", reason);
      assert.equal(result.summary, "", reason);
      if (diagnostic) {
        assert.match(result.stderr, diagnostic, reason);
      }
    }
    for (const path of [
      "tests/integration/unregistered.test.ts",
      routingFile + " ",
      routingFile + "\nqa=true",
    ]) {
      await assertRefused(
        run(event([], { testFile: path }), "workflow_dispatch"),
        "Invalid test_file",
        /test_file|selected file|manifest/i,
      );
    }
    await assertRefused(
      run(event([], { testFile: routingFile }), "workflow_dispatch", {
        GITHUB_REF: "refs/heads/feature",
      }),
      "Selected manual run from a branch",
    );
    const openshellManifest = join(checkout, manifestDirectory, "openshell.json");
    const registeredOpenshell = await readFile(openshellManifest, "utf8");
    try {
      const manifest = parseManifest(registeredOpenshell);
      // The first tied maximum trades slots with the first row; neither other row moves.
      const [firstFile, middle, firstMax, secondMax] = full.openshell;
      assert.ok(firstFile && middle && firstMax && secondMax);
      await writeFile(
        openshellManifest,
        JSON.stringify({
          ...manifest,
          files: [
            { path: firstFile },
            { path: middle, expectedTests: ["single case"] },
            { path: firstMax, expectedTests: ["first case", "second case"] },
            { path: secondMax, expectedTests: ["third case", "fourth case"] },
          ],
        }),
      );
      const tied = await run(event([]), "schedule");
      assert.equal(tied.status, 0, tied.stderr);
      const matrix = tied.output.split("\n").find((line) => line.startsWith("openshell-matrix="));
      assert.ok(matrix);
      const rows = asRecord(JSON.parse(matrix.slice("openshell-matrix=".length)))?.include;
      assert.ok(Array.isArray(rows));
      assert.deepEqual(
        rows.map((row: unknown) => asRecord(row)?.file),
        [firstMax, middle, firstFile, secondMax],
      );

      manifest.files.push({ path: routingFile });
      await writeFile(openshellManifest, JSON.stringify(manifest));
      await assertRefused(
        run(event([], { testFile: routingFile }), "workflow_dispatch"),
        "Ambiguous file across advisory jobs",
        /must match exactly one file/,
      );
    } finally {
      await writeFile(openshellManifest, registeredOpenshell);
    }
    await assertRefused(
      run(event([keycloak]), "pull_request", { GITHUB_SHA: head }),
      "Wrong checkout SHA",
    );
    await assertRefused(run(event([model], { baseSha: head })), "Wrong event base");
    // Full selection must reject an empty manifest; focused selection requires its fixed file.
    const notKeycloak = (path: string) => !path.includes("keycloak");
    for (const [lane, labels, keep, reason] of [
      ["openshell", ["full-qa"], () => false, "Empty OpenShell manifest"],
      ["dev-up-k3d", ["full-qa"], () => false, "Empty local installation manifest"],
      ["dev-up-k3d", [keycloak], notKeycloak, "Missing fixed file"],
    ] as const) {
      const path = join(checkout, manifestDirectory, lane + ".json");
      const original = await readFile(path, "utf8");
      try {
        const manifest = parseManifest(original);
        manifest.files = manifest.files.filter(({ path }) => keep(path));
        await writeFile(path, JSON.stringify(manifest));
        await assertRefused(run(event(labels)), reason);
      } finally {
        await writeFile(path, original);
      }
    }
  });

  test("focused advisory QA validates its inputs and materializes only the selected provider", async (t) => {
    const { workflow, selected, ordinary } = await loadAdvisoryWorkflow();
    const openai = { OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}" };
    assert.deepEqual(selected.env, openai);
    assert.deepEqual(ordinary.env, {
      CODEX_ACCESS_TOKEN: "${{ secrets.CODEX_ACCESS_TOKEN }}",
      ...openai,
    });
    assert.equal(selected.if, "matrix.focused");
    assert.equal(ordinary.if, "${{ !matrix.focused }}");
    assert.partialDeepStrictEqual(getJob(workflow, "qa").env, {
      OCC_TEST_QA_OPENAI_MODEL: "${{ matrix.focused && vars.OCC_TEST_OPENAI_MODEL || '' }}",
      OCC_TEST_QA_SOURCE_SHA: "${{ matrix.focused && github.sha || 'working-tree' }}",
    });
    const root = await fixture(t);
    const cases = [
      ["", "model", 1],
      ["key", " ", 1],
      ["synthetic-key", "synthetic-model", 0],
    ] as const;
    assert.ok(typeof selected.run === "string" && selected.run);
    for (const [index, [key, model, expected]] of cases.entries()) {
      const runRoot = join(root, String(index));
      await mkdir(runRoot);
      const environment = join(runRoot, "environment");
      const result = bash(selected.run, repo, {
        RUNNER_TEMP: runRoot,
        GITHUB_ENV: environment,
        OPENAI_API_KEY: key,
        CODEX_ACCESS_TOKEN: "",
        OCC_TEST_QA_INSTALLATION: "kubernetes",
        OCC_TEST_QA_PRESET: "OpenClaw",
        OCC_TEST_QA_SCENARIOS: "model-ui",
        OCC_TEST_QA_OPENAI_MODEL: model,
      });
      assert.equal(result.status, expected, result.stderr);
      if (expected === 0) {
        const entries = (await readFile(environment, "utf8")).trim();
        const path = /^OCC_TEST_QA_OPENAI_KEY_FILE=(.+)\nOCC_TEST_QA_ARTIFACTS=.*$/.exec(
          entries,
        )?.[1];
        assert.ok(path, "Expected exactly the key-file entry followed by the artifact entry");
        assert.equal(await readFile(path, "utf8"), key);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
        assert.ok(!result.stdout.includes(key));
      } else {
        await assert.rejects(stat(join(runRoot, "qa-matrix-credentials")), { code: "ENOENT" });
      }
    }
  });
}
