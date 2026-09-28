import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const upgradeScript = fileURLToPath(
  new URL("../../scripts/upgrade-production-images", import.meta.url),
);

test("production image upgrades preserve controller/runtime ownership and wait for ready Pods", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-production-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baselineControllerImage = `registry.example.invalid/controller@sha256:${"f".repeat(64)}`;
  const controllerImage = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`;
  const runtimeImage = `registry.example.invalid/runtime@sha256:${"b".repeat(64)}`;

  const bin = join(directory, "bin");
  await mkdir(bin);
  const stat = join(bin, "stat");
  await writeFile(
    stat,
    `#!/usr/bin/env bash
if [[ "$1" == "-f" ]]; then
  printf 'GNU filesystem report\\n'
  exit 1
fi
printf '600\\n'
`,
  );
  await chmod(stat, 0o755);

  const helm = join(bin, "helm");
  await writeFile(
    helm,
    `#!/usr/bin/env bash
if [[ "$*" == *'get values'* ]]; then
  cat "$LIVE_VALUES_FILE"
elif [[ "$1" == "template" ]]; then
  exit 47
fi
`,
  );
  await chmod(helm, 0o755);

  const jq = join(bin, "jq");
  await writeFile(
    jq,
    `#!/usr/bin/env bash
case "$*" in
  *'.data['*) printf 'cHJvdGVjdGVkCg==\\n' ;;
  *'openclaw.dev/installation-id'*) printf '%s\\n' "$CLUSTER_INSTALLATION_ID" ;;
  '-S '*) cat ;;
  *'.installationId == '*) exit 0 ;;
  *'.deploymentInProgress'*|*'.activeRevisionId == null'*|*'.status != "ready"'*) exit 1 ;;
  *'namespaceId: $namespace.id'*) exit 0 ;;
  *'.id'*) printf 'ins_upgrade_test\\n' ;;
esac
`,
  );
  await chmod(jq, 0o755);

  const yq = join(bin, "yq");
  await writeFile(
    yq,
    `#!/usr/bin/env bash
case "$*" in
  '-o=json '*)
    for path in "$@"; do :; done
    cat "$path"
    ;;
  *'.installation.secretName'*) printf 'occ-installation-startup\\n' ;;
  *'.installation.key'*) printf 'installation.yaml\\n' ;;
  *'.images.controller'*) printf '%s\\n' "$CURRENT_CONTROLLER_IMAGE" ;;
  *'.images.gateway'*) printf '%s\\n' 'registry.example.invalid/runtime@sha256:${"d".repeat(64)}' ;;
  *'.images.agent'*) printf '%s\\n' 'registry.example.invalid/runtime@sha256:${"d".repeat(64)}' ;;
esac
`,
  );
  await chmod(yq, 0o755);

  const python = join(bin, "python3");
  await writeFile(
    python,
    `#!/usr/bin/env bash
