import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeCommand } from "../helpers/fake-commands.ts";
import * as socketFixture from "../helpers/socket-directory.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);
export const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const preparedPrefix = "openclaw-ci-test";

export function preparedState(
  root = repositoryRoot,
  version = 1,
  owner = preparedPrefix,
  lane = "gateway-routing",
) {
  return {
    version,
    repositoryRoot: root,
    lane,
    prefix: preparedPrefix,
    resources: [
      {
        kind: "compose-postgres",
        name: "openclaw_ci_pg_test",
        owner,
        status: "ready",
      },
      {
        kind: "k3d-cluster",
        name: "openclaw-k8s-test",
        owner,
        status: "ready",
        kubeconfig: "/private/demo/kubeconfig",
        context: "k3d-demo",
      },
    ],
  };
}

type Engine = "docker" | "podman";
type StdoutAction = "get" | "info" | "reset" | "down";

interface LauncherOptions {
  platform?: "Darwin" | "Linux";
  clipboardCommand?: "pbcopy" | "wl-copy";
  apiKey?: string;
  staleDemo?: boolean;
  activeLock?: boolean;
  foreignState?: boolean;
  stateVersion?: number;
  resourceOwner?: string;
  preparedHarness?: "codex" | "openclaw";
  ambiguousDemo?: boolean;
  missingBaseImages?: boolean;
  inheritedModel?: string;
  inheritedBaseUrl?: string;
  preparedModel?: string;
  preparedBaseUrl?: string;
  namespaceListFailure?: boolean;
  afterReset?: boolean;
  realPreparationAdmission?: boolean;
}

interface ClipboardResult {
  clipboard: string;
  stdout: string;
}

interface LauncherInvocation {
  args: string[];
  dockerHost: string;
  containerBin: string;
  composeProvider: string;
  demoState: string;
  harness: string;
  openShellHarness: string;
  model: string;
  baseUrl: string;
  apiKeySet: boolean;
  originalKey: boolean;
}

const {
  socketDirectory,
}: {
  socketDirectory(owner: Pick<TestContext, "after">, prefix: string): Promise<string>;
} = socketFixture;

