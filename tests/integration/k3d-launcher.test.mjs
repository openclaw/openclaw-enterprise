import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { socketDirectory } from "../helpers/socket-directory.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const preparedPrefix = "openclaw-ci-test";

function preparedState(
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

async function runLauncher(
  context,
  engine,
  args = [],
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
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `oce-k3d-${engine}-launcher-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const action = args[0];
  const harnessOption = args.indexOf("--harness");
  const selectedHarness = harnessOption === -1 ? "codex" : args[harnessOption + 1];
  const stateHarness = preparedHarness ?? selectedHarness;
  const state = join(root, "state", "openclaw-enterprise", `k3d-${engine}-${stateHarness}`);
  const invocation = join(root, "node-invocation.json");
  const prepareCount = join(root, "prepare-count");
  const imagePulls = join(root, "image-pulls");
  const clipboard = join(root, "clipboard");
  await mkdir(bin);

  const command = async (name, source) => {
    const path = join(bin, name);
    await writeFile(path, source, { mode: 0o700 });
    await chmod(path, 0o700);
  };
  await command("uname", `#!/bin/sh\nprintf '${platform}\\n'\n`);
  await command("git", `#!/bin/sh\nprintf '${"a".repeat(40)}\\n'\n`);
  await command(clipboardCommand, `#!/bin/sh\n/usr/bin/tee '${clipboard}' >/dev/null\n`);

  let expectedDockerHost = "";
  if (engine === "podman") {
    const socket = join(await socketDirectory(context, "oce-k3d-podman-socket-"), "podman.sock");
    const server = createServer();
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(socket, resolvePromise);
    });
    context.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
    expectedDockerHost = `unix://${socket}`;
    await command(
      "podman",
      `#!/bin/sh
if [ "$1" = machine ] && [ "$2" = inspect ]; then printf '%s\\n' '${socket}'; exit 0; fi
if [ "$1" = info ] && [ "$2" = --format ]; then printf '%s\\n' '${socket}'; exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then [ '${missingBaseImages}' = true ] && exit 1; exit 0; fi
if [ "$1" = pull ]; then printf '%s\n' "$2" >> '${imagePulls}'; exit 0; fi
if [ "$1" = ps ]; then
  case "$*" in
    *openclaw_ci_pg_test*) printf '%s\\n' 'openclaw_ci_pg_test_postgres_1 (Up 1 minute (healthy))' ;;
    *k3d-openclaw-k8s-test*) printf '%s\\n' 'k3d-openclaw-k8s-test-server-0 (Up 1 minute)' 'k3d-openclaw-k8s-test-serverlb (Up 1 minute)' ;;
  esac
  exit 0
fi
exit 90
`,
    );
    await command("podman-compose", "#!/bin/sh\nexit 0\n");
  } else {
    await command(
      "docker",
      `#!/bin/sh
if [ "$1" = info ]; then exit 0; fi
if [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then [ '${missingBaseImages}' = true ] && exit 1; exit 0; fi
if [ "$1" = pull ]; then printf '%s\n' "$2" >> '${imagePulls}'; exit 0; fi
if [ "$1" = ps ]; then
  case "$*" in
    *openclaw_ci_pg_test*) printf '%s\\n' 'openclaw_ci_pg_test-postgres-1 (Up 1 minute (healthy))' ;;
    *k3d-openclaw-k8s-test*) printf '%s\\n' 'k3d-openclaw-k8s-test-server-0 (Up 1 minute)' 'k3d-openclaw-k8s-test-serverlb (Up 1 minute)' ;;
  esac
  exit 0
fi
exit 90
`,
    );
  }

  await command("k3d", "#!/bin/sh\nexit 91\n");
  await command(
    "kubectl",
    `#!/bin/sh
case "$*" in
  *"get namespaces"*) exit 0 ;;
esac
exit 91
`,
  );
  await command(
    "node",
    `#!/bin/sh
if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi
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
  exit 0
fi
if printf '%s' "$*" | grep -q 'scripts/ci/reset-k3d-model.mjs'; then exit 0; fi
if printf '%s' "$*" | grep -q 'scripts/ci/cleanup.mjs'; then rm -f '${join(state, "state.json")}'; exit 0; fi
node_args="$*"
/usr/bin/env -i PATH=/usr/bin:/bin INVOCATION='${invocation}' NODE_ARGS="$node_args" DOCKER_HOST="\${DOCKER_HOST:-}" OCC_DOCKER_BIN="$OCC_DOCKER_BIN" PODMAN_COMPOSE_PROVIDER="\${PODMAN_COMPOSE_PROVIDER:-}" OCC_K3D_DEMO_STATE="\${OCC_K3D_DEMO_STATE:-}" OCC_K3D_HARNESS="\${OCC_K3D_HARNESS:-}" OPENSHELL_HARNESS="\${OCC_TEST_OPENSHELL_HARNESS:-}" /bin/sh -c 'printf "{\\"args\\":\\"%s\\",\\"dockerHost\\":\\"%s\\",\\"containerBin\\":\\"%s\\",\\"composeProvider\\":\\"%s\\",\\"demoState\\":\\"%s\\",\\"harness\\":\\"%s\\",\\"openShellHarness\\":\\"%s\\"}\\n" "$NODE_ARGS" "$DOCKER_HOST" "$OCC_DOCKER_BIN" "$PODMAN_COMPOSE_PROVIDER" "$OCC_K3D_DEMO_STATE" "$OCC_K3D_HARNESS" "$OPENSHELL_HARNESS" > "$INVOCATION"'
`,
  );

  if (
    action === "get" ||
    action === "copy" ||
    action === "info" ||
    action === "reset" ||
    action === "down" ||
    foreignState ||
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
    await writeFile(join(state, "ready"), "");
    if (action !== "reset" && action !== "down") {
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
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "localhost/stale-gateway@sha256:" + "a".repeat(64),
      OCC_TEST_KUBERNETES_AGENT_IMAGE: "localhost/stale-agent@sha256:" + "b".repeat(64),
      OCC_TEST_KUBERNETES_RUNTIME_IMAGE: "localhost/stale-runtime@sha256:" + "c".repeat(64),
      OCC_TEST_KUBERNETES_CODEX_IMAGE: "localhost/stale-codex@sha256:" + "d".repeat(64),
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: "localhost/stale-controller@sha256:" + "e".repeat(64),
      OCC_K3D_OPENCLAW_SOURCE: openclawSource,
      XDG_STATE_HOME: join(root, "state"),
      PATH: clipboardCommand === "pbcopy" ? `${bin}:/usr/bin:/bin` : `${bin}:/bin`,
    },
  });

  if (staleDemo) {
    await assert.rejects(access(join(state, "demo.json")), { code: "ENOENT" });
  }
  assert.equal(
    await readFile(prepareCount, "utf8"),
    action === "get" ||
      action === "copy" ||
      action === "info" ||
      action === "reset" ||
      action === "down"
      ? "0\n"
      : "2\n",
  );
  if (action === "copy") {
    return { clipboard: await readFile(clipboard, "utf8"), stdout };
  }
  if (action === "get" || action === "info" || action === "reset" || action === "down") {
    return stdout;
  }

  const recorded = JSON.parse(await readFile(invocation, "utf8"));
  if (action === "test") {
    if (selectedHarness === "openclaw") {
      assert.match(
        recorded.args,
        /tests\/integration\/sandbox-driver-openshell-k3d-real\.test\.mjs/,
      );
      assert.equal(recorded.openShellHarness, "openclaw");
    } else {
      assert.match(recorded.args, /--test-name-pattern=production dedicated Codex consumes Envoy/);
      assert.match(
        recorded.args,
        /tests\/integration\/harness-topology-k3d-routing-real\.test\.mjs/,
      );
    }
    assert.equal(recorded.demoState, "");
  } else {
    assert.match(
      recorded.args,
      selectedHarness === "openclaw"
        ? /--test tests\/integration\/sandbox-driver-openshell-k3d-real\.test\.mjs/
        : /^scripts\/k3d-demo\.mjs$/,
    );
    assert.equal(recorded.demoState, join(state, "demo.json"));
    assert.equal(recorded.harness, selectedHarness);
    if (selectedHarness === "openclaw") {
      assert.equal(recorded.openShellHarness, "openclaw");
    }
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
}