if (($# == 3)); then
  printf '%s\\n' '${"e".repeat(64)}'
else
  cat >/dev/null
  cat "$LIVE_INSTALLATION_FILE"
fi
`,
  );
  await chmod(python, 0o755);
  const kubectl = join(bin, "kubectl");
  await writeFile(kubectl, "#!/usr/bin/env bash\nexit 0\n");
  await chmod(kubectl, 0o755);

  const occ = join(bin, "occ");
  await writeFile(
    occ,
    `#!/usr/bin/env bash
if [[ "$*" == *'deployment-inventory'* ]]; then
  printf '%s\\n' '{"installationId":"ins_upgrade_test","namespaces":[{"id":"ns_test","status":"ready","agents":[]}]}'
else
  printf '%s\\n' '{"id":"ins_upgrade_test"}'
fi
`,
  );
  await chmod(occ, 0o755);

  const protectedFiles = {};
  for (const name of ["kubeconfig", "service-key"]) {
    const path = join(directory, name);
    await writeFile(path, "protected\n", { mode: 0o600 });
    protectedFiles[name] = path;
  }

  const baselineRuntimeImage = `registry.example.invalid/runtime@sha256:${"d".repeat(64)}`;
  const liveValues = join(directory, "live-values.json");
  const liveInstallation = join(directory, "live-installation.json");
  const valuesDocument = JSON.stringify({
    database: { host: "current.example.invalid" },
    images: { controller: baselineControllerImage },
    installation: { key: "installation.yaml", secretName: "occ-installation-startup" },
  });
  const installationDocument = JSON.stringify({
    drivers: {
      compute: {
        configuration: {
          images: { agent: baselineRuntimeImage, gateway: baselineRuntimeImage },
        },
      },
    },
  });
  await writeFile(liveValues, valuesDocument, { mode: 0o600 });
  await writeFile(liveInstallation, installationDocument, { mode: 0o600 });
  protectedFiles.values = join(directory, "values");
  protectedFiles.installation = join(directory, "installation");
  await writeFile(protectedFiles.values, valuesDocument, { mode: 0o600 });
  await writeFile(protectedFiles.installation, installationDocument, { mode: 0o600 });

  const upgradeArguments = (evidenceDirectory, images = ["controller", "runtime"]) => [
    "--kubeconfig",
    protectedFiles.kubeconfig,
    "--context",
    "k3d-upgrade-test",
    "--namespace",
    "openclaw-system",
    "--release",
    "oce",
    "--values",
    protectedFiles.values,
    "--installation",
    protectedFiles.installation,
    ...(images.includes("controller") ? ["--controller-image", controllerImage] : []),
    ...(images.includes("runtime") ? ["--runtime-image", runtimeImage] : []),
    "--source-revision",
    "c".repeat(40),
    "--evidence-dir",
    evidenceDirectory,
    "--occ",
    occ,
  ];
  const environment = {
    ...process.env,
    CLUSTER_INSTALLATION_ID: "ins_upgrade_test",
    CURRENT_CONTROLLER_IMAGE: baselineControllerImage,
    LIVE_INSTALLATION_FILE: liveInstallation,
    LIVE_VALUES_FILE: liveValues,
    OCC_SERVICE_KEY_FILE: protectedFiles["service-key"],
    OCC_URL: "https://occ.example.invalid",
    PATH: `${bin}:/bin:/usr/bin`,
  };

  await assert.rejects(
    execute(upgradeScript, upgradeArguments(join(directory, "http-evidence")), {
      cwd: repository,
      env: { ...environment, OCC_URL: "http://occ.example.invalid" },
    }),
    /OCC_URL must use HTTPS/,
  );

  // Refuse stale recovery input before rendering or mutating the release.
  await writeFile(
    protectedFiles.values,
    JSON.stringify({ ...JSON.parse(valuesDocument), database: { host: "stale.example.invalid" } }),
    { mode: 0o600 },
  );
  await assert.rejects(
    execute(upgradeScript, upgradeArguments(join(directory, "stale-evidence")), {
      cwd: repository,
      env: environment,
    }),
    /protected Helm values differ from the live release outside the controller image/,
  );
  await writeFile(protectedFiles.values, valuesDocument, { mode: 0o600 });

  // The authenticated OCC endpoint and selected kube context must identify the
  // same Installation before either control plane can be changed.
  await assert.rejects(
    execute(upgradeScript, upgradeArguments(join(directory, "wrong-cluster-evidence")), {
      cwd: repository,
      env: { ...environment, CLUSTER_INSTALLATION_ID: "ins_other_cluster" },
    }),
    /OCC Installation ins_upgrade_test does not match Kubernetes Installation ins_other_cluster/,
  );

  // GNU stat can emit filesystem details before rejecting the BSD format flag.
  // That output must not corrupt the fallback mode or reject an owner-only file.
  await assert.rejects(
    execute(upgradeScript, upgradeArguments(join(directory, "evidence")), {
      cwd: repository,
      env: environment,
    }),
    (error) => {
      assert.equal(error.code, 47);
      assert.doesNotMatch(error.stderr, /must not grant group or other permissions/);
      assert.doesNotMatch(error.stderr, /contains no running Agents/);
      return true;
    },
  );

  const readinessCounter = join(directory, "readiness-counter");
  const runtimeCountCounter = join(directory, "runtime-count-counter");
  const commandLog = join(directory, "commands.log");
  await writeFile(
    helm,
    `#!/usr/bin/env bash
if [[ "$*" == *'get values'* ]]; then
  cat "$LIVE_VALUES_FILE"
fi
`,
  );
  await writeFile(
    jq,
    `#!/usr/bin/env bash
if [[ "$*" == '-S '* ]]; then
  cat
  exit 0
fi
case "$*" in
  *'.data['*) printf 'cHJvdGVjdGVkCg==\\n' ;;
  *'openclaw.dev/installation-id'*) printf '%s\\n' "$CLUSTER_INSTALLATION_ID" ;;
  *'.installationId == '*) exit 0 ;;
  *'.deploymentInProgress'*|*'.activeRevisionId == null'*|*'.status != "ready"'*) exit 1 ;;
  *'namespaceId: $namespace.id'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","executionMode":"dedicated","baselineRevisionId":"rev_test"}' ;;
  *'gatewayNamespace: $gatewayNamespace'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","deploymentId":"rev_candidate","gatewayNamespace":"tenant-test","gatewayName":"gateway-test"}' ;;
  *'{namespaceId: $namespaceId'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","executionMode":"dedicated","deploymentId":"rev_candidate"}' ;;
  *'{namespace: .metadata.namespace, name: .metadata.name}'*) printf '%s\\n' '{"namespace":"tenant-test","name":"gateway-test"}' ;;
  *'spec.containers'*'length'*)
    attempts=0
    [[ ! -f "$RUNTIME_COUNT_COUNTER" ]] || attempts=$(cat "$RUNTIME_COUNT_COUNTER")
    attempts=$((attempts + 1))
    printf '%s\\n' "$attempts" >"$RUNTIME_COUNT_COUNTER"
    if ((attempts == 1)); then printf '1\\n'; else printf '2\\n'; fi
    ;;
  *'all(.items[].spec.containers'*) exit 0 ;;
  *'.status.phase == "Running"'*)
    attempts=0
    [[ ! -f "$READINESS_COUNTER" ]] || attempts=$(cat "$READINESS_COUNTER")
    attempts=$((attempts + 1))
    printf '%s\\n' "$attempts" >"$READINESS_COUNTER"
    ((attempts >= 2))
    ;;
  *'.activeRevisionId'*) cat >/dev/null; printf 'rev_candidate\\n' ;;
  *'.executionMode'*) cat >/dev/null; printf 'dedicated\\n' ;;
  *'.deploymentId'*) printf 'rev_candidate\\n' ;;
  *'.gatewayNamespace'*) cat >/dev/null; printf 'tenant-test\\n' ;;
  *'.gatewayName'*) cat >/dev/null; printf 'gateway-test\\n' ;;
  *'.namespaceId'*) cat >/dev/null; printf 'ns_test\\n' ;;
  *'.namespace'*) cat >/dev/null; printf 'tenant-test\\n' ;;
  *'.name'*) cat >/dev/null; printf 'gateway-test\\n' ;;
  *'.agentId'*) cat >/dev/null; printf 'agt_test\\n' ;;
  *'.status'*) printf 'succeeded\\n' ;;
  *'.id'*'installation.json'*) printf 'ins_upgrade_test\\n' ;;
  *'.id'*) printf 'rev_candidate\\n' ;;
