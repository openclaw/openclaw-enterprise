import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { parseDevUpResourceState } from "../helpers/dev-up-k3d-commands.ts";
import {
  createFixture,
  prepareLifecycleCommands,
  readJsonLines,
  runCommand,
  runDevDown,
  runDevUp,
  serviceKey,
} from "../helpers/dev-up.mjs";
import { requireLogRecord } from "../helpers/json-lines.ts";

type LifecycleScenario = NonNullable<Parameters<typeof prepareLifecycleCommands>[1]>;
type KubernetesFixture = Awaited<ReturnType<typeof createFixture>> & {
  start: (args?: string[]) => ReturnType<typeof runDevUp>;
};
type CreateKubernetesFixture = (
  context: TestContext,
  scenario?: LifecycleScenario,
) => Promise<KubernetesFixture>;

async function startWithDefaultStateDirectory(fixture: KubernetesFixture): Promise<string> {
  delete fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const started = await fixture.start();
  assert.equal(started.status, 0, started.stderr);
  return join(fixture.directory, "openclaw-development");
}

function freshShell(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A new shell exports no profile selectors; the recorded state still decides.
  const fresh = { ...env };
  delete fresh.OCC_DEVELOPMENT_COMPUTE_DRIVER;
  delete fresh.OCC_DEVELOPMENT_CONTROL_PLANE;
  delete fresh.OCC_DEVELOPMENT_SANDBOX_DRIVER;
  return fresh;
}

function stateDirectory(env: NodeJS.ProcessEnv): string {
  const directory = env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  assert.ok(directory, "The launcher fixture must select a state directory");
  return directory;
}

async function assertOnlyUnrelatedClusterRemains(env: NodeJS.ProcessEnv): Promise<void> {
  const ledger = env.DEV_UP_RESOURCE_STATE;
  assert.ok(ledger, "The launcher fixture must select a resource ledger");
  assert.deepEqual(parseDevUpResourceState(await readFile(ledger, "utf8")), {
    clusters: ["occ-dev-unrelated"],
    compose: false,
  });
}

type LifecycleInvocation = { command: string; args: string[] };

async function lifecycleInvocations(env: NodeJS.ProcessEnv): Promise<LifecycleInvocation[]> {
  const log = env.SAFETY_LOG;
  assert.ok(log, "The launcher fixture must select a command log");
  return (await readJsonLines(log)).map((value) => {
    const { command, args } = requireLogRecord(value);
    assert.ok(typeof command === "string" && Array.isArray(args), "Invalid lifecycle invocation");
    const argumentsRead: unknown[] = args;
    assert.ok(
      argumentsRead.every((argument): argument is string => typeof argument === "string"),
      "Invalid lifecycle command arguments",
    );
    return { command, args: argumentsRead };
  });
}