test("k3d defaults to the foreground OpenClaw and OCC console demo", (context) =>
  runLauncher(context, "docker"));

test("k3d demo selects native OpenClaw through OpenShell", (context) =>
  runLauncher(context, "docker", ["demo", "--harness", "openclaw"]));

test("k3d fails immediately without a model credential in non-interactive use", async (context) => {
  await assert.rejects(
    runLauncher(context, "docker", [], { apiKey: "" }),
    /OPENAI_API_KEY is required for non-interactive use/,
  );
});

test("k3d reset does not require a model credential", async (context) => {
  const output = await runLauncher(context, "docker", ["reset"], { apiKey: "" });
  assert.match(output, /test state reset; cluster and images preserved/);
});

test("k3d reset removes a stale demo marker", async (context) => {
  const output = await runLauncher(context, "docker", ["reset"], {
    apiKey: "",
    staleDemo: true,
  });
  assert.match(output, /test state reset; cluster and images preserved/);
});

test("k3d down removes a stale demo marker", async (context) => {
  await runLauncher(context, "docker", ["down"], { staleDemo: true });
});

test("k3d down discovers native OpenClaw state without a Harness flag", async (context) => {
  const output = await runLauncher(context, "docker", ["down"], {
    preparedHarness: "openclaw",
  });
  assert.match(output, /environment removed/);
});