esac
`,
  );
  await writeFile(
    kubectl,
    `#!/usr/bin/env bash
printf 'kubectl %s\\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  *'exec gateway-test --container gateway -- node /app/openclaw.mjs doctor --lint --json --severity-min error'*)
    if [[ "$DOCTOR_FAILURE" == "1" ]]; then
      printf 'doctor found an error\\n' >&2
      exit 53
    fi
    printf '%s\\n' '{"status":"ok"}'
    ;;
  *'jsonpath='*) printf '%s\\n' "$OBSERVED_CONTROLLER_IMAGE" ;;
  *'get pods'*) printf '%s\\n' '{"items":[]}' ;;
esac
`,
  );
  await writeFile(
    occ,
    `#!/usr/bin/env bash
printf 'occ %s\\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  *'deployment-inventory'*) printf '%s\\n' '{"installationId":"ins_upgrade_test","namespaces":[{"id":"ns_test","status":"ready","agents":[{"id":"agt_test","status":"active","desiredRuntimeState":"running","executionMode":"dedicated","activeRevisionId":"rev_test","deploymentInProgress":false}]}]}' ;;
  *'agent deploy'*) printf '%s\\n' '{"id":"rev_candidate"}' ;;
  *'deployment-status'*) printf '%s\\n' '{"status":"succeeded"}' ;;
  *'agent get'*) printf '%s\\n' '{"activeRevisionId":"rev_candidate"}' ;;
  *) printf '%s\\n' '{"id":"ins_upgrade_test"}' ;;
