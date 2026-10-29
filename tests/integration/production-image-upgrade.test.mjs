import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { immutableImageAccepted, imageReferenceCases } from "../fixtures/image-reference-cases.mjs";
import { writeCommand } from "../helpers/fake-commands.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { rangeWideningLocale } from "../helpers/utf8-locale.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const sourceRevision = (
  await execute("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repository,
  })
).stdout.trim();
const upgradeScript = fileURLToPath(
  new URL("../../scripts/upgrade-production-images", import.meta.url),
);

test("production image upgrades preserve controller/runtime ownership and wait for ready Pods", async (t) => {
  const directory = await temporaryDirectory(t, "occ-production-upgrade-");
  const baselineControllerImage = `registry.example.invalid/controller@sha256:${"f".repeat(64)}`;
  const controllerImage = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`;
  const runtimeImage = `registry.example.invalid/runtime@sha256:${"b".repeat(64)}`;

  const bin = join(directory, "bin");
  await mkdir(bin);
  // The fixture commands below answer at once, and the readiness polls end on their
  // counters, not on time, so the helper's 2 s poll interval only adds wall time.
  await writeCommand(bin, "sleep", "exit 0\n", { interpreter: "bash" });
  await writeCommand(
    bin,
    "stat",
    `if [[ "$1" == "-f" ]]; then
  printf 'GNU filesystem report\\n'
  exit 1
fi
printf '600\\n'
`,
    { interpreter: "bash" },
  );

  await writeCommand(
    bin,
    "helm",
    `if [[ "$*" == *'get values'* ]]; then
  cat "$LIVE_VALUES_FILE"
elif [[ "$1" == "template" ]]; then
  exit 47
fi
`,
    { interpreter: "bash" },
  );

  await writeCommand(
    bin,
    "jq",
    `case "$*" in
  *'.info.status'*) printf 'deployed\\n' ;;
  *'.data['*) printf 'cHJvdGVjdGVkCg==\\n' ;;
  *'openclaw.dev/installation-id'*) printf '%s\\n' "$CLUSTER_INSTALLATION_ID" ;;
  '-eS '*) PATH="$ORIGINAL_TOOL_PATH" exec jq "$@" ;;
  '-S '*) cat ;;
  *'.installationId == '*) exit 0 ;;
  *'.spec.template.spec as $pod'*) exit 0 ;;
  *'.deploymentInProgress'*|*'.activeRevisionId == null'*|*'.status != "ready"'*) exit 1 ;;
  *'namespaceId: $namespace.id'*) exit 0 ;;
  *'.id'*) printf 'ins_upgrade_test\\n' ;;