test("k3d serializes demo, test, reset, and down against an active lifecycle owner", async (context) => {
  for (const args of [[], ["test"], ["reset"], ["down"]]) {
    await assert.rejects(
      runLauncher(context, "docker", args, { activeLock: true }),
      /a k3d demo command is already running/,
    );
  }
});

test("k3d rejects another checkout's prepared state before reset or reuse", async (context) => {
  for (const action of ["reset", "test"]) {
    await assert.rejects(
      runLauncher(context, "docker", [action], { foreignState: true }),
      /prepared state belongs to another repository checkout/,
    );
  }
});

test("k3d validates prepared state metadata before reset", async (context) => {
  await assert.rejects(
    runLauncher(context, "docker", ["reset"], { stateVersion: 2 }),
    /unsupported prepared state version: 2/,
  );
  await assert.rejects(
    runLauncher(context, "docker", ["reset"], { resourceOwner: "openclaw-ci-foreign" }),
    /resource owned by another prefix/,
  );
});

test("k3d get prints one selected demo or cluster value without preparing resources", async (context) => {
  assert.equal(
    await runLauncher(context, "docker", ["get", "kubeconfig"]),
    "/private/demo/kubeconfig\n",
  );
  assert.equal(
    await runLauncher(context, "docker", ["get", "occ-console"]),
    "http://127.0.0.1:18889/console/agents?namespace=demo\n",
  );
  assert.equal(
    await runLauncher(context, "docker", ["get", "openclaw-control-ui"]),
    "http://127.0.0.1:18888/\n",
  );
});

test("k3d copy sends sensitive values only to the clipboard", async (context) => {
  const password = await runLauncher(context, "docker", ["copy", "occ-password"]);
  assert.equal(password.stdout, "Copied occ-password to the clipboard.\n");
  assert.equal(password.clipboard, "development-password");
  assert.doesNotMatch(password.stdout, /development-password/);

  const gatewayPassword = await runLauncher(context, "docker", ["copy", "openclaw-password"]);
  assert.equal(gatewayPassword.stdout, "Copied openclaw-password to the clipboard.\n");
  assert.equal(gatewayPassword.clipboard, "gateway-development-password");
  assert.doesNotMatch(gatewayPassword.stdout, /gateway-development-password/);
});