esac
`,
  );

  // A controller release changes only the Helm-owned image. It must not replace
  // the Installation Secret, request fleet inventory, or create Agent revisions.
  const controllerOnly = await execute(
    upgradeScript,
    upgradeArguments(join(directory, "controller-evidence"), ["controller"]),
    {
      cwd: repository,
      env: {
        ...environment,
        COMMAND_LOG: commandLog,
        OBSERVED_CONTROLLER_IMAGE: controllerImage,
      },
    },
  );
  assert.match(controllerOnly.stdout, /no Agent deployments were requested/u);
  const controllerCommands = await readFile(commandLog, "utf8");
  assert.doesNotMatch(controllerCommands, /deployment-inventory|agent deploy|apply --filename/u);
  assert.equal(await readFile(protectedFiles.installation, "utf8"), installationDocument);
  await rm(commandLog);

  // Kubernetes readiness does not cover OpenClaw's own state and configuration
  // diagnostics. A replacement gateway with a Doctor error must fail the release.
  await assert.rejects(
    execute(
      upgradeScript,
      upgradeArguments(join(directory, "doctor-failure-evidence"), ["runtime"]),
      {
        cwd: repository,
        env: {
          ...environment,
          COMMAND_LOG: commandLog,
          DOCTOR_FAILURE: "1",
          OBSERVED_CONTROLLER_IMAGE: baselineControllerImage,
          READINESS_COUNTER: readinessCounter,
          RUNTIME_COUNT_COUNTER: runtimeCountCounter,
        },
      },
    ),
    /OpenClaw Doctor failed for at least one replacement gateway/u,
  );
  await writeFile(protectedFiles.values, valuesDocument, { mode: 0o600 });
  await writeFile(protectedFiles.installation, installationDocument, { mode: 0o600 });
  await rm(commandLog, { force: true });
  await rm(readinessCounter, { force: true });
  await rm(runtimeCountCounter, { force: true });

  // Durable deployment completion can precede Kubernetes readiness. The
  // command must observe a ready revision before reporting fleet success.
  const completed = await execute(
    upgradeScript,
    upgradeArguments(join(directory, "ready-evidence"), ["runtime"]),
    {
      cwd: repository,
      env: {
        ...environment,
        COMMAND_LOG: commandLog,
        OBSERVED_CONTROLLER_IMAGE: baselineControllerImage,
        READINESS_COUNTER: readinessCounter,
        RUNTIME_COUNT_COUNTER: runtimeCountCounter,
      },
    },
  );
  assert.match(
    completed.stdout,
    /runtime image; controller image remained unchanged and 1 running Agents selected new revisions/u,
  );
  assert.equal((await readFile(readinessCounter, "utf8")).trim(), "2");
  assert.equal((await readFile(runtimeCountCounter, "utf8")).trim(), "3");
  assert.match(
    await readFile(commandLog, "utf8"),
    /exec gateway-test --container gateway -- node \/app\/openclaw\.mjs doctor --lint --json --severity-min error/u,
  );
  assert.equal(
    (await readFile(join(directory, "ready-evidence", "installation-checksum"), "utf8")).trim(),
    "e".repeat(64),
  );
});