export function runLauncher(
  context: TestContext,
  engine: Engine,
  args: readonly [StdoutAction, ...string[]],
  options?: LauncherOptions,
): Promise<string>;
export function runLauncher(
  context: TestContext,
  engine: Engine,
  args: readonly ["copy", ...string[]],
  options?: LauncherOptions,
): Promise<ClipboardResult>;
export function runLauncher(
  context: TestContext,
  engine: Engine,
  args: readonly ["test", ...string[]],
  options: LauncherOptions & { missingBaseImages: true },
): Promise<string[]>;
export function runLauncher(
  context: TestContext,
  engine: Engine,
  args?: readonly [] | readonly ["test" | "demo" | "--harness", ...string[]],
  options?: LauncherOptions & { missingBaseImages?: false },
): Promise<LauncherInvocation>;
export function runLauncher(
  context: TestContext,
  engine: Engine,
  args: readonly string[],
  options?: LauncherOptions,
): Promise<string | string[] | ClipboardResult | LauncherInvocation>;
export async function runLauncher(
  context: TestContext,
  engine: Engine,
  args: readonly string[] = [],
  {
    platform = "Darwin",
    clipboardCommand = "pbcopy",
    apiKey = "test-only-value",
    staleDemo = false,
    activeLock = false,
    foreignState = false,
    stateVersion = 1,
    resourceOwner = "openclaw-ci-test",
    preparedHarness,
    ambiguousDemo = false,
    missingBaseImages = false,
    inheritedModel = "",
    inheritedBaseUrl = "",
    preparedModel,
    preparedBaseUrl,
    namespaceListFailure = false,
    afterReset = false,
    realPreparationAdmission = false,
  }: LauncherOptions = {},
): Promise<string | string[] | ClipboardResult | LauncherInvocation> {
  const root = await temporaryDirectory(context, `oce-k3d-${engine}-launcher-`);
  const bin = join(root, "bin");
  const action = args[0];
  const harnessOption = args.indexOf("--harness");
  const selectedHarness = harnessOption === -1 ? "codex" : args[harnessOption + 1];
  const stateHarness = preparedHarness ?? selectedHarness;
  const state = join(root, "state", "openclaw-enterprise", `k3d-${engine}-${stateHarness}`);
  const invocation = join(root, "node-invocation.json");
  const prepareCount = join(root, "prepare-count");
  const preparationInvocations = join(root, "preparation-invocations.jsonl");
  const imagePulls = join(root, "image-pulls");
  const clipboard = join(root, "clipboard");
  const resetCalled = join(root, "reset-called");
  await mkdir(bin);

  await writeCommand(bin, "uname", `printf '${platform}\\n'\n`);
  await writeCommand(bin, "git", `printf '${"a".repeat(40)}\\n'\n`);
  await writeCommand(bin, clipboardCommand, `/usr/bin/tee '${clipboard}' >/dev/null\n`);

  let expectedDockerHost = "";
  if (engine === "podman") {
    // After hooks run in registration order: close the server before its directory goes.
    const server = createServer();
    context.after(
      () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
    );
    const socket = join(await socketDirectory(context, "oce-k3d-podman-socket-"), "podman.sock");
    await new Promise<void>((resolvePromise, reject: (reason: unknown) => void) => {
      server.once("error", reject);
      server.listen(socket, resolvePromise);
    });
    expectedDockerHost = `unix://${socket}`;
    await writeCommand(
      bin,
      "podman",
      `if [ "$1" = machine ] && [ "$2" = inspect ]; then printf '%s\\n' '${socket}'; exit 0; fi
if [ "$1" = info ] && [ "$2" = --format ]; then printf '%s\\n' '${socket}'; exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then [ '${missingBaseImages}' = true ] && exit 1; exit 0; fi
if [ "$1" = pull ]; then printf '%s\n' "$2" >> '${imagePulls}'; exit 0; fi
if [ "$1" = ps ]; then
  case "$*" in
    *openclaw_ci_pg_test*) printf '%s\\n' 'openclaw_ci_pg_test_postgres_1 (Up 1 minute (healthy))' ;;
    *k3d-openclaw-k8s-test*) printf '%s\\n' 'k3d-openclaw-k8s-test-server-0 (Up 1 minute)' ;;
  esac
  exit 0
fi
exit 90
`,
    );
    await writeCommand(bin, "podman-compose", "exit 0\n");
  } else {
    await writeCommand(
      bin,
      "docker",
      `if [ "$1" = info ]; then exit 0; fi
if [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then [ '${missingBaseImages}' = true ] && exit 1; exit 0; fi
if [ "$1" = pull ]; then printf '%s\n' "$2" >> '${imagePulls}'; exit 0; fi
if [ "$1" = ps ]; then
  case "$*" in
    *openclaw_ci_pg_test*) printf '%s\\n' 'openclaw_ci_pg_test-postgres-1 (Up 1 minute (healthy))' ;;
    *k3d-openclaw-k8s-test*) printf '%s\\n' 'k3d-openclaw-k8s-test-server-0 (Up 1 minute)' ;;
  esac
  exit 0
fi
exit 90
`,
    );
  }

  await writeCommand(bin, "k3d", "exit 91\n");
  await writeCommand(
    bin,
    "kubectl",
    `case "$*" in
  *"get namespaces"*)
    if [ '${namespaceListFailure}' = true ]; then
      printf 'namespace inventory unavailable\\n' >&2
      exit 37
    fi
    exit 0 ;;
esac
exit 91
`,
  );
  const admissionProbe = join(root, "admission-probe.mjs");
  if (realPreparationAdmission) {
    // Run actual input admission, then stop at the image gate before any resources.
    // Only downstream setup and the eventual model-test process remain inert.
    await writeFile(
      admissionProbe,
      `
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

appendFileSync(${JSON.stringify(preparationInvocations)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const result = spawnSync(process.execPath, process.argv.slice(2), {
  encoding: "utf8",
  env: { ...process.env, OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "fixture-mutable" },
});
assert.equal(result.status, 1);
assert.match(result.stderr, /must be an immutable image@sha256 reference/);
`,
    );
  }
  await writeCommand(
    bin,
    "node",
    `if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi
if printf '%s' "$*" | grep -q 'scripts/ci/prepare.mjs'; then
  printf '%s' "$*" | grep -q -- '--lane ${selectedHarness === "openclaw" ? "openshell" : "gateway-routing"}' || exit 93
  [ -z "$OCC_TEST_KUBERNETES_GATEWAY_IMAGE" ] || exit 92
  [ -z "$OCC_TEST_KUBERNETES_AGENT_IMAGE" ] || exit 92
  [ -z "$OCC_TEST_KUBERNETES_RUNTIME_IMAGE" ] || exit 92
  [ -z "$OCC_TEST_KUBERNETES_CODEX_IMAGE" ] || exit 92
  [ -z "$OCC_TEST_PRODUCTION_CONTROLLER_IMAGE" ] || exit 92
  [ -n "$NODE_BASE_IMAGE" ] || exit 94
  [ '${selectedHarness}' != openclaw ] || [ "$OCC_K3D_OPENCLAW_SOURCE" = '${join(root, "openclaw-source")}' ] || exit 95
  [ '${selectedHarness}' != openclaw ] || [ "$OCC_K3D_OPENCLAW_COMMIT" = '${"a".repeat(40)}' ] || exit 96
  ${realPreparationAdmission ? `'${process.execPath}' '${admissionProbe}' "$@" || exit $?` : ""}
  count="$(cat '${prepareCount}' 2>/dev/null || printf '0')"
  count="$((count + 1))"
  printf '%s\\n' "$count" > '${prepareCount}'
  mkdir -p '${state}'
  printf '%s\\n' '${JSON.stringify(preparedState(repositoryRoot, 1, preparedPrefix, selectedHarness === "openclaw" ? "openshell" : "gateway-routing"))}' > '${join(state, "state.json")}'
  printf '%s\n' \
    'OCC_TEST_PRODUCTION_CONTROLLER_IMAGE=localhost/controller@sha256:${"e".repeat(64)}' \
    'OCC_TEST_KUBERNETES_KUBECONFIG=/private/demo/kubeconfig' \
    'OCC_TEST_KUBERNETES_CONTEXT=k3d-demo' > '${join(state, "env")}'
  if [ -n "$OCC_K3D_OPENCLAW_COMMIT" ]; then
    printf 'OCC_K3D_OPENCLAW_COMMIT=%s\n' "$OCC_K3D_OPENCLAW_COMMIT" >> '${join(state, "env")}'
  fi
  printf '%s\n' '${preparedModel === undefined ? "" : `OCC_TEST_OPENAI_MODEL=${preparedModel}`}' '${preparedBaseUrl === undefined ? "" : `${selectedHarness === "openclaw" ? "OCC_TEST_OPENSHELL_MODEL_BASE_URL" : "OCC_TEST_CODEX_OPENAI_BASE_URL"}=${preparedBaseUrl}`}' >> '${join(state, "env")}'
  exit 0
fi
if printf '%s' "$*" | grep -q 'scripts/ci/reset-k3d-model.mjs'; then touch '${resetCalled}'; exit 0; fi
if [ "$1" = scripts/ci/cleanup.ts ]; then rm -f '${join(state, "state.json")}'; exit 0; fi
/usr/bin/env -i PATH=/usr/bin:/bin INVOCATION='${invocation}' \
  DOCKER_HOST="\${DOCKER_HOST:-}" OCC_DOCKER_BIN="$OCC_DOCKER_BIN" \
  PODMAN_COMPOSE_PROVIDER="\${PODMAN_COMPOSE_PROVIDER:-}" OCC_K3D_DEMO_STATE="\${OCC_K3D_DEMO_STATE:-}" \
  OCC_K3D_HARNESS="\${OCC_K3D_HARNESS:-}" OPENSHELL_HARNESS="\${OCC_TEST_OPENSHELL_HARNESS:-}" \
  MODEL="$OCC_TEST_OPENAI_MODEL" BASE_URL="\${${selectedHarness === "openclaw" ? "OCC_TEST_OPENSHELL_MODEL_BASE_URL" : "OCC_TEST_CODEX_OPENAI_BASE_URL"}:-}" \
  KEY_PRESENT="$(test -n "$OPENAI_API_KEY" && printf true || printf false)" \
  ORIGINAL_KEY="$(test "$OPENAI_API_KEY" = test-only-value && printf true || printf false)" '${process.execPath}' -e '
    const { writeFileSync } = require("node:fs");
    const env = process.env;
    writeFileSync(env.INVOCATION, JSON.stringify({
      args: process.argv.slice(1),
      dockerHost: env.DOCKER_HOST,
      containerBin: env.OCC_DOCKER_BIN,
      composeProvider: env.PODMAN_COMPOSE_PROVIDER,
      demoState: env.OCC_K3D_DEMO_STATE,
      harness: env.OCC_K3D_HARNESS,
      openShellHarness: env.OPENSHELL_HARNESS,
      model: env.MODEL,
      baseUrl: env.BASE_URL,
      apiKeySet: env.KEY_PRESENT === "true",
      originalKey: env.ORIGINAL_KEY === "true",
    }));
  ' -- "$@"
`,
  );

  if (
    action === "get" ||
    action === "copy" ||
    action === "info" ||
    action === "reset" ||
    action === "down" ||
    foreignState ||
    afterReset ||
    activeLock
  ) {
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "state.json"),
      `${JSON.stringify(
        preparedState(
          foreignState ? join(root, "another-checkout") : repositoryRoot,
          stateVersion,
          resourceOwner,
          stateHarness === "openclaw" ? "openshell" : "gateway-routing",
        ),
      )}\n`,
    );
    await writeFile(
      join(state, "env"),
      "OCC_TEST_KUBERNETES_KUBECONFIG=/private/demo/kubeconfig\nOCC_TEST_KUBERNETES_CONTEXT=k3d-demo\n",
    );
    await writeFile(join(state, afterReset ? "reset" : "ready"), "");
    if (action !== "reset" && action !== "down" && !afterReset) {
      await writeFile(
        join(state, "demo.json"),
        `${JSON.stringify({
          consolePassword: "development-password",
          consoleUrl: "http://127.0.0.1:18889/console/agents?namespace=demo",
          controlUiUrl: "http://127.0.0.1:18888/",
          gatewayPassword: "gateway-development-password",
          agentId: "agt_demo",
          namespace: "demo-namespace",
          namespaceId: "ns_demo",
          consoleUsername: "admin@openclaw.local",
          processId: String(process.pid),
        })}\n`,
      );
      if (ambiguousDemo) {
        const otherHarness = stateHarness === "openclaw" ? "codex" : "openclaw";
        const otherState = join(
          root,
          "state",
          "openclaw-enterprise",
          `k3d-${engine}-${otherHarness}`,
        );
        await mkdir(otherState, { recursive: true });
        await writeFile(
          join(otherState, "demo.json"),
          `${JSON.stringify({
            consolePassword: "other-development-password",
            gatewayPassword: "other-gateway-development-password",
            processId: String(process.pid),
          })}\n`,
        );
      }
    } else if (staleDemo) {
      await writeFile(join(state, "demo.json"), '{"processId":"999999999"}\n');
    }
    await writeFile(prepareCount, "0\n");
    if (activeLock) {
      await symlink(`${process.pid}:demo`, join(state, "lifecycle.lock"));
    }
  }

  const openclawSource = join(root, "openclaw-source");
  await mkdir(openclawSource);
  await writeFile(join(openclawSource, "Dockerfile"), "FROM scratch\n");

  const { stdout } = await execute("scripts/k3d", args, {
    env: {
      ...process.env,
      DOCKER_HOST: "",
      OPENAI_API_KEY: apiKey,
      CODEX_ACCESS_TOKEN: "",
      OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "",
      OCC_TEST_OPENAI_MODEL: inheritedModel,
      OCC_TEST_CODEX_OPENAI_BASE_URL: inheritedBaseUrl,
      OCC_TEST_OPENSHELL_MODEL_BASE_URL: selectedHarness === "openclaw" ? inheritedBaseUrl : "",
      OCC_K3D_STATE_DIR: "",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "localhost/stale-gateway@sha256:" + "a".repeat(64),
      OCC_TEST_KUBERNETES_AGENT_IMAGE: "localhost/stale-agent@sha256:" + "b".repeat(64),
      OCC_TEST_KUBERNETES_RUNTIME_IMAGE: "localhost/stale-runtime@sha256:" + "c".repeat(64),
      OCC_TEST_KUBERNETES_CODEX_IMAGE: "localhost/stale-codex@sha256:" + "d".repeat(64),
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: "localhost/stale-controller@sha256:" + "e".repeat(64),
      OCC_K3D_OPENCLAW_SOURCE: openclawSource,
      XDG_STATE_HOME: join(root, "state"),
      PATH: clipboardCommand === "pbcopy" ? `${bin}:/usr/bin:/bin` : `${bin}:/bin`,
    },
  }).catch(async (error: unknown) => {
    if (namespaceListFailure) {
      await assert.rejects(access(resetCalled), { code: "ENOENT" });
      await access(join(state, "env"));
      await access(join(state, "state.json"));
      await assert.rejects(access(join(state, "reset")), { code: "ENOENT" });
      assert.ok(error instanceof Error && "stdout" in error && typeof error.stdout === "string");
      assert.doesNotMatch(error.stdout, /test state reset; cluster and images preserved/);
    }
    throw error;
  });

  if (action === "reset") {
    // The success case verifies that the database reset stand-in is reachable.
    await access(resetCalled);
    await access(join(state, "reset"));
  }
  if (staleDemo) {
    await assert.rejects(access(join(state, "demo.json")), { code: "ENOENT" });
  }
  let expectedPreparations = afterReset ? "1\n" : "2\n";
  if (action !== undefined && ["get", "copy", "info", "reset", "down"].includes(action)) {
    expectedPreparations = "0\n";
  }
  assert.equal(await readFile(prepareCount, "utf8"), expectedPreparations);
  if (realPreparationAdmission) {
    const preparations = (await readFile(preparationInvocations, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    // A fresh launch creates lane state before file preparation; reset reuses it.
    // Reaching the image gate alone cannot distinguish these preparation modes.
    assert.deepEqual(
      preparations,
      (afterReset ? ["--file"] : ["--selected-file", "--file"]).map((selection) => [
        "scripts/ci/prepare.mjs",
        "--lane",
        "openshell",
        selection,
        "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
        "--state",
        join(state, "state.json"),
        "--github-env",
        join(state, "env"),
      ]),
      "native launcher must prepare the selected lane before preparing the same file",
    );
  }
  if (action === "copy") {
    return { clipboard: await readFile(clipboard, "utf8"), stdout };
  }
  if (action === "get" || action === "info" || action === "reset" || action === "down") {
    return stdout;
  }

  const recorded = await readInvocation(invocation);
  if (selectedHarness === "openclaw") {
    // Both entry points must run the policy check first and serialize the two files.
    assert.deepEqual(recorded.args, [
      "--test",
      "--test-concurrency=1",
      "tests/integration/openshell-gateway-tool-policy-real.test.ts",
      "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
    ]);
    assert.equal(recorded.openShellHarness, "openclaw");
  } else if (action === "test") {
    assert.deepEqual(recorded.args, [
      "--test",
      "--test-name-pattern=production dedicated Codex consumes Envoy-routed workspace files through OCC",
      "tests/integration/harness-topology-k3d-routing-real.test.mjs",
    ]);
  } else {
    assert.deepEqual(recorded.args, ["scripts/k3d-demo.mjs"]);
  }
  if (action === "test") {
    assert.equal(recorded.demoState, "");
  } else {
    assert.equal(recorded.demoState, join(state, "demo.json"));
    assert.equal(recorded.harness, selectedHarness);
  }
  assert.equal(recorded.dockerHost, expectedDockerHost);
  assert.equal(recorded.containerBin, join(bin, engine));
  assert.equal(recorded.composeProvider, engine === "podman" ? join(bin, "podman-compose") : "");
  assert.match(stdout, new RegExp(`\\[k3d:${engine}\\]`));
  if (selectedHarness === "openclaw") {
    assert.match(
      stdout,
      /WARNING: Dedicated native OpenClaw is experimental\. The current OpenClaw release image does not include native worker-inference support/,
    );
  } else {
    assert.doesNotMatch(stdout, /Dedicated native OpenClaw is experimental/);
  }
  if (action === "test") {
    assert.match(
      stdout,
      selectedHarness === "openclaw"
        ? /Dedicated native OpenClaw with OpenShell integration passed\./
        : /Dedicated Codex gateway-routing integration passed\./,
    );
  }
  if (missingBaseImages) {
    return (await readFile(imagePulls, "utf8")).trim().split("\n");
  }
  return recorded;
}

async function readInvocation(path: string): Promise<LauncherInvocation> {
  const captured: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(captured !== null && typeof captured === "object");
  assert.ok("args" in captured && Array.isArray(captured.args));
  const args: unknown[] = captured.args;
  assert.ok(args.every((arg) => typeof arg === "string"));
  assert.ok("dockerHost" in captured && typeof captured.dockerHost === "string");
  assert.ok("containerBin" in captured && typeof captured.containerBin === "string");
  assert.ok("composeProvider" in captured && typeof captured.composeProvider === "string");
  assert.ok("demoState" in captured && typeof captured.demoState === "string");
  assert.ok("harness" in captured && typeof captured.harness === "string");
  assert.ok("openShellHarness" in captured && typeof captured.openShellHarness === "string");
  assert.ok("model" in captured && typeof captured.model === "string");
  assert.ok("baseUrl" in captured && typeof captured.baseUrl === "string");
  assert.ok("apiKeySet" in captured && typeof captured.apiKeySet === "boolean");
  assert.ok("originalKey" in captured && typeof captured.originalKey === "boolean");
  return {
    args,
    dockerHost: captured.dockerHost,
    containerBin: captured.containerBin,
    composeProvider: captured.composeProvider,
    demoState: captured.demoState,
    harness: captured.harness,
    openShellHarness: captured.openShellHarness,
    model: captured.model,
    baseUrl: captured.baseUrl,
    apiKeySet: captured.apiKeySet,
    originalKey: captured.originalKey,
  };
}