test("k3d password copy discovers an active native OpenClaw demo without a Harness flag", async (context) => {
  const gatewayPassword = await runLauncher(context, "docker", ["copy", "openclaw-password"], {
    preparedHarness: "openclaw",
  });
  assert.equal(gatewayPassword.stdout, "Copied openclaw-password to the clipboard.\n");
  assert.equal(gatewayPassword.clipboard, "gateway-development-password");

  const consolePassword = await runLauncher(context, "docker", ["copy", "occ-password"], {
    preparedHarness: "openclaw",
  });
  assert.equal(consolePassword.stdout, "Copied occ-password to the clipboard.\n");
  assert.equal(consolePassword.clipboard, "development-password");
});

test("k3d copy requires a Harness flag when multiple demos are active", async (context) => {
  await assert.rejects(
    runLauncher(context, "docker", ["copy", "occ-password"], { ambiguousDemo: true }),
    /multiple active k3d demos have passwords/,
  );
});

test("k3d copy supports a Linux Wayland clipboard", async (context) => {
  const password = await runLauncher(context, "docker", ["copy", "occ-password"], {
    platform: "Linux",
    clipboardCommand: "wl-copy",
  });
  assert.equal(password.stdout, "Copied occ-password to the clipboard.\n");
  assert.equal(password.clipboard, "development-password");
});

test("k3d get rejects sensitive fields", async (context) => {
  await assert.rejects(
    runLauncher(context, "docker", ["get", "occ-password"]),
    /unknown field 'occ-password'/,
  );
});

test("k3d info reports local state and non-secret connection values", async (context) => {
  const output = await runLauncher(context, "docker", ["info"]);
  assert.match(output, /^k3d$/m);
  assert.match(output, /Engine:\s+Docker/);
  assert.match(output, /Prepared state:\s+ready/);
  assert.match(output, /Demo:\s+ready/);
  assert.match(output, /^OpenClaw$/m);
  assert.match(output, /^OpenClaw Control Plane \(OCC\)$/m);
  assert.match(output, /^Kubernetes$/m);
  assert.match(output, /^Outside Kubernetes$/m);
  assert.match(output, /Control UI:\s+http:\/\/127\.0\.0\.1:18888\//);
  assert.match(output, /Console:\s+http:\/\/127\.0\.0\.1:18889\//);
  assert.match(output, /Username:\s+admin@openclaw\.local/);
  assert.match(output, /Namespace:\s+demo-namespace/);
  assert.match(output, /Kubeconfig:\s+\/private\/demo\/kubeconfig/);
  assert.match(output, /Demo coordinator, worker, and port-forwards:\s+running \(PID \d+\)/);
  assert.match(output, /PostgreSQL container:\s+openclaw_ci_pg_test-postgres-1 \(Up 1 minute/);
  assert.match(output, /k3d containers:\s+k3d-openclaw-k8s-test-server-0 \(Up 1 minute\)/);
  assert.match(output, /\.\/scripts\/k3d copy openclaw-password/);
  assert.match(output, /\.\/scripts\/k3d copy occ-password/);
  assert.doesNotMatch(output, /development-password|gateway-development-password/);
});

for (const engine of ["podman", "docker"]) {
  test(`${engine} k3d launcher selects the dedicated Codex routing integration`, (context) =>
    runLauncher(context, engine, ["test"]));
}

test("k3d test selects the dedicated native OpenClaw integration", (context) =>
  runLauncher(context, "podman", ["test", "--harness", "openclaw"]));

test("k3d pulls every pinned Node build base before offline image preparation", async (context) => {
  const runtimeRecipe = await readFile(join(repositoryRoot, "deploy/runtime/Dockerfile"), "utf8");
  const expected = Array.from(
    runtimeRecipe.matchAll(/^ARG NODE(?:_RUNTIME)?_BASE_IMAGE=(.+)$/gmu),
    ([, image]) => image,
  );
  const pulled = await runLauncher(context, "docker", ["test"], { missingBaseImages: true });
  assert.deepEqual(pulled, expected);
});

test("k3d rejects an unsupported Harness option", async (context) => {
  await assert.rejects(
    runLauncher(context, "docker", ["demo", "--harness", "other"]),
    /--harness must be codex or openclaw/,
  );
});

test("Linux Podman uses its native API socket", (context) =>
  runLauncher(context, "podman", ["test"], { platform: "Linux" }));