export function registerFreshShellCustodyCases(kubernetesFixture: CreateKubernetesFixture): void {
  test("dev-down from a fresh shell stops the recorded Kubernetes stack", async (t) => {
    const fixture = await kubernetesFixture(t);
    const directory = await startWithDefaultStateDirectory(fixture);
    assert.ok((await stat(directory)).isDirectory());

    const fresh = freshShell(fixture.env);
    const beforeCleanup = await lifecycleInvocations(fixture.env);
    const stopped = await runDevDown(fresh);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /Stopped Kubernetes development stack occ-dev-owned\./);
    assert.doesNotMatch(stopped.stdout, /Docker-compatible/);
    await assert.rejects(stat(directory), { code: "ENOENT" });
    await assertOnlyUnrelatedClusterRemains(fixture.env);
    const commands = (await lifecycleInvocations(fixture.env)).slice(beforeCleanup.length);
    assert.ok(commands.some(({ command, args }) => command === "k3d" && args.includes("delete")));
  });

  test("dev-down from a fresh shell in another checkout refuses the recorded Kubernetes stack", async (t) => {
    const fixture = await kubernetesFixture(t);
    const directory = await startWithDefaultStateDirectory(fixture);
    const statePath = join(directory, "state.json");
    const recordedState = await readFile(statePath, "utf8");

    // Every checkout shares the default state directory.
    const other = join(fixture.directory, "other-checkout");
    await mkdir(other);
    for (const source of ["go.mod", "compose.yaml"]) {
      await symlink(join(fixture.fixtureRepository, source), join(other, source));
    }
    const fresh = freshShell(fixture.env);
    const beforeCleanup = await lifecycleInvocations(fixture.env);
    const refused = await runCommand(fixture.cli, ["dev", "down"], { cwd: other, env: fresh });
    assert.notEqual(refused.status, 0);
    for (const expected of [
      `development state directory ${directory} records the Kubernetes development stack occ-dev-owned of checkout ${fixture.fixtureRepository}, not this checkout ${other}`,
      "occ dev down stopped nothing",
      `run occ dev down from ${fixture.fixtureRepository}`,
    ]) {
      assert.ok(refused.stderr.includes(expected), refused.stderr);
    }
    assert.equal(refused.stdout, "");
    assert.equal(await readFile(statePath, "utf8"), recordedState);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.deepEqual((await lifecycleInvocations(fixture.env)).slice(beforeCleanup.length), []);

    // An explicit Kubernetes selection still stops the recorded stack from here.
    const stopped = await runCommand(fixture.cli, ["dev", "down"], {
      cwd: other,
      env: { ...fresh, OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes" },
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /Stopped Kubernetes development stack occ-dev-owned\./);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  });
}

const rollbackCases = [
  { scenario: "compose-up-failed", diagnostic: /partial compose startup/ },
  { scenario: "cluster-create-failed", diagnostic: /partial cluster creation/ },
  { scenario: "node-dns-refused", diagnostic: /cannot resolve registry-1\.docker\.io/ },
  { scenario: "invalid-image-identity", diagnostic: /invalid local image identity/ },
  {
    scenario: "image-archive-missing-config",
    diagnostic: /prepare development image archive: image archive content .* is missing or invalid/,
  },
  { scenario: "api-mismatch", diagnostic: /invalid Installation ID/ },
  { scenario: "api-unauthorized", diagnostic: /authorization failed/ },
] as const satisfies readonly { scenario: LifecycleScenario; diagnostic: RegExp }[];

export function registerStackRollbackCases(kubernetesFixture: CreateKubernetesFixture): void {
  test("dev-down preserves Kubernetes state when Compute selector is docker", async (t) => {
    const fixture = await createFixture(t);
    await prepareLifecycleCommands(fixture);
    const directory = stateDirectory(fixture.env);
    await mkdir(directory, { mode: 0o700 });
    const result = await runDevDown({ ...fixture.env, OCC_DEVELOPMENT_COMPUTE_DRIVER: "docker" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await stat(directory)).isDirectory());
    const commands = await lifecycleInvocations(fixture.env);
    assert.equal(
      commands.some(({ command }) => command === "k3d"),
      false,
    );
    assert.ok(commands.some(({ command, args }) => command === "docker" && args.includes("down")));
  });

  for (const { scenario, diagnostic } of rollbackCases) {
    test(`Kubernetes dev-up rolls back owned resources after ${scenario}`, async (t) => {
      const fixture = await kubernetesFixture(t, scenario);
      const directory = stateDirectory(fixture.env);
      const keyOutput = join(fixture.directory, "retained-key.json");
      const result = await fixture.start(["--key-output", keyOutput]);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
      assert.match(result.stderr, diagnostic);
      if (scenario === "cluster-create-failed") {
        // k3d can fail with partial resources absent from its inventory. Retain
        // the recovery record until the operator explicitly retries cleanup.
        assert.match(result.stderr, /rollback incomplete; preserving/);
        assert.ok((await stat(directory)).isDirectory());
        const cleaned = await runDevDown(fixture.env);
        assert.equal(cleaned.status, 0, cleaned.stderr);
      }
      await assert.rejects(stat(directory), { code: "ENOENT" });
      await assertOnlyUnrelatedClusterRemains(fixture.env);

      if (scenario === "node-dns-refused") {
        // A node resolver that refuses queries stops startup before the first image pull.
        assert.match(result.stderr, /OCC_DEVELOPMENT_K3D_DNS_RESOLVER/);
        const commands = await lifecycleInvocations(fixture.env);
        assert.equal(
          commands.some(({ command, args }) => command === "k3d" && args[0] === "image"),
          false,
        );
      }
      if (scenario === "invalid-image-identity" || scenario === "image-archive-missing-config") {
        // These invalid inputs reach the actual Go validation. Neither refusal
        // may import an image or mutate a daemon tag before ordinary rollback.
        const commands = await lifecycleInvocations(fixture.env);
        assert.equal(
          commands.some(({ command, args }) => command === "k3d" && args[0] === "image"),
          false,
        );
        assert.equal(
          commands.some(
            ({ command, args }) =>
              command === "docker" &&
              (args[0] === "tag" || (args[0] === "image" && args[1] === "rm")),
          ),
          false,
        );
        const imageExports = commands.filter(
          ({ command, args }) => command === "docker" && args[0] === "image" && args[1] === "save",
        );
        assert.equal(imageExports.length, scenario === "invalid-image-identity" ? 0 : 1);
        if (scenario === "image-archive-missing-config") {
          const imageExport = imageExports[0];
          assert.ok(imageExport);
          assert.match(imageExport.args.at(-1) ?? "", /^sha256:[a-f0-9]{64}$/);
        }
      }
      if (scenario.startsWith("api-")) {
        await assert.rejects(stat(keyOutput), { code: "ENOENT" });
      }
    });
  }

  test("Kubernetes dev-up keeps the failed stack for inspection when KEEP_ON_FAILURE is set", async (t) => {
    // The inspection override skips rollback and names occ dev down for cleanup.
    const fixture = await kubernetesFixture(t, "api-unauthorized");
    fixture.env.OCC_DEVELOPMENT_KEEP_ON_FAILURE = "1";
    const keyOutput = join(fixture.directory, "retained-key.json");
    const result = await fixture.start(["--key-output", keyOutput]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /authorization failed/);
    assert.match(result.stdout, /OCC_DEVELOPMENT_KEEP_ON_FAILURE is set; kept the failed stack/);
    assert.doesNotMatch(result.stderr, /rollback incomplete; preserving/);
    const directory = stateDirectory(fixture.env);
    assert.ok((await stat(directory)).isDirectory());
    // Authorization fails before the service key is copied.
    await assert.rejects(stat(keyOutput), { code: "ENOENT" });
    // The kept stack must still clean up through the recorded state.
    const cleaned = await runDevDown(fixture.env);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  });
}