esac
`,
    { interpreter: "bash" },
  );

  await writeCommand(
    bin,
    "yq",
    `case "$*" in
  *'-o=json '*)
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
    { interpreter: "bash" },
  );

  await writeCommand(
    bin,
    "python3",
    `if (($# == 3)); then
  printf '%s\\n' '${"e".repeat(64)}'
elif [[ "$1" == "-c" && "$2" != *b64decode* ]]; then
  command -p python3 "$@"
else
  cat >/dev/null
  cat "$LIVE_INSTALLATION_FILE"
fi
`,
    { interpreter: "bash" },
  );
  await writeCommand(bin, "kubectl", "exit 0\n", { interpreter: "bash" });

  const occ = await writeCommand(
    bin,
    "occ",
    `if [[ "$*" == *'deployment-inventory'* ]]; then
  printf '%s\\n' '{"installationId":"ins_upgrade_test","namespaces":[{"id":"ns_test","status":"ready","agents":[]}]}'
else
  printf '%s\\n' '{"id":"ins_upgrade_test"}'
fi
`,
    { interpreter: "bash" },
  );

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
    sourceRevision,
    "--evidence-dir",
    evidenceDirectory,
    "--occ",
    occ,
  ];
  const environment = {
    ...process.env,
    CLUSTER_INSTALLATION_ID: "ins_upgrade_test",
    CURRENT_CONTROLLER_IMAGE: baselineControllerImage,
    ORIGINAL_TOOL_PATH: process.env.PATH,
    LIVE_INSTALLATION_FILE: liveInstallation,
    LIVE_VALUES_FILE: liveValues,
    OCC_SERVICE_KEY_FILE: protectedFiles["service-key"],
    OCC_URL: "https://occ.example.invalid",
    // The helper runs node for its startup preflight; CI installs node outside /usr/bin.
    PATH: `${bin}:${dirname(process.execPath)}:/bin:/usr/bin`,
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
    /protected Helm values differ from the live release/,
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

  // Preserve ordered mapping documents, but refuse a scalar hidden before them.
  const installationDocuments = `${installationDocument}\n${JSON.stringify({ name: "second" })}\n`;
  try {
    await writeFile(liveInstallation, installationDocuments, { mode: 0o600 });
    await writeFile(protectedFiles.installation, installationDocuments, { mode: 0o600 });
    await assert.rejects(
      execute(upgradeScript, upgradeArguments(join(directory, "mapping-documents-evidence")), {
        cwd: repository,
        env: environment,
      }),
      (error) => {
        assert.equal(error.code, 47);
        return true;
      },
    );

    await writeFile(protectedFiles.installation, `42\n${installationDocuments}`, { mode: 0o600 });
    await assert.rejects(
      execute(upgradeScript, upgradeArguments(join(directory, "scalar-document-evidence")), {
        cwd: repository,
        env: environment,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /the protected Installation YAML differs from the live Secret/);
        return true;
      },
    );
  } finally {
    await writeFile(liveInstallation, installationDocument, { mode: 0o600 });
    await writeFile(protectedFiles.installation, installationDocument, { mode: 0o600 });
  }

  const readinessCounter = join(directory, "readiness-counter");
  const runtimeCountCounter = join(directory, "runtime-count-counter");
  const commandLog = join(directory, "commands.log");
  // The startup preflight reads each controller container's image and Installation
  // mount from the rendered chart; this stand-in renders only those fields.
  await writeCommand(
    bin,
    "helm",
    `printf 'helm %s\\n' "$*" >>"$COMMAND_LOG"
if [[ "$1" == status ]]; then
  state=deployed
  if [[ -n "\${CURRENT_HELM_EVIDENCE:-}" && -f "$CURRENT_HELM_EVIDENCE/prepared" ]]; then
    state="$CURRENT_HELM_STATE"
  fi
  printf '{"info":{"status":"%s"},"version":1}\\n' "$state"
elif [[ "$*" == *'get values'* ]]; then
  cat "$LIVE_VALUES_FILE"
elif [[ "$1" == template ]]; then
  printf -- '---\\n%s\\n' '{"kind":"Deployment","metadata":{"name":"openclaw-enterprise-api"},"spec":{"template":{"spec":{"volumes":[{"name":"installation-startup","secret":{"secretName":"occ-installation-startup","items":[{"key":"installation.yaml","path":"installation.yaml"}]}}],"containers":[{"name":"api","image":"'"$OBSERVED_CONTROLLER_IMAGE"'","volumeMounts":[{"name":"installation-startup","mountPath":"/etc/openclaw/installation"}]}]}}}}' '{"kind":"Deployment","metadata":{"name":"openclaw-enterprise-worker"},"spec":{"template":{"spec":{"volumes":[{"name":"installation-startup","secret":{"secretName":"occ-installation-startup","items":[{"key":"installation.yaml","path":"installation.yaml"}]}}],"containers":[{"name":"worker","image":"'"$OBSERVED_CONTROLLER_IMAGE"'","volumeMounts":[{"name":"installation-startup","mountPath":"/etc/openclaw/installation"}]}]}}}}'
fi
`,
    { interpreter: "bash" },
  );
  await writeCommand(
    bin,
    "jq",
    `if [[ "$*" == '-S '* || "$*" == '-eS '* ]]; then
  cat
  exit 0
fi
case "$*" in
  *'.info.status'*) node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).info.status' "\${!#}" ;;
  *'.data['*) printf 'cHJvdGVjdGVkCg==\\n' ;;
  *'openclaw.dev/installation-id'*) printf '%s\\n' "$CLUSTER_INSTALLATION_ID" ;;
  *'.installationId == '*) exit 0 ;;
  *'.spec.template.spec as $pod'*) exit 0 ;;
  *'.deploymentInProgress'*|*'.activeRevisionId == null'*|*'.status != "ready"'*) exit 1 ;;
  *'.configurationId | select'*) printf 'cfg_test\\n' ;;
  *'configurationId: $configurationId'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","name":"Test","configurationId":"cfg_test","values":{}}' ;;
  *'namespaceId: $namespace.id'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","executionMode":"dedicated","baselineRevisionId":"rev_test"}' ;;
  *'gatewayNamespace: $gatewayNamespace'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","deploymentId":"rev_candidate","gatewayNamespace":"tenant-test","gatewayName":"gateway-test","gatewayRestarts":0,"gatewayUid":"gateway-test-uid","revisionPods":[{"role":"gateway","namespace":"tenant-test","name":"gateway-test","uid":"gateway-test-uid","restarts":0}]}' ;;
  *'{namespaceId: $namespaceId'*) printf '%s\\n' '{"namespaceId":"ns_test","agentId":"agt_test","executionMode":"dedicated","deploymentId":"rev_candidate"}' ;;
  *'role: $role'*) printf '%s\\n' '[{"role":"gateway","namespace":"tenant-test","name":"gateway-test","uid":"gateway-test-uid","restarts":0}]' ;;
  *'.revisionPods'*) printf '%s\\n' '{"role":"gateway","namespace":"tenant-test","name":"gateway-test","uid":"gateway-test-uid","restarts":0}' ;;
  *'{namespace: .metadata.namespace, name: .metadata.name,'*) printf '%s\\n' '{"namespace":"tenant-test","name":"gateway-test","restarts":0,"uid":"gateway-test-uid"}' ;;
  *' .uid') cat >/dev/null; printf '"gateway-test-uid"\\n' ;;
  *'was replaced by a new Pod'*) exit 0 ;;
  *'.restarts'*|*'.gatewayRestarts'*) cat >/dev/null; printf '0\\n' ;;
  *'.lastState.terminated.reason'*) cat >/dev/null; printf '0\\tnone\\n' ;;
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
  *'.role'*) cat >/dev/null; printf 'gateway\\n' ;;
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
    { interpreter: "bash" },
  );
  await writeCommand(
    bin,
    "kubectl",
    `printf 'kubectl %s\\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  *'exec gateway-test --container gateway -- env NODE_OPTIONS=--max-old-space-size=384 node /app/openclaw.mjs doctor --lint --json --severity-min error'*)
    if [[ "$DOCTOR_FAILURE" == "1" ]]; then
      printf 'doctor found an error\\n' >&2
      exit 53
    fi
    printf '%s\\n' '{"status":"ok"}'
    ;;
  *' create --filename -'*) cat >/dev/null; printf '%s' 'fixture-preflight-uid' ;;
  *' create --filename'*) printf '%s' 'fixture-preflight-uid' ;;
  *'jsonpath='*) printf '%s\\n' "$OBSERVED_CONTROLLER_IMAGE" ;;
  *'get pods'*) printf '%s\\n' '{"items":[]}' ;;
  *' get pod/'*) printf '%s\\n' '{"status":{"phase":"Succeeded"}}' ;;
  *' logs pod/'*) printf 'agent-drafts-accepted\\ninstallation-startup-ready\\n' ;;
esac
`,
    { interpreter: "bash" },
  );
  await writeCommand(
    bin,
    "occ",
    `printf 'occ %s\\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  *'deployment-inventory'*) printf '%s\\n' '{"installationId":"ins_upgrade_test","namespaces":[{"id":"ns_test","status":"ready","agents":[{"id":"agt_test","status":"active","desiredRuntimeState":"running","executionMode":"dedicated","activeRevisionId":"rev_test","deploymentInProgress":false}]}]}' ;;
  *'agent deploy'*) printf '%s\\n' '{"id":"rev_candidate"}' ;;
  *'deployment-status'*) printf '%s\\n' '{"status":"succeeded"}' ;;
  *'agent get'*) printf '%s\\n' '{"activeRevisionId":"rev_candidate","configurationId":"cfg_test"}' ;;
  *'configuration get'*) printf '%s\\n' '{"id":"cfg_test","values":{}}' ;;
  *) printf '%s\\n' '{"id":"ins_upgrade_test","name":"Production"}' ;;
esac
`,
    { interpreter: "bash" },
  );

  // Preparation sees a deployed baseline; the common live reread sees a state
  // that must stop the attempt before another sensitive read or mutation.
  for (const [state, refusal] of [
    [
      "pending-upgrade",
      /Helm reports pending-upgrade; resolve the in-progress or unknown release/u,
    ],
    ["failed", /the Helm release changed before this upgrade started/u],
  ]) {
    await t.test(`current Helm status ${state} refuses before further reads`, async () => {
      const evidence = join(directory, `status-${state}`);
      await assert.rejects(
        execute(upgradeScript, upgradeArguments(evidence, ["controller"]), {
          cwd: repository,
          env: {
            ...environment,
            COMMAND_LOG: commandLog,
            CURRENT_HELM_EVIDENCE: evidence,
            CURRENT_HELM_STATE: state,
            OBSERVED_CONTROLLER_IMAGE: controllerImage,
          },
        }),
        refusal,
      );
      assert.equal(
        JSON.parse(await readFile(join(evidence, "current-helm-status.json"), "utf8")).info.status,
        state,
      );
      assert.match(
        await readFile(commandLog, "utf8"),
        /helm status [^\n]* --output json\n$/u,
        "no values, Secret, or mutating command may follow the refused current status",
      );
      await rm(commandLog);
    });
  }

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
  // This stand-in kubectl serves no cgroup files, so Doctor runs without the free-memory gate.
  assert.match(completed.stderr, /running OpenClaw Doctor without checking its free memory/u);
  assert.equal((await readFile(readinessCounter, "utf8")).trim(), "2");
  assert.equal((await readFile(runtimeCountCounter, "utf8")).trim(), "3");
  assert.match(
    await readFile(commandLog, "utf8"),
    /exec gateway-test --container gateway -- env NODE_OPTIONS=--max-old-space-size=384 node \/app\/openclaw\.mjs doctor --lint --json --severity-min error/u,
  );
});

// Argument validation precedes file and cluster access. Keep the kubeconfig
// absent so an accepted argument reaches a distinct, observable refusal.
function validationArguments(directory, revision = sourceRevision) {
  return [
    "--kubeconfig",
    join(directory, "kubeconfig"),
    "--context",
    "fixture",
    "--namespace",
    "openclaw-system",
    "--release",
    "oce",
    "--values",
    join(directory, "values"),
    "--installation",
    join(directory, "installation"),
    "--source-revision",
    revision,
    "--evidence-dir",
    join(directory, "evidence"),
  ];
}

// Exercise the real entrypoint and Git checkout; cluster tools only record an
// unexpected call. Missing private inputs make the next local boundary explicit.
test("production image upgrades bind the source revision before private inputs", async (t) => {
  const differentRevision = (sourceRevision[0] === "a" ? "b" : "a") + sourceRevision.slice(1);
  for (const [scenario, revision, expected] of [
    ["matching", sourceRevision, /kubeconfig must be a readable regular file/u],
    ["mismatched", differentRevision, /checkout commit does not match --source-revision/u],
    ["unavailable", sourceRevision, /could not verify the checkout commit/u],
    ["nested", sourceRevision, /could not verify the checkout commit/u],
    ["inherited-git-dir", sourceRevision, /could not verify the checkout commit/u],
    ["inherited-common-dir", sourceRevision, /kubeconfig must be a readable regular file/u],
    ["standalone", null, /--controller-image must be an approved immutable/u],
    ["linked", null, /--controller-image must be an approved immutable/u],
    ["external-core-worktree", null, /could not verify the checkout commit/u],
    ["external-git-work-tree", null, /could not verify the checkout commit/u],
  ]) {
    await t.test(scenario, async (t) => {
      const directory = await temporaryDirectory(t, "occ-upgrade-source-");
      const bin = join(directory, "bin");
      const log = join(directory, "cluster-calls");
      await mkdir(bin);
      for (const command of ["kubectl", "helm"]) {
        await writeCommand(bin, command, "exit 97\n", { log });
      }
      const env = { PATH: `${bin}:${dirname(process.execPath)}:/bin:/usr/bin` };
      let cwd = repository;
      if (scenario === "unavailable" || scenario === "inherited-git-dir") {
        cwd = directory;
      } else if (scenario === "nested") {
        cwd = join(repository, "tests");
      }
      // Ambient Git metadata must neither supply a missing checkout nor redirect
      // the current checkout's common directory away from its own gitfile.
      if (scenario === "inherited-git-dir") {
        env.GIT_DIR = join(repository, ".git");
      } else if (scenario === "inherited-common-dir") {
        env.GIT_COMMON_DIR = join(directory, "missing-common-dir");
      }
      let selectedRevision = revision;
      if (revision === null) {
        // Real Git metadata can name the right commit but a different worktree.
        // Keep repositories and identities local to this disposable fixture.
        const standalone = join(directory, "standalone");
        const external = join(directory, "external");
        const gitEnvironment = {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        };
        await execute("git", ["init", standalone], { env: gitEnvironment });
        const git = (args) => execute("git", args, { cwd: standalone, env: gitEnvironment });
        await git([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "Fixture",
        ]);
        selectedRevision = (await git(["rev-parse", "HEAD"])).stdout.trim();
        cwd = standalone;
        if (scenario === "linked") {
          await git(["worktree", "add", "--detach", external, "HEAD"]);
          cwd = external;
        } else if (scenario === "external-core-worktree") {
          await mkdir(external);
          await git(["config", "core.worktree", external]);
        } else if (scenario === "external-git-work-tree") {
          await mkdir(external);
          env.GIT_WORK_TREE = external;
        }
      }
      // Prove both guards are reachable, then clear their setup call receipts.
      for (const command of ["kubectl", "helm"]) {
        await assert.rejects(execute(command, [], { env }), { code: 97 });
      }
      await rm(log);
      await assert.rejects(
        execute(
          upgradeScript,
          [
            ...validationArguments(directory, selectedRevision),
            "--controller-image",
            // A bad image gives synthetic checkouts a boundary before helper/input access.
            revision === null
              ? "invalid"
              : `registry.example.invalid/controller@sha256:${"a".repeat(64)}`,
          ],
          { cwd, env },
        ),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, expected);
          return true;
        },
      );
      await assert.rejects(readFile(log), { code: "ENOENT" });
      await assert.rejects(readFile(join(directory, "evidence")), {
        code: "ENOENT",
      });
    });
  }
});

test("production image upgrades refuse uppercase repository paths and bad digests before touching the cluster", async (t) => {
  const directory = await temporaryDirectory(t, "occ-production-upgrade-digest-");
  const required = validationArguments(directory);
  // Kubernetes rejects uppercase digest hex as InvalidImageName, so each image
  // flag must refuse it instead of failing later in a rollout. A digest is
  // exactly 64 hex characters.
  for (const [flag, repositoryName, digest] of [
    ["--controller-image", "controller", "A".repeat(64)],
    ["--broker-image", "repository-credentials", "A".repeat(64)],
    ["--runtime-image", "runtime", "A".repeat(64)],
    ["--controller-image", "controller", "a".repeat(63)],
    ["--controller-image", "controller", "a".repeat(65)],
  ]) {
    await assert.rejects(
      execute(
        upgradeScript,
        [...required, flag, `registry.example.invalid/${repositoryName}@sha256:${digest}`],
        { cwd: repository },
      ),
      (error) => {
        assert.match(
          error.stderr,
          new RegExp(`${flag} must be an approved immutable SHA-256 image reference`, "u"),
        );
        return true;
      },
    );
  }
  // Kubernetes also rejects an uppercase repository path; only the registry host and the tag
  // may use uppercase, as in the chart and profile preflight.
  for (const [flag, image] of [
    ["--controller-image", "registry.example.invalid/Controller"],
    ["--broker-image", "registry.example.invalid:5000/team/Repository-credentials:release_1"],
    ["--runtime-image", "Runtime"],
  ]) {
    await assert.rejects(
      execute(upgradeScript, [...required, flag, `${image}@sha256:${"a".repeat(64)}`], {
        cwd: repository,
      }),
      (error) => {
        assert.match(
          error.stderr,
          new RegExp(`${flag} repository path must be lowercase`, "u"),
          image,
        );
        return true;
      },
    );
  }
});

// Each image flag takes exactly the references Kubernetes can pull with a lowercase SHA-256
// digest, as profile preflight, the chart and Compute do. Image flags are checked before any
// file access, so an accepted reference gets as far as the missing kubeconfig.
test("production image upgrades give image references Kubernetes' verdict", async (t) => {
  const directory = await temporaryDirectory(t, "occ-production-upgrade-references-");
  const kubeconfig = join(directory, "kubeconfig");
  const required = validationArguments(directory);
  const flags = ["--controller-image", "--broker-image", "--runtime-image"];
  for (const [index, [label, reference, problem]] of imageReferenceCases.entries()) {
    // Rotate the flag so every flag sees every kind of reference across the table.
    const flag = flags[index % flags.length];
    await assert.rejects(
      execute(upgradeScript, [...required, flag, reference], { cwd: repository }),
      (error) => {
        if (immutableImageAccepted(reference, problem)) {
          assert.doesNotMatch(error.stderr, new RegExp(flag, "u"), `${flag} ${label}`);
          assert.match(error.stderr, new RegExp(kubeconfig, "u"), `${flag} ${label}`);
        } else {
          assert.match(
            error.stderr,
            new RegExp(
              problem === "uppercase-repository" && /@sha256:[a-f0-9]{64}$/u.test(reference)
                ? `${flag} repository path must be lowercase`
                : `${flag} must be an approved immutable SHA-256 image reference`,
              "u",
            ),
            `${flag} ${label}`,
          );
        }
        return true;
      },
    );
  }
});

test("production image upgrades refuse non-ASCII inputs under a UTF-8 locale", async (t) => {
  const directory = await temporaryDirectory(t, "occ-production-upgrade-locale-");
  const locale = await rangeWideningLocale();
  if (!locale) {
    t.skip("en_US.UTF-8 is not installed; other locales do not widen bash ranges");
    return;
  }
  const options = { cwd: repository, env: { ...process.env, LANG: locale, LC_ALL: locale } };
  const argumentsFor = ({
    revision,
    timeout = "60",
    controllerImage = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`,
  }) => [
    ...validationArguments(directory, revision),
    "--timeout-seconds",
    timeout,
    "--controller-image",
    controllerImage,
  ];
  for (const [overrides, message] of [
    [{ revision: "é".repeat(40) }, /--source-revision must be a full lowercase Git commit SHA/u],
    [{ timeout: "٣" }, /--timeout-seconds must be positive/u],
    [
      { controllerImage: `registry.example.invalid/contrôleur@sha256:${"a".repeat(64)}` },
      /--controller-image must be an approved immutable SHA-256 image reference/u,
    ],
    [
      { controllerImage: `registry.example.invalid/controller@sha256:${"é".repeat(64)}` },
      /--controller-image must be an approved immutable SHA-256 image reference/u,
    ],
  ]) {
    await assert.rejects(execute(upgradeScript, argumentsFor(overrides), options), (error) => {
      assert.match(error.stderr, message);
      return true;
    });
  }
});

test("manual baseline comparison preserves mapping semantics and contains parser failures", async (t) => {
  const directory = await temporaryDirectory(t, "occ-baseline-compare-");
  const bin = join(directory, "bin");
  await mkdir(bin);
  const protectedFile = join(directory, "protected.yaml");
  const observedFile = join(directory, "observed.yaml");
  const compareScript = join(repository, "scripts/compare-upgrade-baseline");

  // Feed JSON-compatible YAML to real jq and simulate a parser that fails after
  // writing a valid document. The wrapper also checks its environment.
  await writeCommand(
    bin,
    "yq",
    `
[[ "\${protected-} \${observed-}" != *synthetic-private* ]] || exit 48
jq . "\${@: -1}" || exit $?
if [[ "\${PARTIAL_FAILURE:-}" == yes ]]; then
  echo 'synthetic-private parser excerpt' >&2
  exit 47
fi
`,
    { interpreter: "bash" },
  );
  for (const [left, right, status, partial] of [
    ['{"value":"synthetic-private","n":1}', '{"n":1,"value":"synthetic-private"}', 0],
    ['{"n":1}', '{"n":2}', 1],
    ["{}", "{}", 0],
    ['{"n":true}', '{"n":"true"}', 1],
    ['{"n":[1,2]}', '{"n":[2,1]}', 1],
    ["", "{}", 2],
    ["{} {}", "", 2],
    ["[]", "[]", 2],
    ['{"value":"synthetic-private"', "{}", 2],
    ["{}", '{"value":"synthetic-private"', 2],
    ["{}", "{}", 2, "yes"],
  ]) {
    await writeFile(protectedFile, left);
    await writeFile(observedFile, right);
    const result = await execute(compareScript, [protectedFile, observedFile], {
      cwd: repository,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        protected: "",
        observed: "",
        SHELLOPTS: "allexport",
        PARTIAL_FAILURE: partial ?? "",
      },
    }).then(
      (result) => ({ ...result, code: 0 }),
      (error) => error,
    );
    assert.equal(result.code, status);
    assert.equal(result.stdout, status === 0 ? "Configurations match.\n" : "");
    assert.doesNotMatch(result.stderr, /synthetic-private/);
  }
});
