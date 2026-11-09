import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { kubernetesGatewayNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { bashString, commandShim, startCommandServer } from "../helpers/fixture-command-server.mjs";
import { listen } from "../helpers/listen.mjs";
import { runDeployedCapability } from "../helpers/deployed-repository-capability.ts";
import { loadYaml, yamlDocuments } from "../helpers/qa-utils.mjs";
import { registerDispatchRestoreTests } from "../helpers/production-upgrade-dispatch-restore.ts";

const execute = promisify(execFile);
const helmTargetOverrides = [
  "HELM_KUBEAPISERVER",
  "HELM_KUBECAFILE",
  "HELM_KUBETLS_SERVER_NAME",
  "HELM_KUBEINSECURE_SKIP_TLS_VERIFY",
];
const readyCapability = { status: 200, body: '{"durableAdmissionVersion":1}' };
const repository = fileURLToPath(new URL("../..", import.meta.url));
const sourceRevision = (
  await execute("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repository,
  })
).stdout.trim();
const script =
  process.env.OCC_UPGRADE_SCRIPT ?? join(repository, "scripts/upgrade-production-images");
const controller = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`;
const runtime = `registry.example.invalid/runtime@sha256:${"b".repeat(64)}`;
const newController = `registry.example.invalid/controller@sha256:${"e".repeat(64)}`;
const newBroker = `registry.example.invalid/broker@sha256:${"f".repeat(64)}`;
const oldRuntime = `registry.example.invalid/runtime@sha256:${"c".repeat(64)}`;

// This fixture substitutes the external command protocols, not the upgrade script. It
// records accepted writes independently of the client response. helm, kubectl and occ
// (and node in pair cases) on the script's PATH are bash scripts answered by the
// fixture's command server (tests/helpers/fixture-command-server.mjs), so their logic
// below runs in the test process: a command costs a bash start instead of a node start.
// The script still starts every command as a real process, and the fixture state stays
// in state.json, which a command reads when it starts and cases edit between runs.

// The fixture tools exit 9 only for a fault armed with failNext, so an interrupted
// run must stop at that fault and not at an earlier refusal.
const injectedFault = { code: 9 };

// The fixture's helm stands in for the real binary; chart cases still render with it.
const realHelm = (
  await execute("bash", ["-c", "command -v helm"]).catch(() => ({ stdout: "" }))
).stdout.trim();
const commandPath = async (name, fallback) =>
  (
    await execute("bash", ["-c", `command -v ${name}`]).catch(() => ({ stdout: "" }))
  ).stdout.trim() || fallback;
const shimTools = {
  bash: "/bin/bash",
  sleep: await commandPath("sleep", "/bin/sleep"),
  setsid: await commandPath("setsid", "/usr/bin/setsid"),
};

// A started process's status and output, like spawnSync's, without blocking the other
// fixtures' commands while it runs.
function spawnResult(command, args, options, stderrFd = "pipe") {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", stderrFd] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ status: null, stdout, stderr: stderr + error.message }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// A YAML file as yq reads it; `yq -r` prints a missing or null field as "null".
async function yamlFile(file) {
  return JSON.parse((await execute("yq", ["-p=yaml", "-o=json", ".", file])).stdout);
}
const yqRaw = (value) => (value === undefined || value === null ? "null" : String(value).trim());
// yq's `//`: the alternative replaces a missing, null or false value.
const yqOr = (value, alternative) =>
  value === undefined || value === null || value === false ? alternative : value;

// Unless a case selects the real chart, a stand-in renders only what the startup
// preflight reads: each controller container's image and Installation mount.
async function standInChart(
  file,
  policy,
  recoveryHooks = false,
  initializationResources,
  ordinary = [],
  installationCheck = false,
) {
  const values = await yamlFile(file);
  const secretName = yqRaw(yqOr(values?.installation?.secretName, "occ-installation-startup"));
  const key = yqRaw(yqOr(values?.installation?.key, "installation.yaml"));
  const image = yqRaw(values?.images?.controller);
  const deployment = (component, placement) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "openclaw-enterprise-" + component },
    spec: {
      template: {
        spec: {
          serviceAccountName: "openclaw-enterprise-" + component,
          volumes: [
            {
              name: "installation-startup",
              secret: { secretName, items: [{ key, path: "installation.yaml" }] },
            },
          ],
          [placement]: [
            {
              name: component,
              image,
              env: [
                { name: "OCC_CONFIG_PATH", value: "/etc/openclaw/installation/installation.yaml" },
                ...(component === "api" && values.api?.channelDirectoryProxyUrl
                  ? [
                      {
                        name: "OCC_CHANNEL_DIRECTORY_PROXY_URL",
                        value: values.api.channelDirectoryProxyUrl,
                      },
                    ]
                  : []),
              ],
              volumeMounts: [
                {
                  name: "installation-startup",
                  mountPath: "/etc/openclaw/installation",
                  readOnly: true,
                },
              ],
            },
          ],
        },
      },
    },
  });
  const repositoryEnabled = yqRaw(yqOr(values?.repositoryCredentials?.enabled, false)) === "true";
  return [
    deployment("api", "containers"),
    deployment("worker", repositoryEnabled ? "initContainers" : "containers"),
    ...ordinary,
    ...(recoveryHooks
      ? [
          {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: {
              name: "oce-initialization",
              annotations: {
                "helm.sh/hook": "pre-install,pre-upgrade",
                "openclaw.dev/upgrade-attempt": values.installation.upgradeAttemptId,
              },
            },
            spec: {
              backoffLimit: 0,
              template: {
                metadata: {
                  annotations: {
                    "openclaw.dev/upgrade-attempt": values.installation.upgradeAttemptId,
                  },
                },
                spec: {
                  restartPolicy: "Never",
                  ...(installationCheck
                    ? {
                        volumes: [
                          {
                            name: "installation-startup",
                            secret: { secretName, items: [{ key, path: "installation.yaml" }] },
                          },
                        ],
                      }
                    : {}),
                  securityContext: {
                    runAsUser: 1000,
                    runAsGroup: 1000,
                    runAsNonRoot: true,
                    seccompProfile: { type: "RuntimeDefault" },
                  },
                  containers: [
                    {
                      name: "bootstrap",
                      image,
                      args: ["scripts/bootstrap-installation.mjs"],
                      ...(initializationResources ? { resources: initializationResources } : {}),
                      securityContext: { capabilities: { drop: ["ALL"] } },
                    },
                  ],
                  initContainers: [
                    ...(installationCheck
                      ? [
                          {
                            name: "installation-check",
                            image,
                            env: [
                              {
                                name: "OCC_CONFIG_PATH",
                                value: "/etc/openclaw/installation/installation.yaml",
                              },
                            ],
                            volumeMounts: [
                              {
                                name: "installation-startup",
                                mountPath: "/etc/openclaw/installation",
                                readOnly: true,
                              },
                            ],
                            command: ["node"],
                            args: [
                              "--input-type=module",
                              "-e",
                              readFileSync(
                                join(
                                  repository,
                                  "deploy/helm/openclaw-enterprise/files/check-installation.mjs",
                                ),
                                "utf8",
                              ),
                            ],
                            securityContext: { capabilities: { drop: ["ALL"] } },
                          },
                        ]
                      : []),
                    {
                      name: "migration",
                      image,
                      args: ["scripts/migrate-production.mjs"],
                      ...(initializationResources ? { resources: initializationResources } : {}),
                      securityContext: { capabilities: { drop: ["ALL"] } },
                    },
                  ],
                },
              },
            },
          },
        ]
      : []),
    ...(policy
      ? [
          {
            apiVersion: "networking.k8s.io/v1",
            kind: "NetworkPolicy",
            metadata: { name: "openclaw-enterprise-dependency-egress" },
            spec: { egress: [] },
          },
        ]
      : []),
  ]
    .map((document) => "---\n" + JSON.stringify(document) + "\n")
    .join("");
}

// Starts the preflight Pod's container once with its Secret/ConfigMap volumes and literal
// environment. Other cluster inputs (Secret-backed env, CA and token volumes) are
// not provided; chart cases point Compute at the test's Kubernetes API through an
// explicit kubeconfig instead of the Pod's service account. The container runs in
// OCC_TEST_PRODUCTION_IMAGE when set, otherwise as this checkout's source (the
// command's working directory) with /app mapped to it. Stand-in cases only record it.
async function runPreflight(root, cwd, state, pod) {
  const scripted = state.preflightResults?.[pod.spec.containers[0].name];
  if (scripted) {
    return scripted;
  }
  if (!state.startupCheck) {
    const drafts = pod.spec.containers[0].env?.some(
      (variable) => variable.name === "OCC_UPGRADE_PREFLIGHT_AGENT_DRAFTS",
    );
    return {
      phase: "Succeeded",
      log: (drafts ? "agent-drafts-accepted\n" : "") + "installation-startup-ready\n",
    };
  }
  const container = pod.spec.containers[0];
  const work = mkdtempSync(join(root, "preflight-"));
  chmodSync(work, 0o755);
  const mounts = [];
  for (const mount of container.volumeMounts ?? []) {
    const volume = pod.spec.volumes.find((item) => item.name === mount.name);
    const secret = volume?.secret && state.preflight.secrets[volume.secret.secretName];
    const configMap = volume?.configMap && state.themeConfigMaps[volume.configMap.name];
    const data = secret?.data ?? configMap?.data;
    if (!data) {
      continue;
    }
    const directory = join(work, mount.name);
    // The script runs under umask 077; the image's unprivileged user must still read the mount.
    mkdirSync(directory);
    chmodSync(directory, 0o755);
    const items =
      volume.secret?.items ??
      volume.configMap?.items ??
      Object.keys(data).map((key) => ({ key, path: key }));
    for (const item of items) {
      writeFileSync(
        join(directory, item.path),
        secret ? Buffer.from(data[item.key], "base64") : data[item.key],
      );
      chmodSync(join(directory, item.path), 0o644);
    }
    mounts.push([directory, mount.mountPath]);
  }
  const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
  if (state.unavailableDraftResolver) {
    // Preserve all other exports, including those used by ordinary startup imports.
    const resolver = "packages/occ/src/configured-harness.ts";
    const current = "configured-harness-current.ts";
    const overlay = join(work, "configured-harness.ts");
    writeFileSync(
      overlay,
      `export * from ${JSON.stringify(image ? `./${current}` : join(cwd, resolver))};\n` +
        "export const resolveConfiguredHarnessId = undefined;\n",
    );
    chmodSync(overlay, 0o644);
    // As with olderDraftRules, image mode mounts the selected checkout's source beside
    // the overlay. Source mode's existing local() mount mapping redirects the generated
    // import to the overlay; the generated API program itself is unchanged.
    if (image) {
      mounts.push([join(cwd, resolver), `/app/packages/occ/src/${current}`]);
    }
    mounts.push([overlay, `/app/${resolver}`]);
  }
  if (state.olderDraftRules) {
    // An image built before refuseUndeployableConfigurationValues existed: its
    // configuration-settings module has every other export but not that one. The stand-in
    // module re-exports the real one; its own export shadows the new rule.
    const settings = "packages/occ/src/configuration-settings.ts";
    const current = "configuration-settings-current.ts";
    const older = join(work, "configuration-settings.ts");
    writeFileSync(
      older,
      `export * from ${JSON.stringify(image ? `./${current}` : join(cwd, settings))};\n` +
        "export const refuseUndeployableConfigurationValues = undefined;\n",
    );
    chmodSync(older, 0o644);
    // In the image the stand-in replaces the module for every importer, so the real module
    // moves beside it.
    if (image) {
      mounts.push([join(cwd, settings), `/app/packages/occ/src/${current}`]);
    }
    mounts.push([older, `/app/${settings}`]);
  }
  // Kubernetes expands $(VAR) in literal values from earlier variables and turns $$ into $.
  const expanded = {};
  const env = (container.env ?? [])
    .filter((item) => typeof item.value === "string")
    .map((item) => {
      const value = item.value.replace(/\$\$|\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (match, name) =>
        match === "$$" ? "$" : (expanded[name] ?? match),
      );
      expanded[item.name] = value;
      return { name: item.name, value };
    });
  const local = (value) =>
    mounts
      .reduce((current, [source, target]) => current.split(target).join(source), value)
      .split("/app/apps/")
      .join(cwd + "/apps/")
      .split("/app/packages/")
      .join(cwd + "/packages/");
  const result = image
    ? // Host networking reaches the test's loopback Kubernetes API only with rootful Docker.
      await spawnResult(
        "docker",
        [
          "run",
          "--rm",
          ...(state.kubeconfig
            ? [
                "--network",
                "host",
                "--mount",
                `type=bind,src=${state.kubeconfig},dst=${state.kubeconfig},readonly`,
              ]
            : ["--network", "none"]),
          ...mounts.flatMap(([source, target]) => [
            "--mount",
            `type=bind,src=${source},dst=${target},readonly`,
          ]),
          ...env.flatMap((item) => ["--env", item.name + "=" + item.value]),
          "--entrypoint",
          container.command[0],
          image,
          ...container.args,
        ],
        { cwd },
      )
    : await spawnResult(process.execPath, container.args.map(local), {
        cwd,
        env: Object.fromEntries(env.map((item) => [item.name, local(item.value)])),
      });
  return {
    phase: result.status === 0 ? "Succeeded" : "Failed",
    log: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

// One command of one fixture. `io` (fixture-command-server.mjs) writes its output and
// ends it; returning without an exit ends it with status 0.
async function fakeCommand(root, { command: tool, args, cwd }, io, afterDeploy) {
  const stateFile = join(root, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  const log = (value) => appendFileSync(join(root, "events"), value + "\n");
  const take = (name) => {
    const path = join(root, name);
    if (!existsSync(path)) {
      return false;
    }
    unlinkSync(path);
    return true;
  };
  const out = (value) => io.stdout(typeof value === "string" ? value : JSON.stringify(value));
  const fail = (code, message) => {
    if (message !== undefined) {
      io.stderr(message + "\n");
    }
    io.exit(code);
  };
  const fileArg = (name) => args[args.indexOf(name) + 1];
  // The replacement revision's ready gateway Pod; an OOM kill shows in its restart history.
  const gatewayPod = () => ({
    metadata: { namespace: "tenant", name: "gateway", uid: "gateway-uid" },
    spec: { containers: [{ name: "gateway", image: runtime }] },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "gateway",
          restartCount: state.gatewayRestarts ?? 0,
          lastState: state.gatewayRestarts
            ? { terminated: { reason: state.gatewayLastReason ?? "OOMKilled" } }
            : {},
        },
      ],
    },
  });
  if (tool === "node") {
    // Pair cases exercise upgrade orchestration after a successful qualification. The
    // separately selected real-image test verifies compatibility itself.
    if (args[0] === "scripts/upgrade-repository-image-probe.mjs") {
      const identity = (image) => ({
        image,
        platform: args[3],
        rootDigest: image.split("@").at(-1),
        manifestDigest: image.split("@").at(-1),
        configDigest: image.split("@").at(-1),
      });
      out(JSON.stringify({ controller: identity(args[1]), broker: identity(args[2]) }) + "\n");
    } else {
      // Every other script runs in this Node, on the command's own pipes.
      io.script(`exec ${bashString(process.execPath)} "$@"`);
      return;
    }
  } else if (tool === "helm") {
    if (args[0] === "status") {
      if (
        state.api === 0 &&
        state.worker === 0 &&
        existsSync(join(root, "fail-before-helm-intent")) &&
        (await yamlFile(join(root, "values.json")))?.installation?.upgradeAttemptId !==
          (await yamlFile(join(root, "live-values")))?.installation?.upgradeAttemptId &&
        take("fail-before-helm-intent")
      ) {
        return fail(9);
      }
      out(
        args.includes("json")
          ? {
              name: state.release,
              namespace: "system",
              config: await yamlFile(join(root, "live-values")),
              ...(state.recoveryHooks && !state.recoveryRelease
                ? {
                    manifest:
                      (await standInChart(join(root, "live-values"), false)) +
                      (state.recoveryBaselineResources ?? [])
                        .map((item) => "---\n" + JSON.stringify(item) + "\n")
                        .join(""),
                  }
                : {}),
              ...state.installationRelease,
              ...state.recoveryRelease,
              version: state.version,
              info: { ...state.recoveryRelease?.info, status: state.helmStatus },
            }
          : state.helmStatus,
      );
    } else if (args[0] === "get") {
      out(readFileSync(join(root, "live-values"), "utf8"));
    } else if (args[0] === "template" && state.realChart) {
      // Like the real binary, a failed render shows helm's own stderr and status.
      const rendered = await spawnResult(realHelm, args, { cwd });
      io.stderr(rendered.stderr);
      if (rendered.status !== 0) {
        return fail(rendered.status ?? 1);
      }
      out(rendered.stdout);
    } else if (args[0] === "template") {
      out(
        await standInChart(
          fileArg("--values"),
          state.preflightPolicy,
          state.recoveryHooks,
          state.initializationResources,
          state.recoveryCandidateResources,
          Boolean(state.installationSuccessor),
        ),
      );
    } else if (args[0] === "rollback") {
      assert.ok(!args.includes("--no-hooks"));
      assert.equal(Number(args[2]), state.version);
      log("rollback");
      state.recoveryRelease.info.description = `Rollback to ${state.version}`;
      state.version += 1;
      state.helmStatus = "deployed";
      state.api = 1;
      state.worker = 1;
      state.rollbackSubmissions = (state.rollbackSubmissions ?? 0) + 1;
      save();
      if (take("lost-rollback-response")) {
        return fail(9);
      }
    } else if (
      args[0] === "upgrade" &&
      args.includes("--dry-run=server") &&
      take("fail-server-dry-run")
    ) {
      return fail(9, "synthetic server dry-run diagnostic");
    } else if (args[0] === "upgrade" && !args.includes("--dry-run=server")) {
      if (state.api !== 0 || state.worker !== 0) {
        return fail(2, "old writers were not stopped");
      }
      state.helmSubmissions = (state.helmSubmissions ?? 0) + 1;
      save();
      if (take("reject-helm-submission")) {
        return fail(9);
      }
      log("migration");
      state.version += 1;
      copyFileSync(fileArg("--values"), join(root, "live-values"));
      if (take("fail-migration")) {
        state.helmStatus = "failed";
        save();
        return fail(9);
      }
      state.helmStatus = "deployed";
      const values = await yamlFile(fileArg("--values"));
      state.controller = yqRaw(values?.images?.controller);
      state.checksum = yqRaw(values?.controlPlane?.installationChecksum);
      if (state.installationSuccessor) {
        // The accepted Helm submission creates the selected initializer and its
        // completed child; later reads can diverge independently of the manifest.
        const rendered = await standInChart(
          fileArg("--values"),
          state.preflightPolicy,
          true,
          state.initializationResources,
          state.recoveryCandidateResources,
          true,
        );
        const documents = yamlDocuments(rendered).map(loadYaml);
        const desiredJob = documents.find((object) => object.kind === "Job");
        // Store the accepted release separately from live objects so a later
        // same-values Helm record can be checked independently of running Pods.
        state.installationRelease = {
          manifest: documents
            .filter((object) => object !== desiredJob)
            .map((object) => JSON.stringify(object))
            .join("\n---\n"),
          hooks: [
            {
              name: desiredJob.metadata.name,
              manifest: JSON.stringify(desiredJob),
              events: ["pre-install", "pre-upgrade"],
              last_run: { phase: "Succeeded" },
            },
          ],
        };
        const job = structuredClone(desiredJob);
        Object.assign(job.metadata, { namespace: "system", uid: "initializer-job" });
        job.status = { conditions: [{ type: "Complete", status: "True" }], succeeded: 1 };
        state.installationInitializer = {
          job,
          pod: {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...structuredClone(job.spec.template.metadata),
              namespace: "system",
              name: "initializer-pod",
              uid: "initializer-pod-uid",
              ownerReferences: [
                {
                  apiVersion: "batch/v1",
                  kind: "Job",
                  name: job.metadata.name,
                  uid: job.metadata.uid,
                  controller: true,
                },
              ],
            },
            spec: structuredClone(job.spec.template.spec),
            status: {
              phase: "Succeeded",
              initContainerStatuses: job.spec.template.spec.initContainers.map(({ name }) => ({
                name,
                state: { terminated: { exitCode: 0 } },
              })),
              containerStatuses: [{ name: "bootstrap", state: { terminated: { exitCode: 0 } } }],
            },
          },
        };
      }
      state.api = 1;
      state.worker = 1;
      save();
      if (take("lost-helm-response")) {
        return fail(9);
      }
    }
  } else if (tool === "kubectl") {
    if (args.includes("create") && args.includes("--raw")) {
      assert.equal(fileArg("--raw"), "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews");
      const review = JSON.parse(await io.readInput());
      assert.deepEqual(review, {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: {
          resourceAttributes: {
            namespace: "system",
            verb: "update",
            group: "",
            resource: "secrets",
            name: state.secret.metadata.name,
          },
        },
      });
      state.installationUpdateReviews = (state.installationUpdateReviews ?? 0) + 1;
      save();
      if (state.reviewUnavailable) {
        return fail(1, "private self-review diagnostic");
      }
      delete review.spec.resourceAttributes.group; // Kubernetes omits the empty core API group.
      out({
        ...review,
        status: { allowed: !state.denyInstallationUpdate, reason: "private self-review reason" },
      });
      return io.exit(0);
    }
    if (
      !state.recoveryResources &&
      state.installationInitializer &&
      args.includes("get") &&
      args.includes("--filename")
    ) {
      const requested = JSON.parse(await io.readInput());
      assert.equal(requested.kind, "Job");
      assert.equal(requested.metadata.name, state.installationInitializer.job.metadata.name);
      out({ apiVersion: "v1", kind: "List", items: [state.installationInitializer.job] });
      return io.exit(0);
    }
    if (
      !state.recoveryPod &&
      state.installationInitializer &&
      args.includes("get") &&
      args.includes("--selector") &&
      fileArg("--selector") ===
        `batch.kubernetes.io/controller-uid=${state.installationInitializer.job.metadata.uid}`
    ) {
      out({ items: [state.installationInitializer.pod] });
      return io.exit(0);
    }
    if (state.recoveryResources && args.includes("get") && args.includes("--filename")) {
      const requested = JSON.parse(await io.readInput());
      const key = `${requested.kind}/${requested.metadata.name}`;
      if (args.includes("--ignore-not-found")) {
        state.retiredResourceReads = (state.retiredResourceReads ?? 0) + 1;
        if (state.retiredResourceAppearsAt === state.retiredResourceReads) {
          state.recoveryResources[key] = state.recoveryBaselineResources[0];
        }
        save();
        if (state.retiredResourceReadError) {
          return fail(1, "Forbidden: cannot read selected retired resource");
        }
        assert.equal(fileArg("--output"), "name");
        out(state.recoveryResources[key] ? `${requested.kind}/${requested.metadata.name}\n` : "");
        return io.exit(0);
      }
      const actual =
        requested.kind === "Secret"
          ? [state.secret, state.installationSuccessor].find(
              (secret) => secret?.metadata.name === requested.metadata.name,
            )
          : state.recoveryResources[key];
      assert.ok(actual, `known recovery resource ${key}`);
      out({ apiVersion: "v1", kind: "List", items: [actual] });
      return io.exit(0);
    }
    if (
      state.recoveryPod &&
      args.includes("get") &&
      args.includes("--selector") &&
      fileArg("--selector").startsWith("batch.kubernetes.io/controller-uid=")
    ) {
      out({ items: [state.recoveryPod] });
      return io.exit(0);
    }
    state.preflight ??= {
      secrets: {},
      pods: {},
      jobs: {},
      networkpolicies: {},
      deleted: [],
    };
    const resource = args.find((a) =>
      /^(pod|job\.batch|secret|networkpolicy\.networking\.k8s\.io)\//.test(a),
    );
    const collection = {
      pod: "pods",
      "job.batch": "jobs",
      secret: "secrets",
      "networkpolicy.networking.k8s.io": "networkpolicies",
    };
    if (args.includes("create") && args.includes("--filename")) {
      const source = fileArg("--filename");
      const manifest = source === "-" ? await io.readInput() : readFileSync(source, "utf8");
      const object = JSON.parse(manifest);
      if (state.installationSuccessor) {
        (state.preflight.requested ??= []).push(structuredClone(object));
      }
      const kind = {
        Secret: "secret",
        NetworkPolicy: "networkpolicy.networking.k8s.io",
        Job: "job.batch",
      }[object.kind];
      assert.ok(kind, "supported preflight resource kind");
      const name = object.metadata.name;
      const resourceName = `${kind}/${name}`;
      const target = object.kind === "Job" ? object.spec.template.spec.containers[0].name : kind;
      const inventory = state.preflight[collection[kind]];
      const fault = state.preflightFault?.target === target ? state.preflightFault.mode : null;
      // Stock kubectl quotes a manifest it cannot decode in its error, before any request.
      if (fault === "decode") {
        return fail(
          1,
          `error: unable to decode "STDIN": Object 'Kind' is missing in '${manifest}'`,
        );
      }
      // A competing creator wins the name before this request reaches the API.
      if (fault === "conflict") {
        inventory[name] = {
          metadata: { name, uid: randomUUID() },
          foreign: true,
        };
      }
      if (inventory[name]) {
        save();
        // Even stdout from a failed create must not establish ownership.
        out(inventory[name].metadata.uid);
        return fail(
          1,
          `Error from server (AlreadyExists): ${collection[kind]} "${name}" already exists`,
        );
      }
      if (state.preflightFault?.mode === "interrupt") {
        object.metadata.annotations = { "fixture/manifest": "private-manifest-sentinel" };
        if (kind === "secret") {
          object.data.fixture = Buffer.from("private-secret-sentinel").toString("base64");
        }
      }
      object.metadata.uid =
        (state.preflightFault?.target === target && state.preflightFault.uid) || randomUUID();
      (state.preflight.created ??= []).push({ kind, name, uid: object.metadata.uid });
      if (fault === "evidence-file" || fault === "evidence-symlink") {
        const destination = join(root, "evidence", "preflight-secret-identity.json");
        if (fault === "evidence-symlink") {
          const target = join(root, "unrelated");
          writeFileSync(target, "unrelated sentinel");
          symlinkSync(target, destination);
        } else {
          writeFileSync(destination, "unrelated sentinel");
        }
      }
      inventory[name] = object;
      if (object.kind === "Job" && fault !== "no-child") {
        // Model the Job controller's API objects, not its scheduling or garbage collector.
        // The upgrade command must establish ownership from this owner reference.
        const child = {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            ...object.spec.template.metadata,
            name: `${name}-child`,
            namespace: object.metadata.namespace,
            uid: randomUUID(),
            labels: {
              ...object.spec.template.metadata.labels,
              "batch.kubernetes.io/controller-uid": object.metadata.uid,
            },
            ownerReferences: [
              {
                apiVersion: "batch/v1",
                kind: "Job",
                name,
                uid: fault === "foreign-child" ? randomUUID() : object.metadata.uid,
                controller: true,
              },
            ],
          },
          spec: object.spec.template.spec,
        };
        const result = await runPreflight(root, cwd, state, child);
        state.preflight.pods[child.metadata.name] = { ...child, ...result };
        const phase = result.status?.phase ?? result.phase;
        if (phase === "Succeeded") {
          object.status = { conditions: [{ type: "Complete", status: "True" }] };
        } else if (phase === "Failed") {
          object.status = {
            conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }],
          };
        }
        if (fault === "job-deadline") {
          object.status = {
            conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
          };
        }
        (state.preflight.children ??= []).push({
          kind: "pod",
          name: child.metadata.name,
          uid: child.metadata.uid,
        });
      }
      save();
      if (fault === "lost") {
        out(object.metadata.uid);
        return fail(9, "create acknowledgement lost: private-response-marker");
      }
      if (fault === "empty") {
        out("");
      } else if (fault === "newline") {
        out(object.metadata.uid + "\n");
      } else if (fileArg("-o") === "jsonpath={.metadata.uid}") {
        // Stock kubectl's jsonpath output has no terminator.
        out(object.metadata.uid);
      } else {
        out(`${resourceName} created`);
      }
    } else if (args.includes("delete")) {
      const raw = args.find((arg) => arg.startsWith("--raw="));
      let named = resource;
      let uid;
      if (raw) {
        const match =
          /^--raw=\/(api\/v1|apis\/networking\.k8s\.io\/v1|apis\/batch\/v1)\/namespaces\/system\/(pods|secrets|networkpolicies|jobs)\/([a-z0-9.-]+)$/.exec(
            raw,
          );
        assert.ok(match, "DELETE addresses a named Kubernetes API resource");
        assert.equal(
          match[1],
          { networkpolicies: "apis/networking.k8s.io/v1", jobs: "apis/batch/v1" }[match[2]] ??
            "api/v1",
        );
        assert.equal(fileArg("-f"), "-");
        // An empty raw body is a real unguarded DELETE, not a fixture rejection.
        const body = await io.readInput();
        const options = body ? JSON.parse(body) : {};
        uid = options.preconditions?.uid;
        if (uid) {
          assert.equal(options.apiVersion, "v1");
          assert.equal(options.kind, "DeleteOptions");
          assert.equal(
            options.propagationPolicy,
            match[2] === "jobs" ? "Foreground" : "Background",
          );
        }
        named = `${{ pods: "pod", jobs: "job.batch", secrets: "secret", networkpolicies: "networkpolicy.networking.k8s.io" }[match[2]]}/${match[3]}`;
      }
      assert.ok(named, "delete must identify a preflight resource");
      const [kind, name] = named.split("/");
      const inventory = state.preflight[collection[kind]];
      // Replacement occurs at DELETE, after all client reads, to model the race.
      if (
        state.preflightFault?.mode === "replacement" &&
        state.preflightFault.target === inventory[name]?.spec?.template?.spec?.containers?.[0]?.name
      ) {
        inventory[name] = {
          metadata: { name, uid: randomUUID() },
          foreign: true,
        };
      }
      const current = inventory[name];
      if (!current) {
        return raw ? fail(1, "NotFound: private-response-marker") : undefined;
      }
      if (uid && current.metadata.uid !== uid) {
        save();
        // The API server's wording for a failed UID precondition (HTTP 409).
        return fail(
          1,
          `Error from server (Conflict): Operation cannot be fulfilled on ${collection[kind]} "${name}": Precondition failed: UID in precondition: ${uid}, UID in object meta: ${current.metadata.uid}\nprivate-response-marker`,
        );
      }
      if (state.preflightFault?.mode === "delete-refused" && state.preflightFault.target === kind) {
        return fail(
          1,
          `Error from server (Forbidden): ${collection[kind]} "${name}" is forbidden: private-response-marker`,
        );
      }
      // Keep unsafe name-only deletion functional: baseline failures must show
      // the foreign object actually removed, not an unsupported-command error.
      if (kind === "job.batch") {
        // This accepted response removes only real children. A retained child models
        // asynchronous deletion so the caller cannot equate DELETE success with cleanup.
        for (const [childName, child] of Object.entries(state.preflight.pods)) {
          if (child.metadata.ownerReferences.some((owner) => owner.uid === current.metadata.uid)) {
            if (
              state.preflightFault?.mode !== "retained-child" ||
              state.preflightFault.target !== child.spec.containers[0].name
            ) {
              delete state.preflight.pods[childName];
            }
          }
        }
      }
      delete inventory[name];
      state.preflight.deleted.push(named);
      save();
      out({
        apiVersion: "v1",
        kind: "Status",
        status: "Success",
        message: "private-delete-response-marker",
      });
    } else if (
      resource?.startsWith("pod/") &&
      args.includes("get") &&
      state.revisionPods &&
      !state.preflight.children?.some((child) => resource === `pod/${child.name}`) &&
      !(resource.slice("pod/".length) in state.preflight.pods)
    ) {
      // The revision's Pods, as scripted (a dedicated Agent's two) or after an eviction or
      // replacement: a read by name finds a Pod that still exists, ended or not, as the
      // Kubernetes API does. The startup preflight's Pods are read below.
      const pod = state.revisionPods.find((item) => "pod/" + item.metadata.name === resource);
      if (!pod) {
        return fail(1, `Error from server (NotFound): pods "${resource.slice(4)}" not found`);
      }
      out(pod);
    } else if (resource === "pod/gateway" && args.includes("get")) {
      out(state.gatewayAfter ?? gatewayPod());
    } else if (resource && (args.includes("get") || args.includes("logs"))) {
      const [kind, name] = resource.split("/");
      const object = state.preflight[collection[kind]][name];
      if (!object) {
        if (args.includes("--ignore-not-found")) {
          return io.exit(0);
        }
        return fail(1, `Error from server (NotFound): ${resource} not found`);
      }
      if (args.includes("logs")) {
        const component = object.spec.containers[0].name;
        (state.preflight.logRequests ??= []).push(component);
        if (state.replaceInstallationDuringPreflight) {
          // A separately accepted Secret replacement happens while the temporary
          // startup Job runs, after the upgrade captured both immutable identities.
          state[state.replaceInstallationDuringPreflight].metadata.uid += "-replacement";
          delete state.replaceInstallationDuringPreflight;
        }
        if (
          state.preflightFault?.target === component &&
          state.preflightFault.mode === "replace-during-logs"
        ) {
          // A name-based logs request races with replacement after its preceding GET.
          object.metadata.uid = randomUUID();
          object.log = "installation-startup-ready\nunbound-log-sentinel\n";
        }
        save();
      }
      if (args.includes("logs") && object.log === undefined) {
        return fail(1, "container is waiting to start");
      }
      if (args.includes("logs") && object.log.includes("\0")) {
        // Emit bytes directly: the command server's ordinary Bash strings cannot hold NUL.
        const escaped = Buffer.from(object.log).toString("hex").replace(/../g, "\\x$&");
        return io.script(`printf '%b' ${bashString(escaped)}; exit 0`);
      }
      out(
        args.includes("logs")
          ? object.log
          : {
              ...object,
              ...(kind === "pod" ? { status: object.status ?? { phase: object.phase } } : {}),
            },
      );
    } else if (
      args.includes("get") &&
      args.includes("pods") &&
      args.some((arg) => arg.startsWith("batch.kubernetes.io/controller-uid="))
    ) {
      const selector = args.find((arg) => arg.startsWith("batch.kubernetes.io/controller-uid="));
      const ownerUid = selector.slice("batch.kubernetes.io/controller-uid=".length);
      const pods = Object.values(state.preflight.pods).filter(
        (pod) => pod.metadata.labels["batch.kubernetes.io/controller-uid"] === ownerUid,
      );
      const changing = pods.find(
        (pod) =>
          state.preflightFault?.mode === "replace-after-observation" &&
          state.preflightFault.target === pod.spec.containers[0].name,
      );
      if (changing) {
        if (state.preflight.childObserved && !state.preflight.childReplaced) {
          // The previously observed running Pod disappeared; its name now selects a new UID.
          changing.metadata.uid = randomUUID();
          changing.phase = "Succeeded";
          state.preflight.childReplaced = true;
        }
        state.preflight.childObserved = true;
        save();
      }
      out({ items: pods.map((pod) => ({ ...pod, status: pod.status ?? { phase: pod.phase } })) });
    } else if (args.includes("--raw=/readyz")) {
      out("ok");
    } else if (args.includes("rollout")) {
      const component = args
        .find((arg) => arg.startsWith("deployment/"))
        .split("-")
        .at(-1);
      if (take("fail-rollout-" + component)) {
        return fail(9);
      }
    } else if (args.includes("scale") || args.includes("patch")) {
      const component = args
        .find((a) => a.startsWith("deployment/"))
        .split("-")
        .at(-1);
      if (take("fail-scale-" + component)) {
        if (take("block-failure-receipt")) {
          mkdirSync(join(root, "evidence", "native-command-failures.tsv"));
        }
        return fail(9);
      }
      // Simulate another actor between the helper's GET and its mutation. Keep
      // scale support so the same scenario demonstrates the unguarded baseline.
      state.deploymentIdentities ??= {};
      const identity = (state.deploymentIdentities[component] ??= {
        uid: component + "-deployment-uid",
        resourceVersion: "1",
      });
      if (component === "worker" && take("replace-worker-before-scale")) {
        identity.uid = "replacement-worker-uid";
        identity.resourceVersion = "2";
        state.worker = 1;
      }
      if (component === "worker" && take("edit-worker-before-scale")) {
        identity.resourceVersion = "2";
      }
      save();
      if (args.includes("patch")) {
        assert.equal(fileArg("--type"), "json");
        const patch = JSON.parse(readFileSync(fileArg("--patch-file"), "utf8"));
        const document = { metadata: identity, spec: { replicas: state[component] } };
        // Kubernetes JSON Patch tests are evaluated before committing any writes.
        for (const operation of patch) {
          const keys = operation.path.slice(1).split("/");
          const parent = keys.slice(0, -1).reduce((value, key) => value[key], document);
          const key = keys.at(-1);
          if (operation.op === "test") {
            if (parent[key] !== operation.value) {
              return fail(1, "JSON Patch test failed");
            }
          } else {
            assert.equal(operation.op, "replace");
            parent[key] = operation.value;
          }
        }
        state[component] = document.spec.replicas;
      } else {
        state[component] = 0;
      }
      identity.resourceVersion = String(Number(identity.resourceVersion) + 1);
      save();
      log("scale-" + component);
    } else if (args.includes("replace")) {
      const secret = JSON.parse(await io.readInput());
      if (state.denyInstallationUpdate) {
        return fail(1, "fixture denied named Secret update");
      }
      if (secret.metadata.resourceVersion !== state.secret.metadata.resourceVersion) {
        return fail(11);
      }
      if (
        state.secret.immutable &&
        secret.data["installation.yaml"] !== state.secret.data["installation.yaml"]
      ) {
        return fail(1, "Secret data is immutable");
      }
      secret.metadata.resourceVersion = String(Number(secret.metadata.resourceVersion) + 1);
      state.secret = secret;
      save();
      log("secret-replaced");
      if (take("lost-secret-response")) {
        return fail(9);
      }
    } else if (args.includes("get") && args.includes("secret")) {
      const name = args[args.indexOf("secret") + 1];
      if (name === state.installationSuccessor?.metadata.name) {
        out(state.installationSuccessor);
      } else if (name !== state.secret.metadata.name && name === state.collectorSecretName) {
        if (!state.collectorSecret) {
          return fail(1, 'secrets "' + name + '" not found');
        }
        out(state.collectorSecret);
      } else if (name === state.secret.metadata.name) {
        out(state.secret);
      } else {
        return fail(1, 'secrets "' + name + '" not found');
      }
    } else if (args.includes("get") && args.includes("nodes")) {
      const architecture = process.arch === "x64" ? "amd64" : "arm64";
      if (existsSync(join(root, "change-node"))) {
        state.nodeReads = (state.nodeReads ?? 0) + 1;
        save();
      }
      const uid = state.nodeReads > 1 ? "replacement-node-uid" : "node-uid";
      out({
        items: [
          {
            metadata: {
              name: "node-a",
              uid,
              labels: { "kubernetes.io/os": "linux", "kubernetes.io/arch": architecture },
            },
            status: { nodeInfo: { operatingSystem: "linux", architecture } },
          },
        ],
      });
    } else if (
      args.includes("get") &&
      args.includes("deployment") &&
      args.includes("openclaw-enterprise-worker")
    ) {
      out({
        metadata: { labels: { "app.kubernetes.io/instance": state.release } },
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: "repository-credentials",
                  args: ["--public-origin", "https://git.system.svc.cluster.local"],
                },
              ],
            },
          },
        },
      });
    } else if (args.some((a) => a.startsWith("deployment/")) && args.includes("get")) {
      const component = args
        .find((a) => a.startsWith("deployment/"))
        .split("-")
        .at(-1);
      const image =
        component === "worker" ? (state.workerObservedImage ?? state.controller) : state.controller;
      const container = { name: component, image };
      const podSpec = { containers: [container] };
      if (state.installationSuccessor) {
        const values = await yamlFile(join(root, "live-values"));
        podSpec.volumes = [
          {
            name: "installation-startup",
            secret: {
              secretName: values.installation.secretName,
              items: [{ key: values.installation.key, path: "installation.yaml" }],
            },
          },
        ];
        container.env = [
          { name: "OCC_CONFIG_PATH", value: "/etc/openclaw/installation/installation.yaml" },
        ];
        container.volumeMounts = [
          {
            name: "installation-startup",
            mountPath: state.installationDeploymentMountPath ?? "/etc/openclaw/installation",
            readOnly: true,
          },
        ];
      }
      if (component === "worker" && state.workerPlacement !== "container") {
        podSpec.containers =
          state.workerPlacement === "ambiguous"
            ? [container]
            : [{ name: "repository-credentials", image: "broker" }];
        if (state.workerPlacement !== "missing") {
          podSpec.initContainers = [
            {
              ...container,
              ...(state.workerPlacement === "nonrestartable" ? {} : { restartPolicy: "Always" }),
            },
          ];
        }
      }
      if (args.some((a) => a.startsWith("jsonpath="))) {
        out(
          podSpec.containers
            .filter((item) => item.name === component)
            .map((item) => item.image)
            .join(" "),
        );
      } else {
        out({
          metadata: {
            name: "openclaw-enterprise-" + component,
            uid: state.deploymentIdentities?.[component]?.uid ?? component + "-deployment-uid",
            resourceVersion: state.deploymentIdentities?.[component]?.resourceVersion ?? "1",
            generation: 1,
            labels: {
              "app.kubernetes.io/instance": state.release,
              "app.kubernetes.io/component": component,
            },
          },
          spec: {
            replicas: state[component],
            template: {
              metadata: { annotations: { "openclaw.dev/installation-checksum": state.checksum } },
              spec: podSpec,
            },
          },
          status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
        });
      }
    } else if (args.includes("get") && args.includes("jobs")) {
      out({ items: state.initJobActive ? [{ status: { active: 0, conditions: [] } }] : [] });
    } else if (args.includes("get") && args.includes("replicasets")) {
      const selector = fileArg("--selector");
      const component = selector.endsWith("component=worker") ? "worker" : "api";
      out({
        items: [
          {
            metadata: {
              name: component + "-rs",
              uid: component + "-rs-uid",
              ownerReferences: [
                {
                  kind: "Deployment",
                  name: "openclaw-enterprise-" + component,
                  uid: component + "-deployment-uid",
                  controller: true,
                },
              ],
            },
          },
        ],
      });
    } else if (args.includes("get") && args.includes("pods")) {
      const initialization = args.some((a) => a.includes("component=initialization"));
      const revision = args.some((a) => a === `openclaw.dev/revision=${state.activeRevision}`);
      const pairComponent = args.some((a) => a.includes("app.kubernetes.io/component=worker"))
        ? "worker"
        : args.some((a) => a.includes("app.kubernetes.io/component=api"))
          ? "api"
          : null;
      if (pairComponent && state.installationSuccessor && !state.simulatePair) {
        const values = await yamlFile(join(root, "live-values"));
        out({
          items: state[pairComponent]
            ? [
                {
                  metadata: { name: `${pairComponent}-pod`, uid: `${pairComponent}-pod-uid` },
                  spec: {
                    containers: [
                      {
                        name: pairComponent,
                        image: state.controller,
                        env: [
                          {
                            name: "OCC_CONFIG_PATH",
                            value: "/etc/openclaw/installation/installation.yaml",
                          },
                        ],
                        volumeMounts: [
                          {
                            name: "installation-startup",
                            mountPath:
                              state.installationPodMountPath ?? "/etc/openclaw/installation",
                            readOnly: true,
                          },
                        ],
                      },
                    ],
                    volumes: [
                      {
                        name: "installation-startup",
                        secret: {
                          secretName:
                            state.installationPodSecretName ?? values.installation.secretName,
                          items: [{ key: values.installation.key, path: "installation.yaml" }],
                        },
                      },
                    ],
                  },
                  status: {
                    phase: "Running",
                    conditions: [{ type: "Ready", status: "True" }],
                  },
                },
              ]
            : [],
        });
      } else if (pairComponent && state.simulatePair) {
        const proof = JSON.parse(readFileSync(join(root, "evidence", "pair-proof.json"), "utf8"));
        const status = (name, image) => ({
          name,
          imageID: "containerd://" + image.rootDigest,
          containerID: "containerd://" + name,
          restartCount: 0,
          ready: true,
          state: { running: {} },
        });
        const worker = { name: pairComponent, image: proof.controller.image };
        const restartable = pairComponent === "worker" && state.workerPlacement === "restartable";
        const podSpec = { nodeName: "node-a", containers: restartable ? [] : [worker] };
        const podStatus = {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
          containerStatuses: restartable ? [] : [status(pairComponent, proof.controller)],
        };
        if (restartable) {
          podSpec.initContainers = [{ ...worker, restartPolicy: "Always" }];
          podStatus.initContainerStatuses = [status("worker", proof.controller)];
        }
        if (pairComponent === "worker") {
          podSpec.containers.push({ name: "repository-credentials", image: proof.broker.image });
          const brokerStatus = status("repository-credentials", proof.broker);
          if (existsSync(join(root, "wrong-broker-identity"))) {
            brokerStatus.imageID = "containerd://sha256:" + "0".repeat(64);
          }
          podStatus.containerStatuses.push(brokerStatus);
        }
        out({
          items: [
            {
              metadata: {
                name: pairComponent + "-pod",
                uid: pairComponent + "-pod-uid",
                ownerReferences: [
                  {
                    kind: "ReplicaSet",
                    name: pairComponent + "-rs",
                    uid: pairComponent + "-rs-uid",
                    controller: true,
                  },
                ],
              },
              spec: podSpec,
              status: podStatus,
            },
          ],
        });
      } else {
        out({
          items:
            initialization && state.initActive
              ? [{ status: { phase: "Running" } }]
              : revision
                ? (state.revisionPods ?? [state.gatewayReady ?? gatewayPod()])
                : [],
        });
      }
    } else if (args.includes("get")) {
      out({ items: [] });
    } else if (args.includes("exec") && args.includes("/sys/fs/cgroup/memory.max")) {
      // The gateway container's cgroup v2 files: a 3 GiB limit, with free memory taken
      // from the case's script (ample by default) and 100 MiB of reclaimable file cache.
      // "unlimited" is a container without a limit (memory.max reads "max"); "transient"
      // is a dropped kubelet connection, and "missing" a container without the files.
      // "slow:N" answers N after 8.5 s, past an 8 s upgrade timeout.
      let free = state.gatewayFree?.shift() ?? 2048;
      save();
      log(`gateway-memory ${free}`);
      if (String(free).startsWith("slow:")) {
        free = Number(free.slice("slow:".length));
        await new Promise((resolve) => setTimeout(resolve, 8500));
      }
      if (free === "transient") {
        return fail(
          1,
          "error: unable to upgrade connection: error dialing backend: dial tcp 10.0.0.5:10250: i/o timeout",
        );
      }
      if (free === "missing") {
        return fail(
          1,
          "cat: /sys/fs/cgroup/memory.max: No such file or directory\ncommand terminated with exit code 1",
        );
      }
      const limit = 3 * 1024 ** 3;
      const cache = 100 * 1024 ** 2;
      const used = free === "unlimited" ? 1024 ** 3 : limit - free * 1024 ** 2 + cache;
      out(`${free === "unlimited" ? "max" : limit}\n${used}\nanon 1\ninactive_file ${cache}\n`);
    } else if (args.includes("exec") && args.includes("doctor")) {
      log(`doctor ${args.slice(args.indexOf("--") + 1).join(" ")}`);
      // Kubernetes evicts, replaces or restarts the gateway while Doctor runs, as node memory
      // pressure did on a production-shaped cluster (finding 2736). Doctor then passes, or
      // fails as a fault below says.
      if (state.afterDoctor) {
        Object.assign(state, state.afterDoctor);
        delete state.afterDoctor;
        save();
      }
      // The kubelet ended the gateway Pod while Doctor ran (an eviction): the exec stream
      // ends with the kill, and the container did not restart.
      if (take("doctor-evicted")) {
        return fail(137, "command terminated with exit code 137");
      }
      if (take("doctor-error")) {
        return fail(1, "command terminated with exit code 1");
      }
      // The container reached its memory limit while Doctor ran: Kubernetes killed both.
      // "doctor-killed" is another kill of both, such as a failed liveness probe.
      for (const [fault, reason] of [
        ["doctor-oom", "OOMKilled"],
        ["doctor-killed", "Error"],
      ]) {
        if (take(fault)) {
          state.gatewayRestarts = (state.gatewayRestarts ?? 0) + 1;
          state.gatewayLastReason = reason;
          save();
          return fail(137, "command terminated with exit code 137");
        }
      }
      // A slow Doctor: it reports whether the upgrade still held its evidence lock when it
      // ended, then fails with an error that quotes an earlier exit code 137.
      if (take("doctor-hold")) {
        await new Promise((resolve) => setTimeout(resolve, state.doctorHoldMs));
        const lock = existsSync(join(root, "evidence", ".upgrade-lock")) ? "held" : "released";
        log(`doctor-ended lock ${lock}`);
        return fail(
          1,
          "doctor found an error: gateway log: command terminated with exit code 137\ncommand terminated with exit code 1",
        );
      }
      // Doctor reached its own heap cap: V8 aborts it and the gateway keeps running.
      if (take("doctor-heap")) {
        return fail(
          134,
          "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\ncommand terminated with exit code 134",
        );
      }
      // Doctor runs for doctorSpanMs and logs its end, to show whether Doctors overlap.
      if (state.doctorSpanMs) {
        await new Promise((resolve) => setTimeout(resolve, state.doctorSpanMs));
        log("doctor-end");
      }
      out("{}");
    } else if (args.includes("exec")) {
      if (args.includes("worker") && state.simulatePair && take("fail-capability")) {
        return fail(9);
      }
      if (state.simulatePair) {
        const reply = state.capabilityReplies.shift() ?? readyCapability;
        const result = await runDeployedCapability(args, cwd, reply);
        state.capabilityProbes.push({ dispatches: state.dispatches, requests: result.requests });
        save();
        out(result.stdout);
        io.stderr(result.stderr);
        return io.exit(result.status);
      }
      out("{}");
    }
  } else if (tool === "occ") {
    if (
      state.continuity &&
      args.includes("agent") &&
      (args.includes("get") || args.includes("runtime"))
    ) {
      const selected = state.version > 1 ? state.continuity.after : state.continuity.before;
      const operation = args.includes("runtime") ? "runtime" : "agent";
      const expected = state.continuity.before.agent;
      const verb = operation === "runtime" ? "runtime" : "get";
      if (
        fileArg("--namespace") !== expected.namespaceId ||
        args[args.indexOf(verb) + 1] !== expected.id ||
        (operation === "runtime" && fileArg("--revision") !== expected.activeRevisionId)
      ) {
        return fail(1, "exact Agent and explicit original revision required");
      }
      log("continuity-" + operation);
      if (selected[operation + "Error"]) {
        return fail(1, selected[operation + "Error"]);
      }
      if (operation === "runtime" && state.version > 1 && selected.changeRevisionAfterRuntime) {
        selected.agent.activeRevisionId = selected.changeRevisionAfterRuntime;
        delete selected.changeRevisionAfterRuntime;
        save();
      }
      if (operation === "runtime" && state.version > 1 && selected.changeHelmRevisionAfterRuntime) {
        // An independent release finishes while runtime status is being read.
        state.version += 1;
        delete selected.changeHelmRevisionAfterRuntime;
        save();
      }
      out(selected[operation]);
    } else if (args.includes("deployment-inventory")) {
      out({
        installationId: "ins_test",
        namespaces: state.inventoryNamespaces ?? [
          {
            id: "ns_test",
            status: "ready",
            agents: state.agent
              ? [
                  {
                    id: "agt_test",
                    status: "active",
                    desiredRuntimeState: "running",
                    executionMode: "embedded",
                    activeRevisionId: "rev_old",
                    deploymentInProgress: false,
                  },
                ]
              : [],
          },
        ],
      });
    } else if (
      state.names &&
      args.includes("get") &&
      (args.includes("agent") || args.includes("namespace"))
    ) {
      // Reads a scripted resource name; an unlisted ID stands for a denied read, and so does an
      // Agent read outside its own Namespace. Like a CLI that can take input, it drains stdin.
      await io.readInput();
      log("read " + args.at(-1));
      const home = (state.inventoryNamespaces ?? []).find((ns) =>
        ns.agents.some((a) => a.id === args.at(-1)),
      );
      const name =
        args.includes("agent") &&
        (!args.includes("--namespace") || fileArg("--namespace") !== home?.id)
          ? undefined
          : state.names[args.at(-1)];
      if (name === undefined) {
        return fail(1, "permission denied");
      }
      out({
        id: args.at(-1),
        name,
        ...(args.includes("agent")
          ? {
              configurationId: `cfg_${args.at(-1)}`,
              activeRevisionId: state.activeRevision ?? "rev_old",
            }
          : {}),
      });
    } else if (args.includes("configuration") && args.includes("get")) {
      // The Agent's saved Configuration (its draft), as OCC returns it.
      const id = args.at(-1);
      out({ id, kind: "agent", values: state.configurationValues?.[id] ?? {} });
    } else if (args.includes("deploy")) {
      state.dispatches += 1;
      // A scripted failure for this Agent answers like the real occ: exit 1 and its error
      // on stderr. A refusal (4xx) commits no revision, so the selected revision stays.
      const agentId = args[args.indexOf("deploy") + 1];
      const failure = state.deployFailures?.[agentId];
      if (failure) {
        delete state.deployFailures[agentId];
        save();
        log(`agent-deploy-failed ${agentId}`);
        return fail(1, failure);
      }
      const { id, status } = state.nextDeployment ?? { id: "rev_new", status: "succeeded" };
      delete state.nextDeployment;
      if (status === "succeeded") {
        state.activeRevision = id;
      }
      const deployment = [fileArg("--namespace"), agentId, id].join("/");
      state.deployments[deployment] = status;
      save();
      log(`agent-deploy ${agentId}`);
      await afterDeploy?.();
      if (take("lost-agent-response")) {
        return fail(9);
      }
      out({ id });
    } else if (args.includes("agent") && args.includes("get")) {
      out({
        id: "agt_test",
        name: "Mail triage",
        configurationId: "cfg_agt_test",
        activeRevisionId: state.activeRevision ?? "rev_old",
      });
    } else if (args.includes("deployment-status")) {
      const namespaceId = fileArg("--namespace");
      const agentId = args.at(-2);
      const deploymentId = args.at(-1);
      const status = state.deployments[[namespaceId, agentId, deploymentId].join("/")];
      if (!status) {
        return fail(1, "deployment not found");
      }
      const response = state.deploymentStatusResponses?.[deploymentId];
      if (response) {
        out(response.stdout);
        return io.exit(response.exitCode ?? 0);
      }
      out({ namespaceId, agentId, deploymentId, status });
      if (take("fail-deployment-status-after-output")) {
        return fail(9);
      }
    } else {
      out({ id: "ins_test", name: state.installationName });
    }
  }
  io.exit(0);
}

const shippedCollectorConfig = (key) => readFile(join(repository, "deploy/logging", key));

// The bundled Collector's operator-created config Secret, as created from
// deploy/logging at install time ("current") or by an older revision ("stale").
async function collectorConfigSecret(name, collector) {
  if (collector !== "current" && collector !== "stale") {
    return null;
  }
  const data = {};
  for (const key of ["collector.yaml", "kubernetes.yaml", "exporter.yaml"]) {
    let content = await shippedCollectorConfig(key);
    if (collector === "stale" && key !== "exporter.yaml") {
      content = Buffer.from(
        content
          .toString()
          .replace(
            /^ *- set\(attributes\["event\.name"\], cache\["record"\]\["event"\]\) where attributes\["event\.name"\] == nil.*\n/m,
            "",
          )
          .replace(/^ *- delete_key\(attributes, "container\.image\.tag"\).*\n/m, ""),
      );
      assert.notDeepEqual(content, await shippedCollectorConfig(key));
    }
    data[key] = content.toString("base64");
  }
  return { metadata: { name, uid: "collector-config-uid", resourceVersion: "1" }, data };
}

// A stand-in Kubernetes API for the startup preflight's Compute check. It serves
// only the version, Namespace and SelfSubjectAccessReview requests that check makes,
// over verified HTTPS with a bearer token, from the Namespaces a case seeds. With
// `execution`, a second stand-in serves the two-cluster execution target under the
// kubeconfig context `execution`, granting the rules its `allows` callback admits.
// The real Kubernetes Compute Driver in the preflight Pod decides whether that state
// may start; this is not live cluster or RBAC proof.
async function kubernetesApi(t, directory, namespaces, denied, execution = null) {
  const certificate = join(directory, "kubernetes-api.crt");
  const key = join(directory, "kubernetes-api.key");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=kubernetes",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    certificate,
  ]);
  const tls = { key: await readFile(key), cert: await readFile(certificate) };
  const serve = async ({ namespaces, uid, allows }) => {
    const reads = [];
    const reviews = [];
    const server = createServer(tls, async (request, response) => {
      const url = new URL(request.url, "https://127.0.0.1");
      const reply = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const review =
        request.method === "POST" &&
        url.pathname === "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
      if (
        denied ||
        (request.method !== "GET" && !review) ||
        request.headers.authorization !== "Bearer preflight-token"
      ) {
        reply(403, { kind: "Status", apiVersion: "v1", status: "Failure", code: 403 });
        return;
      }
      if (review) {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const attributes = JSON.parse(body).spec.resourceAttributes;
        // `allows` answers a decision, or a whole review status such as an evaluation error.
        const decision = allows(attributes);
        const status = typeof decision === "object" ? decision : { allowed: decision };
        reviews.push({ ...attributes, allowed: status.allowed });
        reply(201, {
          kind: "SelfSubjectAccessReview",
          apiVersion: "authorization.k8s.io/v1",
          spec: { resourceAttributes: attributes },
          status,
        });
        return;
      }
      reads.push(url.pathname);
      if (url.pathname === "/version") {
        reply(200, { major: "1", minor: "35", gitVersion: "v1.35.0" });
      } else if (url.pathname === "/api/v1/namespaces/kube-system") {
        // Two-cluster preflight tells the clusters apart by this Namespace's UID.
        reply(200, { kind: "Namespace", apiVersion: "v1", metadata: { name: "kube-system", uid } });
      } else if (url.pathname === "/api/v1/namespaces") {
        // Only label-existence selectors, which is what Compute preflight sends.
        const keys = (url.searchParams.get("labelSelector") ?? "").split(",").filter(Boolean);
        const items = namespaces.filter((namespace) =>
          keys.every((label) => label in (namespace.metadata.labels ?? {})),
        );
        reply(200, { kind: "NamespaceList", apiVersion: "v1", metadata: {}, items });
      } else {
        reply(404, { kind: "Status", apiVersion: "v1", status: "Failure", code: 404 });
      }
    });
    return { port: await listen(t, server), reads, reviews };
  };
  const control = await serve({ namespaces, uid: "control-cluster", allows: () => false });
  const target =
    execution === null
      ? null
      : await serve({
          namespaces: execution.namespaces,
          uid: "execution-cluster",
          allows: execution.allows,
        });
  const authority = (await readFile(certificate)).toString("base64");
  const cluster = (name, port) => ({
    name,
    cluster: { server: `https://127.0.0.1:${port}`, "certificate-authority-data": authority },
  });
  const kubeconfig = join(directory, "preflight-kubeconfig.json");
  await writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        cluster("preflight", control.port),
        ...(target === null ? [] : [cluster("execution", target.port)]),
      ],
      users: [{ name: "preflight", user: { token: "preflight-token" } }],
      contexts: [
        { name: "preflight", context: { cluster: "preflight", user: "preflight" } },
        ...(target === null
          ? []
          : [{ name: "execution", context: { cluster: "execution", user: "preflight" } }]),
      ],
      "current-context": "preflight",
    }),
  );
  // The controller image's unprivileged user reads this file through a bind mount.
  await chmod(kubeconfig, 0o644);
  return {
    kubeconfig,
    reads: control.reads,
    executionReads: target?.reads ?? [],
    reviews: target?.reviews ?? [],
  };
}

async function fixture(
  t,
  {
    agent = false,
    release = "oce",
    candidates = false,
    controllerOnly = false,
    continuity = null,
    repositoryCredentials = false,
    simulatePair = false,
    capabilityReplies = [],
    workerPlacement = "container",
    collector = null,
    chart = null,
    preflightResults = null,
    recoveryHooks = false,
    initializationResources,
    preflightPolicy = false,
    preflightFault = null,
    kubernetesNamespaces = [],
    kubernetesDenied = false,
    executionCluster = null,
    installationName = "Production",
    inventoryNamespaces = null,
    names = null,
    configurationValues = null,
    pluginDrivers,
    candidatePluginDrivers,
    olderDraftRules = false,
    unavailableDraftResolver = false,
    afterDeploy,
    environment = {},
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "occ-upgrade-recovery-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const commands = [];
  let upgradeProcess;
  let interrupted = false;
  const server = await startCommandServer({
    forwardedEnv: [],
    handle: ({ command, args, cwd, io }) => {
      commands.push(command);
      if (
        preflightFault?.mode === "interrupt" &&
        !interrupted &&
        command === "kubectl" &&
        args.includes("get") &&
        args.some((arg) => arg.startsWith("job.batch/oce-upgrade-preflight-"))
      ) {
        interrupted = true;
        upgradeProcess.kill("SIGTERM");
      }
      return fakeCommand(directory, { command, args, cwd }, io, afterDeploy);
    },
  });
  t.after(() => server.close());
  // Hooks run in order: stop answering commands before the directory goes.
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Pair cases also answer node, to stand in for the image-pair probe.
  for (const command of ["helm", "kubectl", "occ", ...(simulatePair ? ["node"] : [])]) {
    const { port, clientToken, serverToken } = server;
    await writeFile(
      join(bin, command),
      commandShim({ ...shimTools, port, clientToken, serverToken, command, forwardedEnv: [] }),
      { mode: 0o700 },
    );
  }
  // The script waits "sleep 2" between polls. The fixture answers every poll at once, so
  // it waits 0.25 s instead: each case sees the same reads, in the same order, sooner.
  // Deadline cases script more reads than 0.25 s polls can use before their timeout.
  await writeFile(
    join(bin, "sleep"),
    `#!${shimTools.bash}\n[[ "$*" != 2 ]] || set -- 0.25\nexec ${bashString(shimTools.sleep)} "$@"\n`,
    { mode: 0o700 },
  );
  const collectorSecretName = "occ-demo-collector-config";
  let values = JSON.stringify({
    images: { controller },
    ...(collector
      ? { logging: { collector: { enabled: true, configSecretName: collectorSecretName } } }
      : {}),
    installation: { secretName: "occ-installation-startup", key: "installation.yaml" },
    ...(repositoryCredentials
      ? {
          repositoryCredentials: {
            enabled: true,
            image: `registry.example.invalid/broker@sha256:${"1".repeat(64)}`,
            serviceName: "git",
            hostname: "git.system.svc.cluster.local",
            clusterDomain: "cluster.local",
          },
        }
      : {}),
  });
  let installation = JSON.stringify({
    ...(repositoryCredentials
      ? {
          backend: [
            {
              id: "github-primary",
              type: "github",
              configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
              drivers: { repo: "repository-credentials" },
            },
          ],
          repository: {
            id: "repository-credentials",
            configuration: { sessionDurationSeconds: 86400 },
            nativeSender: {
              controlSocket: "/run/openclaw/repository-control/private/control.sock",
              publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
            },
            preparedGitHub: {
              custodyKeyPath: "/etc/openclaw/prepared-repository/custody.key",
              privateKeyPath: "/etc/openclaw/prepared-repository/private-key.pem",
            },
          },
        }
      : {}),
    drivers: {
      ...(pluginDrivers && { plugin: pluginDrivers }),
      compute: {
        id: "compute-kubernetes",
        configuration: {
          authentication: { mode: "inCluster" },
          images: { agent: oldRuntime, gateway: oldRuntime },
          ...(repositoryCredentials
            ? {
                network: {
                  repositoryCredentials: {
                    namespace: "system",
                    podLabels: { "app.kubernetes.io/component": "worker" },
                    port: 8443,
                  },
                },
              }
            : {}),
        },
      },
    },
  });
  let api = null;
  if (chart) {
    // The release's example values and Installation, rendered by the real chart.
    const example = async (name) =>
      JSON.parse(
        (
          await execute("yq", [
            "-o=json",
            ".",
            join(repository, "deploy/examples/production", name),
          ])
        ).stdout,
      );
    const exampleValues = await example("values.yaml");
    exampleValues.images.controller = controller;
    exampleValues.installation = {
      secretName: "occ-installation-startup",
      key: "installation.yaml",
    };
    const exampleInstallation = await example("installation.yaml");
    exampleInstallation.drivers.compute.configuration.network.gatewayTrustedProxyCidrs = [
      "10.42.0.0/16",
    ];
    // Outside a cluster the preflight Pod has no service account, so Compute
    // reaches the stand-in Kubernetes API through an explicit kubeconfig.
    api = await kubernetesApi(
      t,
      directory,
      kubernetesNamespaces,
      kubernetesDenied,
      executionCluster,
    );
    const compute = exampleInstallation.drivers.compute.configuration;
    // The example's Gateway namespace must follow this fixture's Helm release.
    compute.gatewayRouting.gatewayNamespace = "system";
    exampleValues.gatewayRouting.gatewayName = compute.gatewayRouting.gatewayName;
    compute.authentication = {
      mode: "kubeconfig",
      kubeconfigPath: api.kubeconfig,
      context: "preflight",
    };
    if (executionCluster) {
      // The experimental two-cluster profile: the same kubeconfig selects the
      // execution stand-in, with documentation-range endpoint CIDRs.
      compute.gatewayRouting.hostname = "gateway.example.test";
      exampleValues.gatewayRouting.hostname = compute.gatewayRouting.hostname;
      compute.executionCluster = {
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: api.kubeconfig,
          context: "execution",
        },
        harnessRouting: { ...compute.gatewayRouting, hostname: "harness.example.test" },
        network: {
          dns: compute.network.dns,
          harnessEndpointCidrs: ["192.0.2.2/32"],
          gatewayEndpointCidrs: ["192.0.2.1/32"],
          pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
        },
      };
    }
    // Apply case-specific changes after constructing a consistent release baseline.
    values = JSON.stringify(chart.values ? chart.values(exampleValues) : exampleValues);
    installation = JSON.stringify(chart.installation(exampleInstallation));
  }
  const state = {
    release,
    continuity,
    realChart: Boolean(chart),
    startupCheck: Boolean(chart),
    themeConfigMaps: chart?.configMaps ?? {},
    kubeconfig: api?.kubeconfig ?? null,
    preflightResults,
    recoveryHooks,
    initializationResources,
    preflightPolicy,
    preflightFault,
    installationName,
    inventoryNamespaces,
    names,
    configurationValues,
    olderDraftRules,
    unavailableDraftResolver,
    version: 1,
    helmStatus: "deployed",
    api: 1,
    worker: 1,
    controller,
    agent,
    workerPlacement,
    simulatePair,
    capabilityReplies,
    capabilityProbes: [],
    dispatches: 0,
    deployments: {},
    initActive: false,
    collectorSecretName,
    collectorSecret: await collectorConfigSecret(collectorSecretName, collector),
    secret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "occ-installation-startup",
        uid: "secret-uid",
        resourceVersion: "1",
        annotations: { "openclaw.dev/installation-id": "ins_test", retained: "yes" },
      },
      data: {
        "installation.yaml": Buffer.from(installation).toString("base64"),
        retained: "cHJlc2VydmVk",
      },
    },
  };
  await writeFile(join(directory, "state.json"), JSON.stringify(state));
  await writeFile(join(directory, "live-values"), values);
  await writeFile(join(directory, "events"), "");
  for (const [name, content] of Object.entries({
    kubeconfig: "cluster-config",
    key: "key",
    "values.json": values,
    "installation.json": installation,
  })) {
    await writeFile(join(directory, name), content, { mode: 0o600 });
  }
  if (candidates) {
    const candidateValues = JSON.parse(values);
    candidateValues.api = { channelDirectoryProxyUrl: "http://198.51.100.25:3128" };
    const candidateInstallation = JSON.parse(installation);
    candidateInstallation.drivers.plugin = candidatePluginDrivers ?? [
      ...(candidateInstallation.drivers.plugin ?? []),
      {
        id: "codex-plugin",
        configuration: { catalogSource: "openai-curated" },
      },
    ];
    await writeFile(join(directory, "candidate-values.json"), JSON.stringify(candidateValues), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, "candidate-installation.json"),
      JSON.stringify(candidateInstallation),
      { mode: 0o600 },
    );
  }
  const evidence = join(directory, "evidence");
  const args = [
    "--kubeconfig",
    join(directory, "kubeconfig"),
    "--context",
    "selected",
    "--namespace",
    "system",
    "--release",
    release,
    "--values",
    join(directory, "values.json"),
    "--installation",
    join(directory, "installation.json"),
    ...(controllerOnly ? ["--controller-image", newController] : ["--runtime-image", runtime]),
    ...(simulatePair && !controllerOnly ? ["--controller-image", newController] : []),
    ...(simulatePair ? ["--broker-image", newBroker] : []),
    ...(candidates
      ? [
          "--candidate-values",
          join(directory, "candidate-values.json"),
          "--candidate-installation",
          join(directory, "candidate-installation.json"),
        ]
      : []),
    "--source-revision",
    sourceRevision,
    "--evidence-dir",
    evidence,
    "--occ",
    join(bin, "occ"),
  ];
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OCC_URL: "https://occ.example.invalid",
    OCC_SERVICE_KEY_FILE: join(directory, "key"),
  };
  for (const variable of helmTargetOverrides) {
    delete env[variable];
  }
  return {
    directory,
    evidence,
    commands,
    deploy: (namespaceId, agentId) =>
      execute(
        join(bin, "occ"),
        ["--output", "json", "--namespace", namespaceId, "agent", "deploy", agentId],
        {
          cwd: repository,
          env,
        },
      ),
    kubernetesReads: api?.reads ?? [],
    executionReads: api?.executionReads ?? [],
    accessReviews: api?.reviews ?? [],
    run: (...extra) => {
      const result = execute(script, [...args, ...extra], {
        cwd: repository,
        env: { ...env, ...environment },
      });
      upgradeProcess = result.child;
      return result;
    },
    runWithStderr: (fd) =>
      spawnResult("/bin/bash", ["--", script, ...args], { cwd: repository, env }, fd),
    // Close the read end before launch; subprocess restores the CLI's default SIGPIPE.
    runWithBrokenPipe: () =>
      execute(
        "python3",
        [
          "-c",
          "import os, subprocess, sys; r, w = os.pipe(); os.close(r); p = subprocess.run(sys.argv[1:], stderr=w); sys.exit(p.returncode if p.returncode >= 0 else 128 - p.returncode)",
          script,
          ...args,
        ],
        { cwd: repository, env },
      ),
    state: async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8")),
    events: async () =>
      (await readFile(join(directory, "events"), "utf8")).trim().split("\n").filter(Boolean),
    failNext: (name) => writeFile(join(directory, name), ""),
  };
}

// These are the supported CLI JSON responses. They model only external observations;
// the real upgrade command owns all continuity decisions and recovery writes.
const continuityNamespace = "ns_00000000-0000-4000-8000-000000000001";
const continuityAgent = "agt_00000000-0000-4000-8000-000000000002";
const continuityRevision = "rev_00000000-0000-4000-8000-000000000003";
const continuityFlags = [
  "--verify-agent",
  continuityAgent,
  "--verify-agent-namespace",
  continuityNamespace,
];
function continuityObservation(suffix = "before") {
  const observedAt = "2026-11-07T00:00:00Z";
  const pods = ["agent", "gateway"].map((role) => ({
    role,
    cluster: "control",
    name: `${role}-${suffix}`,
    uid: `${role}-${suffix}-uid`,
    phase: "Running",
    ready: true,
    createdAt: observedAt,
    // Provider-backed workloads need not use the Compute container name.
    containers: [
      {
        name: "runtime",
        state: "running",
        reason: null,
        ready: true,
        restartCount: 0,
        startedAt: observedAt,
        lastTermination: null,
      },
    ],
    events: [],
  }));
  return {
    agent: {
      id: continuityAgent,
      namespaceId: continuityNamespace,
      name: "Continuity check",
      servicePrincipalId: "spn_00000000-0000-4000-8000-000000000004",
      configurationId: "cfg_00000000-0000-4000-8000-000000000005",
      backendId: "backend",
      // The draft was edited to embedded; the running immutable revision is dedicated.
      executionMode: "embedded",
      gatewayManagedMode: true,
      sandboxPolicyEditing: false,
      activeRevisionId: continuityRevision,
      desiredRuntimeState: "running",
      status: "active",
      harnessAuth: null,
      createdAt: observedAt,
    },
    runtime: {
      revisionId: continuityRevision,
      observedAt,
      pods,
      sources: pods.map((pod) => ({
        id: pod.role,
        kind: "container",
        available: true,
        retention: "Available while the Pod is retained.",
        pods: [{ name: pod.name, uid: pod.uid, container: "runtime", restartCount: 0 }],
      })),
      harness: { state: "running" },
    },
  };
}
function continuityFixture() {
  return { before: continuityObservation(), after: continuityObservation("replacement") };
}

// Existing controller-only semantics intentionally remain unchanged unless selected.
test("Agent continuity is opt-in; controller recovery alone can complete after Agent loss", async (t) => {
  const continuity = continuityFixture();
  delete continuity.after.agent.activeRevisionId;
  continuity.after.runtime.pods = [];
  const f = await fixture(t, { controllerOnly: true, continuity });
  await f.run();
  assert.ok(existsSync(join(f.evidence, "completed")));
  assert.equal(
    (await f.events()).some((event) => event.startsWith("continuity-")),
    false,
  );
});

test("Agent continuity accepts replacement Ready Pods for the original immutable topology", async (t) => {
  const continuity = continuityFixture();
  continuity.after.runtime.pods[0].containers.push({
    name: "initialize-workspace",
    state: "terminated",
    reason: "Completed",
    ready: false,
    restartCount: 0,
    startedAt: "2026-11-07T00:00:00Z",
    lastTermination: {
      reason: "Completed",
      exitCode: 0,
      finishedAt: "2026-11-07T00:00:01Z",
    },
  });
  continuity.after.runtime.sources[0].pods.push({
    name: continuity.after.runtime.pods[0].name,
    uid: continuity.after.runtime.pods[0].uid,
    container: "initialize-workspace",
    restartCount: 0,
  });
  const f = await fixture(t, { controllerOnly: true, continuity });
  await f.run(...continuityFlags);
  const before = JSON.parse(await readFile(join(f.evidence, "agent-continuity.json")));
  const after = JSON.parse(await readFile(join(f.evidence, "agent-continuity-after.json")));
  assert.deepEqual(before.roles, ["agent", "gateway"]);
  assert.notEqual(before.runtime.pods[0].uid, after.runtime.pods[0].uid);
  assert.equal(after.revisionId, before.revisionId);
  assert.ok(existsSync(join(f.evidence, "completed")));
  assert.equal((await f.state()).dispatches, 0);
});

test("Agent continuity refuses lost or changed revisions and resumes without repeating Helm", async (t) => {
  for (const revision of [null, "rev_00000000-0000-4000-8000-000000000099"]) {
    await t.test(String(revision), async (t) => {
      const continuity = continuityFixture();
      continuity.after.agent.activeRevisionId = revision;
      const f = await fixture(t, { controllerOnly: true, continuity });
      await assert.rejects(
        f.run(...continuityFlags),
        /continuity failed; completion was not recorded/,
      );
      assert.equal(existsSync(join(f.evidence, "completed")), false);
      const baseline = await readFile(join(f.evidence, "agent-continuity.json"), "utf8");
      const state = await f.state();
      assert.equal(state.helmSubmissions, 1);
      state.continuity.after = continuityObservation("restored");
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await f.run(...continuityFlags, "--resume");
      assert.equal((await f.state()).helmSubmissions, 1);
      assert.equal((await f.state()).dispatches, 0);
      assert.equal(await readFile(join(f.evidence, "agent-continuity.json"), "utf8"), baseline);
      assert.ok(existsSync(join(f.evidence, "completed")));
    });
  }
});

test("Agent continuity checks read permissions before stopping either writer", async (t) => {
  for (const [operation, status] of [
    ["agent", 403],
    ["runtime", 403],
    ["runtime", 501],
  ]) {
    await t.test(`${operation} HTTP ${status}`, async (t) => {
      const continuity = continuityFixture();
      continuity.before[operation + "Error"] =
        `Error: OCC operation failed (HTTP ${status}): UNAVAILABLE: selected read refused`;
      const f = await fixture(t, { controllerOnly: true, continuity });
      await assert.rejects(
        f.run(...continuityFlags),
        /continuity check failed before writer shutdown/,
      );
      const state = await f.state();
      assert.equal(state.api, 1);
      assert.equal(state.worker, 1);
      assert.equal(state.helmSubmissions, undefined);
      assert.equal(existsSync(join(f.evidence, "prepared")), false);
      assert.equal((await f.events()).includes("migration"), false);
    });
  }
});

test("Agent continuity requires every revision role despite an edited draft", async (t) => {
  const continuity = continuityFixture();
  continuity.after.runtime.pods = continuity.after.runtime.pods.filter(
    (pod) => pod.role === "gateway",
  );
  Object.assign(
    continuity.after.runtime.sources.find((source) => source.id === "agent"),
    {
      available: false,
      unavailableCode: "NO_POD",
      pods: [],
    },
  );
  const f = await fixture(t, { controllerOnly: true, continuity });
  await assert.rejects(
    f.run(...continuityFlags, "--timeout-seconds", "5"),
    /continuity failed; completion was not recorded\..*Timed out/,
  );
  const observed = JSON.parse(await readFile(join(f.evidence, "agent-continuity-after.json")));
  assert.deepEqual(observed.roles, ["agent", "gateway"]);
  assert.deepEqual(
    observed.runtime.pods.map((pod) => pod.role),
    ["gateway"],
  );
  assert.equal(existsSync(join(f.evidence, "completed")), false);
  const state = await f.state();
  state.continuity.after = continuityObservation("restored");
  // Retained terminal Pods do not prevent healthy replacement Pods from passing.
  state.continuity.after.runtime.pods.push({
    ...continuityObservation().runtime.pods[0],
    phase: "Failed",
    ready: false,
  });
  state.continuity.after.runtime.sources[0].pods.push(
    ...continuityObservation().runtime.sources[0].pods,
  );
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await f.run(...continuityFlags, "--resume");
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.ok(existsSync(join(f.evidence, "completed")));
});

test("Agent continuity refuses truncated Pod observations and lost provider Harness status", async (t) => {
  for (const scenario of ["truncated", "missing-harness", "lost-harness", "duplicate-pod"]) {
    await t.test(scenario, async (t) => {
      const continuity = continuityFixture();
      if (scenario === "truncated") {
        // The endpoint returns at most eight Pods per role; another live Pod may
        // be omitted beyond seven ended Pods and the one visible live Pod.
        const pod = continuity.after.runtime.pods[0];
        for (let index = 0; index < 7; index++) {
          continuity.after.runtime.pods.push({
            ...pod,
            name: `ended-${index}`,
            uid: `ended-${index}`,
            phase: "Failed",
            ready: false,
          });
        }
      } else if (scenario === "missing-harness") {
        delete continuity.after.runtime.harness;
      } else if (scenario === "lost-harness") {
        continuity.after.runtime.harness = { state: "lost", code: "SANDBOX_MISSING" };
      } else {
        continuity.after.runtime.pods.push({
          ...continuity.after.runtime.pods[0],
          name: "duplicate",
          uid: "duplicate",
        });
      }
      for (const source of continuity.after.runtime.sources) {
        source.pods = continuity.after.runtime.pods
          .filter((pod) => pod.role === source.id)
          .map((pod) => ({
            name: pod.name,
            uid: pod.uid,
            container: "runtime",
            restartCount: 0,
          }));
      }
      const f = await fixture(t, { controllerOnly: true, continuity });
      await assert.rejects(
        f.run(...continuityFlags, "--timeout-seconds", "5"),
        /continuity failed; completion was not recorded\..*Timed out/,
      );
      // A refusal counts only after the command retained a full observation of
      // this scenario, not if a slow setup exhausted the deadline beforehand.
      const observed = JSON.parse(await readFile(join(f.evidence, "agent-continuity-after.json")));
      assert.equal(observed.revisionId, continuityRevision);
      if (scenario === "truncated") {
        assert.equal(observed.runtime.pods.filter((pod) => pod.role === "agent").length, 8);
      } else if (scenario === "missing-harness") {
        assert.equal(Object.hasOwn(observed.runtime, "harness"), false);
      } else if (scenario === "lost-harness") {
        assert.equal(observed.runtime.harness.state, "lost");
      } else {
        assert.equal(
          observed.runtime.pods.filter((pod) => pod.role === "agent" && pod.phase === "Running")
            .length,
          2,
        );
      }
      assert.equal(existsSync(join(f.evidence, "completed")), false);
      assert.equal((await f.state()).helmSubmissions, 1);
      assert.equal((await f.state()).dispatches, 0);
    });
  }
});

test("Agent continuity binds original evidence and selection across resume", async (t) => {
  const continuity = continuityFixture();
  continuity.after.runtime.sources = continuity.after.runtime.sources.filter(
    (source) => source.id === "gateway",
  );
  const f = await fixture(t, { controllerOnly: true, continuity });
  await assert.rejects(f.run(...continuityFlags), /revision workload roles changed/);
  await assert.rejects(f.run("--resume"), /resume evidence directory/);
  const baseline = join(f.evidence, "agent-continuity.json");
  await writeFile(baseline, "{}\n");
  await assert.rejects(f.run(...continuityFlags, "--resume"), /prepared upgrade evidence changed/);
  assert.equal((await f.state()).helmSubmissions, 1);
});

test("Agent continuity confirms the active revision after reading runtime status", async (t) => {
  const continuity = continuityFixture();
  const replacement = "rev_00000000-0000-4000-8000-000000000099";
  // The old revision still has Ready Pods when a concurrent deployment switches
  // the active revision. The final Agent read must catch that intervening change.
  continuity.after.changeRevisionAfterRuntime = replacement;
  const f = await fixture(t, { controllerOnly: true, continuity });
  await assert.rejects(
    f.run(...continuityFlags),
    /selected Agent changed during runtime inspection/,
  );
  const confirmed = JSON.parse(
    await readFile(join(f.evidence, "agent-continuity-after.confirm.json")),
  );
  assert.equal(confirmed.activeRevisionId, replacement);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.equal((await f.state()).dispatches, 0);
});

test("Agent continuity finishes before the terminal Helm identity check", async (t) => {
  const continuity = continuityFixture();
  continuity.after.changeHelmRevisionAfterRuntime = true;
  const f = await fixture(t, { controllerOnly: true, continuity });
  await assert.rejects(
    f.run(...continuityFlags),
    /the final Helm release is not this submission's deployed revision/,
  );
  assert.equal(existsSync(join(f.evidence, "completed")), false);
  const state = await f.state();
  assert.equal(state.version, 3);
  assert.equal(state.helmSubmissions, 1);
  assert.equal(state.dispatches, 0);
});

test("Upgrade rejects inherited Helm target overrides before external calls or evidence writes", async (t) => {
  for (const variable of helmTargetOverrides) {
    await t.test(variable, async (t) => {
      const value = "private-target-override";
      const f = await fixture(t, { controllerOnly: true, environment: { [variable]: value } });
      // Helm accepts these independently of --kubeconfig/--kube-context. Refuse
      // before either command protocol or recovery evidence can use another target.
      await assert.rejects(f.run(), (error) => {
        assert.match(error.stderr, new RegExp(`unset ${variable}`));
        assert.match(error.stderr, /selected kubeconfig/);
        assert.equal(error.stderr.includes(value), false);
        return true;
      });
      assert.equal(f.commands.length, 0);
      assert.equal(existsSync(f.evidence), false);
    });
  }
});

test("Resume refuses inherited Helm target changes without altering accepted upgrade evidence", async (t) => {
  const environment = {};
  const f = await fixture(t, { controllerOnly: true, environment });
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const parameters = await readFile(join(f.evidence, "parameters.json"), "utf8");
  const submission = await readFile(join(f.evidence, "helm-started"), "utf8");
  const commands = f.commands.length;
  const events = await f.events();
  // A changed shell environment must not redirect reconciliation of an accepted
  // submission, even when the recorded kubeconfig and all arguments still match.
  for (const variable of helmTargetOverrides) {
    environment[variable] = "private-target-override";
    await assert.rejects(f.run("--resume"), new RegExp(`unset ${variable}`));
    delete environment[variable];
    assert.equal(f.commands.length, commands);
    assert.deepEqual(await f.events(), events);
    assert.equal(await readFile(join(f.evidence, "parameters.json"), "utf8"), parameters);
    assert.equal(await readFile(join(f.evidence, "helm-started"), "utf8"), submission);
    assert.equal(existsSync(join(f.evidence, ".upgrade-lock")), false);
  }
  await f.run("--resume");
  assert.ok(existsSync(join(f.evidence, "completed")));
  assert.equal((await f.state()).helmSubmissions, 1);
});

test("Agent continuity rejects explicitly empty selection before external calls", async (t) => {
  for (const flags of [
    ["--verify-agent", "", "--verify-agent-namespace", ""],
    ["--verify-agent", ""],
    ["--verify-agent-namespace", ""],
  ]) {
    await t.test(JSON.stringify(flags), async (t) => {
      const f = await fixture(t, { controllerOnly: true });
      await assert.rejects(f.run(...flags), /requires a nonempty value/);
      assert.equal(f.commands.length, 0);
    });
  }
});

test("Agent continuity rejects incomplete selection and intentional runtime replacement", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("--verify-agent", continuityAgent), /must be supplied together/);
  await assert.rejects(f.run(...continuityFlags), /cannot be combined with --runtime-image/);
  assert.equal(f.commands.length, 0);
});

// Match the native runner's run summary, including another file from a full lane.
// These receipts test the consumer; they do not claim PostgreSQL execution.
function controllerCompatibilityResults() {
  const path = "tests/integration/postgres-migration-compatibility.test.mjs";
  const counts = { passed: 2, failed: 0, skipped: 0, todo: 0, total: 2 };
  return {
    version: 1,
    command: "run",
    sourceSha: "1".repeat(40),
    lane: "postgres",
    scope: "full",
    status: "passed",
    exitCode: 0,
    counts: { ...counts, passed: 3, total: 3 },
    issues: [],
    files: [
      {
        path,
        status: "passed",
        nodeExitCode: 0,
        signal: null,
        counts,
        tests: [
          {
            name: "Logical restore preserves reviewed canonical and Provider migration histories",
            status: "passed",
            file: path,
          },
          {
            name: "Released controller remains usable across candidate database writes",
            status: "passed",
            file: path,
          },
        ],
        issues: [],
        cleanup: { status: "passed" },
        imageDigests: {
          releasedController: controller.split("@")[1],
          candidateController: newController.split("@")[1],
        },
      },
      {
        path: "tests/integration/postgres-migration-version.test.ts",
        status: "passed",
        nodeExitCode: 0,
        signal: null,
        counts: { ...counts, passed: 1, total: 1 },
        tests: [
          {
            name: "Migration refuses PostgreSQL 16 before first installation or upgrade without exposing credentials",
            status: "passed",
            file: "tests/integration/postgres-migration-version.test.ts",
          },
        ],
        issues: [],
        cleanup: { status: "passed" },
      },
    ],
  };
}

test("controller compatibility preserves Agent continuity through interrupted upgrade recovery", async (t) => {
  const f = await fixture(t, { controllerOnly: true, continuity: continuityFixture() });
  const path = join(f.directory, "compatibility.json");
  const contents = JSON.stringify(controllerCompatibilityResults());
  await writeFile(path, contents);
  const flags = ["--controller-compatibility-results", path, ...continuityFlags];
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(...flags), injectedFault);
  const frozen = join(f.evidence, "controller-compatibility-results.json");
  await assertPrivateReceipt(frozen, contents);
  const continuityBefore = await readFile(join(f.evidence, "agent-continuity.json"), "utf8");
  const before = await f.events();

  // Neither a replacement nor deletion of prepared evidence can change the
  // compatibility decision after a committed Helm submission.
  await writeFile(frozen, "{}");
  await assert.rejects(f.run(...flags, "--resume"), /prepared upgrade evidence changed/);
  await rm(frozen);
  await assert.rejects(f.run(...flags, "--resume"), /prepared upgrade evidence changed/);
  assert.deepEqual(await f.events(), before);
  await writeFile(frozen, contents, { mode: 0o600 });

  // The original external file is no longer an input: only its frozen copy is.
  await rm(path);
  await f.run(...flags, "--resume");
  await assertPrivateReceipt(frozen, contents);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  assert.equal(await readFile(join(f.evidence, "agent-continuity.json"), "utf8"), continuityBefore);
  const continuityAfter = JSON.parse(
    await readFile(join(f.evidence, "agent-continuity-after.json")),
  );
  assert.equal(continuityAfter.revisionId, continuityRevision);
  assert.ok(existsSync(join(f.evidence, "completed")));
  assert.equal((await f.state()).dispatches, 0);
  assert.equal((await f.state()).api, 1);
  assert.equal((await f.state()).worker, 1);
});

test("controller compatibility rejects unqualified evidence before changing writers", async (t) => {
  const changes = {
    "unselected green": (r) => (r.files[0].tests[1].name = "Another migration case"),
    "failed selected case": (r) => (r.files[0].tests[1].status = "failed"),
    "skipped selected case": (r) => (r.files[0].tests[1].status = "skipped"),
    "duplicate selected case": (r) => (r.files[0].tests[0].name = r.files[0].tests[1].name),
    "wrong test file": (r) => (r.files[0].tests[1].file = r.files[1].path),
    "duplicate matching file": (r) => (r.files[1].path = r.files[0].path),
    "failed cleanup": (r) => (r.files[0].cleanup.status = "failed"),
    "missing cleanup": (r) => (r.files[0].cleanup = null),
    "skipped file case": (r) => (r.files[0].counts.skipped = 1),
    "failed runner": (r) => (r.status = "failed"),
    "aggregate summary": (r) => (r.command = "aggregate"),
    "missing runner provenance": (r) => (r.sourceSha = null),
    "reversed image roles": (r) => {
      const images = r.files[0].imageDigests;
      [images.releasedController, images.candidateController] = [
        images.candidateController,
        images.releasedController,
      ];
    },
    "different platform or config digest": (r) =>
      (r.files[0].imageDigests.candidateController = `sha256:${"d".repeat(64)}`),
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest, { controllerOnly: true });
      const receipt = controllerCompatibilityResults();
      change(receipt);
      const path = join(f.directory, "compatibility.json");
      await writeFile(path, JSON.stringify(receipt));
      await assert.rejects(
        f.run("--controller-compatibility-results", path),
        /controller compatibility receipt must pass/,
      );
      assert.deepEqual(await f.events(), []);
      assert.equal((await f.state()).api, 1);
      assert.equal((await f.state()).worker, 1);
      assert.equal(existsSync(join(f.evidence, "prepared")), false);
    });
  }
});

test("controller compatibility rejects contradictory runner summaries", async (t) => {
  const changes = {
    "failed unrelated test row": (r) => (r.files[0].tests[0].status = "failed"),
    "failed sibling file": (r) => (r.files[1].status = "failed"),
    "wrong total count": (r) => r.counts.total++,
    "multiple files in focused run": (r) => (r.scope = "focused"),
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest, { controllerOnly: true });
      const receipt = controllerCompatibilityResults();
      change(receipt);
      const path = join(f.directory, "compatibility.json");
      await writeFile(path, JSON.stringify(receipt));
      await assert.rejects(
        f.run("--controller-compatibility-results", path),
        /controller compatibility receipt must pass/,
      );
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("controller compatibility rejects passing summaries with explicit failure evidence", async (t) => {
  const changes = {
    // The native producer recognizes marker presence, including false and empty
    // values. A row carrying either marker cannot be a passed test.
    "skip marker": (r) => (r.files[0].tests[1].skip = false),
    "todo marker": (r) => (r.files[0].tests[1].todo = ""),
    "root file failure": (r) => (r.files[1].fileFailure = { error: { message: "test failed" } }),
    "empty sibling file": (r) => {
      r.files[1].tests = [];
      r.files[1].counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
      r.counts = { ...r.files[0].counts };
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest, { controllerOnly: true });
      const receipt = controllerCompatibilityResults();
      change(receipt);
      const path = join(f.directory, "compatibility.json");
      await writeFile(path, JSON.stringify(receipt));
      await assert.rejects(
        f.run("--controller-compatibility-results", path),
        /controller compatibility receipt must pass/,
      );
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("controller compatibility requires a value and an explicit controller selection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run("--controller-compatibility-results", ""),
    /requires a nonempty value/,
  );
  await assert.rejects(
    f.run("--controller-compatibility-results", join(f.directory, "unused.json")),
    /requires --controller-image/,
  );
  assert.deepEqual(await f.events(), []);
});

for (const preflightOnly of [true, false]) {
  test(`mutable Installation update denial on fresh ${preflightOnly ? "preflight" : "apply"}`, async (t) => {
    const f = await fixture(t);
    const state = await f.state();
    state.denyInstallationUpdate = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const installation = join(f.directory, "installation.json");
    const before = await readFile(installation);
    await assert.rejects(f.run(...(preflightOnly ? ["--preflight-only"] : [])), (error) => {
      assert.match(
        error.stderr,
        /Kubernetes denied update on Installation Secret system\/occ-installation-startup/,
      );
      assert.doesNotMatch(error.stderr, /private self-review reason/);
      return true;
    });
    assert.deepEqual(await f.events(), []);
    const after = await f.state();
    assert.equal(after.installationUpdateReviews, 1);
    assert.equal(after.api, 1);
    assert.equal(after.worker, 1);
    assert.deepEqual(after.secret, state.secret);
    assert.deepEqual(await readFile(installation), before);
  });
}

test("unavailable mutable Installation update review warns and permits the actual update", async (t) => {
  const f = await fixture(t);
  const state = await f.state();
  state.reviewUnavailable = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  const result = await f.run();
  assert.match(result.stderr, /Could not verify update access to the Installation Secret/);
  assert.doesNotMatch(result.stderr, /private self-review diagnostic/);
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "secret-replaced", "migration"]);
});

for (const preflightOnly of [false, true]) {
  test(`immutable Installation Secret refuses changed data before ${preflightOnly ? "preflight-only succeeds" : "stopping writers"}`, async (t) => {
    const f = await fixture(t);
    const state = await f.state();
    state.secret.immutable = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(
      f.run(...(preflightOnly ? ["--preflight-only"] : [])),
      /Installation Secret .* is immutable/,
    );
    assert.deepEqual(await f.events(), []);
    const after = await f.state();
    assert.equal(after.api, 1);
    assert.equal(after.worker, 1);
    assert.equal(after.helmSubmissions ?? 0, 0);
  });
}

test("immutable Installation Secret permits an upgrade with equivalent YAML", async (t) => {
  const f = await fixture(t, { controllerOnly: true });
  const state = await f.state();
  state.secret.immutable = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  const installation = join(f.directory, "installation.json");
  appendFileSync(installation, "\n");
  await f.run();
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
  assert.deepEqual((await f.state()).secret, state.secret);
  assert.equal((await f.state()).installationUpdateReviews ?? 0, 0);
});

test("resume refuses a pending Installation write if the Secret became immutable", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run(), injectedFault);
  const events = await f.events();
  assert.deepEqual(events, ["scale-api"]);
  const state = await f.state();
  state.secret.immutable = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run("--resume"), /Installation Secret .* is immutable/);
  assert.deepEqual(await f.events(), events);
  assert.equal((await f.state()).helmSubmissions ?? 0, 0);
  assert.equal((await f.state()).installationUpdateReviews, 1);
});

async function immutableInstallationSwitch(t, options = {}) {
  const f = await fixture(t, {
    preflightPolicy: true,
    recoveryHooks: true,
    ...options,
  });
  const state = await f.state();
  state.secret.immutable = true;
  state.secret.type = "Opaque";
  state.secret.metadata.namespace = "system";
  const installation = JSON.parse(
    Buffer.from(state.secret.data["installation.yaml"], "base64").toString(),
  );
  installation.drivers.compute.configuration.images = { agent: runtime, gateway: runtime };
  // The operator stages equivalent configuration with independent formatting.
  // The mounted bytes, rather than a reserialization, must determine the checksum.
  const staged =
    "# Operator-staged configuration\n" +
    JSON.stringify(Object.fromEntries(Object.entries(installation).reverse()), null, 4) +
    "\n\n";
  state.installationSuccessor = structuredClone(state.secret);
  state.installationSuccessor.metadata.name = "occ-installation-successor";
  state.installationSuccessor.metadata.uid = "successor-secret-uid";
  state.installationSuccessor.data["installation.yaml"] = Buffer.from(staged).toString("base64");
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  const values = await yamlFile(join(f.directory, "values.json"));
  values.installation.secretName = state.installationSuccessor.metadata.name;
  const candidate = join(f.directory, "immutable-values.json");
  await writeFile(candidate, JSON.stringify(values), { mode: 0o600 });
  return {
    ...f,
    original: state.secret,
    successor: state.installationSuccessor,
    staged,
    run: (...args) => f.run("--candidate-values", candidate, ...args),
  };
}

async function assertImmutableInstallationRetained(f) {
  const state = await f.state();
  assert.equal(state.installationUpdateReviews ?? 0, 0);
  assert.deepEqual(state.secret, f.original);
  assert.deepEqual(state.installationSuccessor, f.successor);
  assert.ok(!(await f.events()).includes("secret-replaced"));
  const values = await yamlFile(join(f.directory, "live-values"));
  assert.equal(values.installation.secretName, f.successor.metadata.name);
  assert.equal(
    values.controlPlane.installationChecksum,
    createHash("sha256").update(f.staged).digest("hex"),
  );
}

test("immutable Installation reference uses staged bytes in preflight and Helm without replacing either Secret", async (t) => {
  const f = await immutableInstallationSwitch(t);
  await f.run("--preflight-only");
  assert.deepEqual(await f.events(), []);
  const prepared = await f.state();
  const secret = prepared.preflight.requested.find((object) => object.kind === "Secret");
  assert.equal(Buffer.from(secret.data["installation.yaml"], "base64").toString(), f.staged);
  const jobs = prepared.preflight.requested.filter((object) => object.kind === "Job");
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.ok(
      job.spec.template.spec.volumes.some(
        (volume) => volume.secret?.secretName === secret.metadata.name,
      ),
      "both startup checks must mount the temporary Secret containing the successor bytes",
    );
    assert.ok(
      !job.spec.template.spec.volumes.some(
        (volume) => volume.secret?.secretName === f.original.metadata.name,
      ),
    );
  }
  assert.equal(await readFile(join(f.evidence, "candidate-installation.yaml"), "utf8"), f.staged);
  // Preflight-only evidence is deliberately not resumable. A fresh normal
  // attempt proves that Helm receives the same staged bytes and reference.
  const deployment = await immutableInstallationSwitch(t);
  await deployment.run();
  await assertImmutableInstallationRetained(deployment);
  assert.deepEqual(await deployment.events(), ["scale-api", "scale-worker", "migration"]);
  assert.ok(existsSync(join(deployment.evidence, "completed")));
});

test("immutable Installation reference refuses an unavailable or mismatched successor before stopping writers", async (t) => {
  for (const [name, change, refusal] of [
    ["missing", (state) => delete state.installationSuccessor, /not found/],
    [
      "wrong Installation",
      (state) =>
        (state.installationSuccessor.metadata.annotations["openclaw.dev/installation-id"] =
          "ins_other"),
      /staged immutable Installation Secret/,
    ],
    [
      "wrong configuration",
      (state) =>
        (state.installationSuccessor.data["installation.yaml"] =
          state.secret.data["installation.yaml"]),
      /candidate Installation configuration/,
    ],
    [
      "mutable",
      (state) => (state.installationSuccessor.immutable = false),
      /staged immutable Installation Secret/,
    ],
    [
      "lost unrelated data",
      (state) => delete state.installationSuccessor.data.retained,
      /staged immutable Installation Secret/,
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const f = await immutableInstallationSwitch(subtest);
      const state = await f.state();
      change(state);
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(f.run(), refusal);
      assert.deepEqual(await f.events(), []);
      const after = await f.state();
      assert.equal(after.api, 1);
      assert.equal(after.worker, 1);
      assert.equal(after.helmSubmissions ?? 0, 0);
      assert.equal(after.preflight?.created?.length ?? 0, 0);
      assert.deepEqual(after.secret, f.original);
    });
  }
});

test("immutable Installation preflight rechecks both pins after temporary Jobs finish", async (t) => {
  for (const key of ["secret", "installationSuccessor"]) {
    await t.test(key, async (subtest) => {
      const f = await immutableInstallationSwitch(subtest);
      const state = await f.state();
      state.replaceInstallationDuringPreflight = key;
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(f.run("--preflight-only"), (error) => {
        assert.match(error.stderr, /Installation Secret identity or data changed/);
        assert.doesNotMatch(error.stdout, /Preflight passed/);
        return true;
      });
      await assertStoppedBeforeWriters(f);
      const after = await f.state();
      assert.equal(after[key].metadata.uid, state[key].metadata.uid + "-replacement");
      assert.equal(after.preflight.logRequests.length, 2);
      for (const kind of ["jobs", "pods", "secrets", "networkpolicies"]) {
        assert.deepEqual(
          after.preflight[kind],
          {},
          "temporary preflight resources must be cleaned",
        );
      }
    });
  }
});

test("immutable Installation completion verifies mounted consumers and the owned initializer", async (t) => {
  const f = await immutableInstallationSwitch(t, { agent: true });
  const state = await f.state();
  // The volume declaration remains correct, but the controller cannot read it
  // at its configured path. Helm success alone must not authorize Agent dispatch.
  state.installationDeploymentMountPath = "/not-the-config-directory";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run(), /Installation consumer mount differs/);
  const accepted = await f.state();
  delete accepted.installationDeploymentMountPath;
  const mutations = [
    [
      "controller Pod mount",
      (value) => {
        value.installationPodMountPath = "/wrong-directory";
      },
    ],
    [
      "initializer Job mount",
      (value) => {
        value.installationInitializer.job.spec.template.spec.initContainers[0].volumeMounts[0].mountPath =
          "/wrong-directory";
      },
    ],
    [
      "initializer Pod mount",
      (value) => {
        value.installationInitializer.pod.spec.initContainers[0].volumeMounts[0].mountPath =
          "/wrong-directory";
      },
    ],
    [
      "foreign initializer Pod",
      (value) => {
        value.installationInitializer.pod.metadata.ownerReferences[0].uid = "another-job";
      },
    ],
    [
      "unfinished initializer",
      (value) => {
        value.installationInitializer.job.status = { active: 1 };
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const changed = structuredClone(accepted);
      mutate(changed);
      await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
      await assert.rejects(
        f.run("--resume"),
        /Installation consumer mount differs|initializer (Job|Pod)/,
      );
      const refused = await f.state();
      assert.equal(refused.helmSubmissions, 1);
      assert.equal(refused.dispatches, 0);
      assert.equal(existsSync(join(f.evidence, "completed")), false);
    });
  }
  await writeFile(join(f.directory, "state.json"), JSON.stringify(accepted));
  await f.run("--resume");
  const completed = await f.state();
  assert.equal(completed.helmSubmissions, 1);
  assert.equal(completed.dispatches, 1);
  const receipt = JSON.parse(
    await readFile(join(f.evidence, "installation-initializer.json"), "utf8"),
  );
  assert.equal(receipt.jobUid, accepted.installationInitializer.job.metadata.uid);
  assert.equal(receipt.podUid, accepted.installationInitializer.pod.metadata.uid);
  await assertImmutableInstallationRetained(f);
});

test("immutable Installation refuses non-string YAML mapping keys on either side", async (t) => {
  for (const plainSide of ["intended", "staged"]) {
    await t.test(plainSide, async (subtest) => {
      const f = await immutableInstallationSwitch(subtest);
      const state = await f.state();
      const original = loadYaml(
        Buffer.from(state.secret.data["installation.yaml"], "base64").toString(),
      );
      const successor = loadYaml(f.staged);
      for (const config of [original, successor]) {
        config.drivers.compute.configuration.network ??= {};
        config.drivers.compute.configuration.network.dns = {
          namespace: "kube-system",
          podLabels: { "0x10": "resolver" },
        };
      }
      const originalBytes = JSON.stringify(original).replace(
        '"0x10":',
        plainSide === "intended" ? "0x10: " : '"0x10":',
      );
      const stagedBytes = JSON.stringify(successor).replace(
        '"0x10":',
        plainSide === "staged" ? "0x10: " : '"0x10":',
      );
      // Both are valid YAML, but the startup parser sees different DNS selectors.
      assert.notDeepEqual(
        loadYaml(originalBytes).drivers.compute.configuration.network.dns,
        loadYaml(stagedBytes).drivers.compute.configuration.network.dns,
      );
      state.secret.data["installation.yaml"] = Buffer.from(originalBytes).toString("base64");
      state.installationSuccessor.data["installation.yaml"] =
        Buffer.from(stagedBytes).toString("base64");
      await writeFile(join(f.directory, "installation.json"), originalBytes);
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(f.run(), /string mapping keys/);
      const after = await f.state();
      assert.equal(after.api, 1);
      assert.equal(after.worker, 1);
      assert.equal(after.version, 1);
      assert.deepEqual(await f.events(), []);
      assert.equal(after.helmSubmissions ?? 0, 0);
      assert.equal(after.preflight?.created?.length ?? 0, 0);
      assert.deepEqual(after.secret, state.secret);
      assert.deepEqual(after.installationSuccessor, state.installationSuccessor);
    });
  }
});

test("immutable Installation resume rejects same-values Helm manifest or hook substitution", async (t) => {
  for (const field of ["manifest", "hook"]) {
    await t.test(field, async (subtest) => {
      const f = await immutableInstallationSwitch(subtest, { agent: true });
      await f.failNext("lost-helm-response");
      await assert.rejects(f.run(), injectedFault);
      const accepted = await f.state();
      const changed = structuredClone(accepted);
      if (field === "manifest") {
        const documents = yamlDocuments(changed.installationRelease.manifest).map(loadYaml);
        documents.find(
          (object) => object.kind === "Deployment",
        ).spec.template.spec.containers[0].image = oldRuntime;
        changed.installationRelease.manifest = documents
          .map((object) => JSON.stringify(object))
          .join("\n---\n");
      } else {
        const hook = JSON.parse(changed.installationRelease.hooks[0].manifest);
        hook.spec.template.spec.initContainers[0].volumeMounts[0].mountPath = "/another-config";
        changed.installationRelease.hooks[0].manifest = JSON.stringify(hook);
      }
      await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
      await assert.rejects(f.run("--resume"), /Helm.*(manifest|hook set).*differ/);
      const refused = await f.state();
      assert.equal(refused.helmSubmissions, 1);
      assert.equal(refused.dispatches, 0);
      assert.equal(existsSync(join(f.evidence, "completed")), false);
      await writeFile(join(f.directory, "state.json"), JSON.stringify(accepted));
      await f.run("--resume");
      assert.equal((await f.state()).helmSubmissions, 1);
      assert.equal((await f.state()).dispatches, 1);
      await assertImmutableInstallationRetained(f);
    });
  }
});

test("immutable Installation reference rechecks both captured UIDs before resumed quiescence", async (t) => {
  const f = await immutableInstallationSwitch(t);
  // Interrupt a prepared attempt before the first write, then change each
  // retained object's identity independently before resuming that attempt.
  await f.failNext("fail-scale-api");
  await assert.rejects(f.run(), injectedFault);
  const prepared = await f.state();
  for (const key of ["secret", "installationSuccessor"]) {
    const changed = structuredClone(prepared);
    changed[key].metadata.uid += "-replacement";
    await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
    await assert.rejects(f.run("--resume"), /Installation Secret|immutable Installation/);
    assert.deepEqual(await f.events(), []);
    assert.equal((await f.state()).api, 1);
    assert.equal((await f.state()).worker, 1);
    assert.equal((await f.state()).helmSubmissions ?? 0, 0);
  }
  await writeFile(join(f.directory, "state.json"), JSON.stringify(prepared));
  await f.run("--resume");
  await assertImmutableInstallationRetained(f);
});

test("immutable Installation reference resumes partial quiescence and accepted submission without duplicate dispatch", async (t) => {
  const f = await immutableInstallationSwitch(t, { agent: true });
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run(), injectedFault);
  assert.deepEqual(await f.events(), ["scale-api"]);
  assert.equal((await f.state()).worker, 1);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run("--resume"), injectedFault);
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.equal((await f.state()).dispatches, 0);
  // A Ready Pod still mounting the predecessor is not adoption of the staged
  // reference, even if Helm accepted the values and its rollout command passed.
  const stale = await f.state();
  stale.installationPodSecretName = f.original.metadata.name;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(stale));
  await assert.rejects(f.run("--resume"), /Installation.*volume differs/);
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.equal((await f.state()).dispatches, 0);
  delete stale.installationPodSecretName;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(stale));
  await f.run("--resume");
  await assertImmutableInstallationRetained(f);
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.equal((await f.state()).dispatches, 1);
  const completed = await f.events();
  await assert.rejects(f.run("--resume"), /completion marker exists/);
  assert.deepEqual(await f.events(), completed);
});

test("immutable Installation reference survives same-candidate Helm recovery and acknowledged resume", async (t) => {
  const f = await immutableInstallationSwitch(t, { recoveryHooks: true });
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  await completedHookInPendingRelease(f);
  await f.failNext("fail-rollout-api");
  await assert.rejects(f.run(...recoverHelm), injectedFault);
  assert.equal((await f.state()).version, 3);
  assert.equal((await f.state()).rollbackSubmissions, 1);
  await f.run("--resume");
  await assertImmutableInstallationRetained(f);
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.equal((await f.state()).rollbackSubmissions, 1);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  assert.ok(existsSync(join(f.evidence, "completed")));
});

test("an image upgrade can select curated Codex while preserving both plugin registrations", async (t) => {
  const pluginDrivers = [
    { id: "occ-plugin", configuration: {} },
    {
      id: "codex-plugin",
      configuration: {
        catalogSource: "hosted",
        codexExecutable: "/usr/bin/codex",
        codexHome: "/var/lib/codex",
      },
    },
  ];
  const candidatePluginDrivers = structuredClone(pluginDrivers);
  candidatePluginDrivers[1].configuration.catalogSource = "openai-curated";
  const f = await fixture(t, { candidates: true, pluginDrivers, candidatePluginDrivers });
  await f.run();
  const state = await f.state();
  const installed = loadYaml(
    Buffer.from(state.secret.data["installation.yaml"], "base64").toString(),
  );
  assert.deepEqual(installed.drivers.plugin, candidatePluginDrivers);
});
// Existing installations can retain the former single-registration shape. Only
// an explicit candidate may convert it, without changing the selected Driver.
test("an image upgrade can explicitly wrap an existing plugin registration", async (t) => {
  for (const selection of ["occ-plugin", "codex-plugin", "curated-codex"]) {
    await t.test(selection, async (subtest) => {
      const id = selection === "curated-codex" ? "codex-plugin" : selection;
      const pluginDrivers = {
        id,
        configuration:
          id === "codex-plugin"
            ? {
                catalogSource: "hosted",
                codexExecutable: "/usr/bin/codex",
                codexHome: "/var/lib/codex",
              }
            : {},
      };
      const candidatePluginDrivers = [structuredClone(pluginDrivers)];
      if (selection === "curated-codex") {
        candidatePluginDrivers[0].configuration.catalogSource = "openai-curated";
      }
      const f = await fixture(subtest, {
        candidates: true,
        controllerOnly: true,
        pluginDrivers,
        candidatePluginDrivers,
      });
      await f.run();
      const state = await f.state();
      const installed = loadYaml(
        Buffer.from(state.secret.data["installation.yaml"], "base64").toString(),
      );
      assert.deepEqual(installed.drivers.plugin, candidatePluginDrivers);
      assert.equal(state.version, 2);
    });
  }
});

test("wrapping a plugin registration preserves protected settings", async (t) => {
  for (const change of [
    "executable",
    "home",
    "driver",
    "extra-driver",
    "configuration-shape",
    "registration-shape",
    "duplicate-driver",
    "unrelated-setting",
    "unknown-installed-driver",
    "installed-extra-field",
    "installed-missing-configuration",
    "installed-configuration-shape",
  ]) {
    await t.test(change, async (subtest) => {
      const pluginDrivers = {
        id: "codex-plugin",
        configuration: {
          catalogSource: "hosted",
          codexExecutable: "/usr/bin/codex",
          codexHome: "/var/lib/codex",
        },
      };
      // Invalid installed registrations must not become accepted through wrapping.
      if (change === "unknown-installed-driver") {
        pluginDrivers.id = "unknown-plugin";
      }
      if (change === "installed-extra-field") {
        pluginDrivers.extra = true;
      }
      if (change === "installed-missing-configuration") {
        delete pluginDrivers.configuration;
      }
      if (change === "installed-configuration-shape") {
        pluginDrivers.configuration = [];
      }
      const candidatePluginDrivers = [structuredClone(pluginDrivers)];
      const candidate = candidatePluginDrivers[0];
      if (change === "executable") {
        candidate.configuration.codexExecutable = "/other/codex";
      }
      if (change === "home") {
        candidate.configuration.codexHome = "/other/home";
      }
      if (change === "driver") {
        candidate.id = "occ-plugin";
      }
      if (change === "extra-driver") {
        candidatePluginDrivers.push({ id: "occ-plugin", configuration: {} });
      }
      if (change === "configuration-shape") {
        candidate.configuration = [];
      }
      if (change === "registration-shape") {
        candidatePluginDrivers[0] = "codex-plugin";
      }
      if (change === "duplicate-driver") {
        candidatePluginDrivers.push(structuredClone(candidate));
      }
      const f = await fixture(subtest, {
        candidates: true,
        controllerOnly: true,
        pluginDrivers,
        candidatePluginDrivers,
      });
      if (change === "unrelated-setting") {
        const path = join(f.directory, "candidate-installation.json");
        const installation = JSON.parse(await readFile(path, "utf8"));
        installation.name = "Different installation";
        await writeFile(path, JSON.stringify(installation));
      }
      await assert.rejects(f.run(), /candidate Installation changes a protected setting/);
      assert.deepEqual(await f.events(), []);
    });
  }
});

registerDispatchRestoreTests(fixture, injectedFault);

test("resume reads an accepted Secret write before Helm and preserves its other data", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run(), injectedFault);
  const interrupted = await f.state();
  assert.match(
    Buffer.from(interrupted.secret.data["installation.yaml"], "base64").toString(),
    /bbbbbbbbbbbbbbbb/,
  );
  interrupted.secret.immutable = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(interrupted));
  await f.run("--resume");
  assert.deepEqual(await f.events(), [
    "scale-api",
    "scale-worker",
    "secret-replaced",
    "scale-api",
    "scale-worker",
    "migration",
  ]);
  const state = await f.state();
  assert.equal(state.secret.metadata.annotations.retained, "yes");
  assert.equal(state.secret.data.retained, "cHJlc2VydmVk");
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
});

// Open again after resume so a replaced receipt is checked at its published path.
async function assertPrivateReceipt(path, expected) {
  const file = await open(path, "r");
  try {
    assert.equal((await file.stat()).mode & 0o777, 0o600);
    assert.equal(await file.readFile("utf8"), expected);
  } finally {
    await file.close();
  }
}

async function assertHelmIntent(f, previousRevision, expectedRevision) {
  const intent = JSON.parse(await readFile(join(f.evidence, "helm-started"), "utf8"));
  assert.equal(intent.previousRevision, previousRevision);
  assert.equal(intent.expectedRevision, expectedRevision);
  const attempt = join(f.evidence, "helm-attempts", intent.attempt.nonce);
  assert.equal(
    (await yamlFile(join(attempt, "values.yaml"))).installation.upgradeAttemptId,
    intent.attempt.nonce,
  );
  assert.deepEqual(JSON.parse(await readFile(join(attempt, "intent.json"), "utf8")), intent);
  return intent;
}

test("resume recognizes a committed Helm release without rerunning its migration", async (t) => {
  for (const [fault, operation, component] of [
    ["lost-helm-response", "helm-upgrade", "release"],
    ["fail-rollout-api", "rollout-status", "api"],
    ["fail-rollout-worker", "rollout-status", "worker"],
  ]) {
    await t.test(fault, async (subtest) => {
      const f = await fixture(subtest);
      await f.failNext(fault);
      await assert.rejects(f.run(), (error) => {
        assert.equal(error.code, 9);
        assert.match(error.stderr, new RegExp(`${operation}.*${component}.*9`));
        return true;
      });
      const receipt = `${operation}\t${component}\t9\n`;
      const path = join(f.evidence, "native-command-failures.tsv");
      await assertPrivateReceipt(path, receipt);
      // The native failure says nothing about acceptance: Helm committed in
      // every case, and a readback must recover without another migration.
      const state = await f.state();
      assert.equal(state.version, 2);
      assert.equal(state.helmStatus, "deployed");
      assert.equal(state.api, 1);
      assert.equal(state.worker, 1);
      await assertHelmIntent(f, 1, 2);
      await f.run("--resume");
      await assertPrivateReceipt(path, receipt);
      assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    });
  }
});

test("resume refuses an intervening same-values Helm revision even with checked history", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const state = await f.state();
  assert.equal(state.version, 2);
  // Another operator submits identical values after the accepted request. Its
  // revision must not be credited to this interrupted submission.
  state.version += 1;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  const events = await f.events();
  await assert.rejects(f.run("--resume", "--migration-history-checked"), /outside this submission/);
  assert.deepEqual(await f.events(), events);
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
});

test("resume refuses missing, empty or malformed Helm submission evidence", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const events = await f.events();
  const path = join(f.evidence, "helm-started");
  const original = JSON.parse(await readFile(path, "utf8"));
  // Evidence loss must not turn a newer deployed release into an attributed success.
  await rm(path);
  await assert.rejects(f.run("--resume", "--migration-history-checked"), /revision changed/);
  for (const intent of [
    "",
    "{",
    JSON.stringify({ ...original, previousRevision: 0, expectedRevision: 1 }),
    JSON.stringify({ ...original, previousRevision: 1.5, expectedRevision: 2.5 }),
    JSON.stringify({ ...original, previousRevision: 1, expectedRevision: 3 }),
    JSON.stringify(original) + "\n{}",
    JSON.stringify({ previousRevision: 1, expectedRevision: 2 }),
  ]) {
    await writeFile(path, intent, { mode: 0o600 });
    await assert.rejects(f.run("--resume", "--migration-history-checked"), /submission intent/);
  }
  assert.deepEqual(await f.events(), events);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
});

test("resume rejects invalid intent paths before any new submission", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run(), injectedFault);
  const events = await f.events();
  const path = join(f.evidence, "helm-started");
  // No Helm request exists at revision 1. A directory must not look absent,
  // or mv can publish inside it and continue without an authoritative intent.
  for (const kind of ["directory", "symlink", "public-file"]) {
    if (kind === "directory") {
      await mkdir(path);
    } else if (kind === "symlink") {
      symlinkSync(join(f.evidence, "before-helm-status.json"), path);
    } else {
      await writeFile(path, JSON.stringify({ previousRevision: 1, expectedRevision: 2 }));
      await chmod(path, 0o644);
    }
    const failure = await f.run("--resume").catch((error) => error);
    assert.equal((await f.state()).helmSubmissions ?? 0, 0);
    assert.deepEqual(await f.events(), events);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    assert.match(failure.stderr, /regular file|group or other permissions/);
    await rm(path, { recursive: true });
  }
});

test("resume refuses deployed candidate drift rather than retrying Helm", async (t) => {
  for (const changed of ["values", "installation"]) {
    await t.test(changed, async (t) => {
      const f = await fixture(t, { candidates: true });
      const before = await f.state();
      await f.failNext("lost-helm-response");
      await assert.rejects(f.run(), injectedFault);
      const events = await f.events();
      // Returning either object to its accepted baseline still conflicts with
      // the deployed candidate; checked history cannot authorize another Helm.
      if (changed === "values") {
        await cp(join(f.evidence, "before-live-values.yaml"), join(f.directory, "live-values"));
      } else {
        const current = await f.state();
        current.secret.data = before.secret.data;
        await writeFile(join(f.directory, "state.json"), JSON.stringify(current));
      }
      await assert.rejects(
        f.run("--resume", "--migration-history-checked"),
        changed === "values"
          ? /does not match the candidate values/
          : /live Installation Secret does not/,
      );
      assert.deepEqual(await f.events(), events);
      assert.equal((await f.state()).helmSubmissions, 1);
      assert.equal(existsSync(join(f.evidence, "completed")), false);
    });
  }
});

test("a nonaccepted Helm submission retries the same successor after checked history", async (t) => {
  const f = await fixture(t);
  await f.failNext("reject-helm-submission");
  await assert.rejects(f.run(), injectedFault);
  assert.equal((await f.state()).version, 1);
  await assert.rejects(f.run("--resume"), /migration --check/);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run("--resume", "--migration-history-checked"), injectedFault);
  await assertHelmIntent(f, 1, 2);
  await f.run("--resume");
  assert.equal((await f.state()).version, 2);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("quiescence validates both writers before stopping either and resumes after correction", async (t) => {
  const f = await fixture(t);
  // A preexisting worker configuration must not cause an avoidable API outage.
  const initial = await f.state();
  initial.worker = 2;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(initial));
  await assert.rejects(f.run(), /openclaw-enterprise-worker has unexpected ownership or replicas/);
  const refused = await f.state();
  const events = await f.events();
  t.diagnostic(JSON.stringify({ api: refused.api, worker: refused.worker, events }));
  assert.equal(refused.api, 1);
  assert.equal(refused.worker, 2);
  assert.deepEqual(events, []);
  assert.equal(existsSync(join(f.evidence, "helm-started")), false);

  // Operator correction permits normal resume without replaying a migration.
  refused.worker = 1;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(refused));
  await f.run("--resume");
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "secret-replaced", "migration"]);
  assert.equal((await f.state()).api, 1);
  assert.equal((await f.state()).worker, 1);
});

test("an interrupted quiescence never starts migration while the worker still runs", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run(), injectedFault);
  const path = join(f.evidence, "native-command-failures.tsv");
  const receipt = "quiescence-scale\tworker\t9\n";
  assert.equal(await readFile(path, "utf8"), receipt);
  assert.equal((await f.state()).api, 0);
  assert.equal((await f.state()).worker, 1);
  assert.equal(existsSync(join(f.evidence, "helm-started")), false);
  assert.deepEqual(await f.events(), ["scale-api"]);
  // A later failed attempt appends its observation instead of erasing the first.
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run("--resume"), injectedFault);
  assert.equal(await readFile(path, "utf8"), receipt + receipt);
  await f.run("--resume");
  assert.equal(await readFile(path, "utf8"), receipt + receipt);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("quiescence refuses a worker changed after observation and preserves partial recovery", async (t) => {
  for (const fault of ["replace-worker-before-scale", "edit-worker-before-scale"]) {
    await t.test(fault, async (t) => {
      const f = await fixture(t);
      await f.failNext(fault);
      const failure = await f.run().then(
        () => null,
        (error) => error,
      );
      const state = await f.state();
      const events = await f.events();
      t.diagnostic(JSON.stringify({ api: state.api, worker: state.worker, events }));
      assert.equal(failure?.code, 1);
      assert.equal(state.api, 0);
      assert.equal(state.worker, 1);
      assert.equal(
        state.deploymentIdentities.worker.uid,
        fault === "replace-worker-before-scale"
          ? "replacement-worker-uid"
          : "worker-deployment-uid",
      );
      assert.equal(existsSync(join(f.evidence, "helm-started")), false);
      assert.deepEqual(await f.events(), ["scale-api"]);
      assert.equal(
        await readFile(join(f.evidence, "native-command-failures.tsv"), "utf8"),
        "quiescence-scale\tworker\t1\n",
      );
      // After the operator reconciles the conflict, resume observes the current
      // worker and the already-stopped API instead of replaying stale preconditions.
      await f.run("--resume");
      assert.deepEqual(await f.events(), [
        "scale-api",
        "scale-api",
        "scale-worker",
        "secret-replaced",
        "migration",
      ]);
      assert.equal((await f.state()).worker, 1);
    });
  }
});

test("native failure status survives failed diagnostics and receipt writes", async (t) => {
  for (const [stderr, blockedReceipt] of [
    ["/dev/full", false],
    [null, true],
    ["/dev/full", true],
    ["pipe", true],
  ]) {
    await t.test(`${stderr ?? "normal stderr"}, blocked receipt: ${blockedReceipt}`, async (t) => {
      let sink;
      if (stderr === "/dev/full") {
        try {
          sink = await open("/dev/full", constants.O_WRONLY);
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
          t.skip("requires /dev/full (Linux)");
          return;
        }
        t.after(() => sink.close());
      }
      const f = await fixture(t);
      await f.failNext("fail-scale-worker");
      // A directory denies receipt append even when the test runs as root.
      if (blockedReceipt) {
        await f.failNext("block-failure-receipt");
      }
      const status = sink
        ? (await f.runWithStderr(sink.fd)).status
        : await (stderr === "pipe" ? f.runWithBrokenPipe() : f.run()).then(
            () => assert.fail("worker scale must fail"),
            (error) => error.code,
          );
      const path = join(f.evidence, "native-command-failures.tsv");
      const events = await f.events();
      t.diagnostic(JSON.stringify({ status, events }));
      assert.equal(status, 9);
      assert.equal((await f.state()).api, 0);
      assert.equal((await f.state()).worker, 1);
      assert.equal(existsSync(join(f.evidence, "helm-started")), false);
      assert.deepEqual(events, ["scale-api"]);
      if (blockedReceipt) {
        assert.deepEqual(await readdir(path), []);
      } else {
        await assertPrivateReceipt(path, "quiescence-scale\tworker\t9\n");
      }
    });
  }
});

test("failed Helm migration keeps old writers stopped and requires checked history and a terminal Job", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-migration");
  await assert.rejects(f.run(), injectedFault);
  assert.equal((await f.state()).api, 0);
  assert.equal((await f.state()).worker, 0);
  await assert.rejects(f.run("--resume"), /migration --check/);
  const state = await f.state();
  // An active Job may schedule a replacement even with no active Pods.
  state.initJobActive = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(
    f.run("--resume", "--migration-history-checked"),
    /initialization Job is still active/,
  );
  state.initJobActive = false;
  state.initActive = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(
    f.run("--resume", "--migration-history-checked"),
    /initialization Pod is still active/,
  );
  state.initActive = false;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  // The accepted failure consumed revision 2. A retry must bind revision 3;
  // losing its response must still resume without a third submission.
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run("--resume", "--migration-history-checked"), injectedFault);
  await assertHelmIntent(f, 2, 3);
  await f.run("--resume");
  assert.equal((await f.state()).version, 3);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 2);
});

test("resume stops on an unknown Agent deployment until an accepted revision is confirmed", async (t) => {
  const f = await fixture(t, { agent: true });
  await f.failNext("lost-agent-response");
  await assert.rejects(f.run(), /deployment outcome is unknown/);
  const calls = f.commands.length;
  await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
  assert.equal(f.commands.length, calls);
  assert.equal((await f.state()).dispatches, 1);
  const receipt = join(f.evidence, "dispatch/ns_test--agt_test.json");
  // An arbitrary or baseline revision cannot resolve the pending dispatch.
  for (const id of ["rev_missing", "rev_old"]) {
    await writeFile(receipt, JSON.stringify({ id }), { mode: 0o600 });
    await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
    assert.equal((await f.state()).dispatches, 1);
  }
  // Simulate the operator confirming this revision in durable history and
  // recording the accepted request before resuming the readiness checks.
  await writeFile(receipt, JSON.stringify({ id: "rev_new" }), { mode: 0o600 });
  await f.run("--resume");
  assert.equal((await f.state()).dispatches, 1);
});

describe("resume evidence directory ownership", { concurrency: 2 }, () => {
  test("resume binds stale prepared copies to the original evidence directory before live access", async (t) => {
    const f = await fixture(t, { agent: true });
    await f.failNext("fail-rollout-worker");
    await assert.rejects(f.run(), injectedFault);
    const copy = join(f.directory, "stale-copy");
    await cp(f.evidence, copy, { recursive: true });

    // The copy predates dispatch. The original records a later accepted request
    // whose response was lost; replay from the stale copy would deploy twice.
    await f.failNext("lost-agent-response");
    await assert.rejects(f.run("--resume"), /deployment outcome is unknown/);
    assert.equal((await f.state()).dispatches, 1);
    const lock = join(f.evidence, ".upgrade-lock");
    await mkdir(lock);
    const calls = f.commands.length;
    const refusal = await f.run("--resume", "--evidence-dir", copy).then(
      () => null,
      (error) => error,
    );
    assert.equal(
      (await f.state()).dispatches,
      1,
      "a stale copy must not replay the accepted dispatch",
    );
    assert.match(refusal?.stderr ?? "", /resume evidence directory/);
    assert.equal(f.commands.length, calls, "reject before external commands, including reads");
    assert.ok(existsSync(lock), "a copy must not remove the original's held lock");
    await rm(lock, { recursive: true });
    await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
    assert.equal((await f.state()).dispatches, 1);
  });

  test("resume binds moved and replaced evidence directories before live access", async (t) => {
    for (const change of ["move", "replacement", "missing identity"]) {
      await t.test(change, async (t) => {
        const f = await fixture(t, { agent: true });
        await f.failNext("fail-scale-worker");
        await assert.rejects(f.run(), injectedFault);
        const moved = join(f.directory, "moved-evidence");
        if (change === "missing identity") {
          const path = join(f.evidence, "parameters.json");
          const parameters = JSON.parse(await readFile(path, "utf8"));
          delete parameters.evidenceDirectory;
          await writeFile(path, JSON.stringify(parameters));
        } else {
          await rename(f.evidence, moved);
          if (change === "replacement") {
            await cp(moved, f.evidence, { recursive: true });
          }
        }
        const calls = f.commands.length;
        await assert.rejects(
          f.run("--resume", "--evidence-dir", change === "move" ? moved : f.evidence),
          /resume evidence directory/,
        );
        assert.equal(f.commands.length, calls, "reject before external commands, including reads");
        assert.equal((await f.state()).dispatches, 0);
        if (change === "move") {
          await rename(moved, f.evidence);
          await f.run("--resume");
          assert.equal((await f.state()).dispatches, 1);
        }
      });
    }
  });

  test("resume accepts the original evidence directory and canonical aliases", async (t) => {
    for (const alias of ["original", "relative", "parent symlink"]) {
      await t.test(alias, async (t) => {
        const f = await fixture(t, { agent: true });
        await f.failNext("fail-scale-worker");
        await assert.rejects(f.run(), injectedFault);
        let evidence = f.evidence;
        if (alias === "relative") {
          evidence = relative(repository, f.evidence);
        } else if (alias === "parent symlink") {
          const parent = join(f.directory, "parent-alias");
          symlinkSync(f.directory, parent, "dir");
          evidence = join(parent, "evidence");
        } else {
          // Canonicalization must not bypass the existing leaf-symlink or mode guards.
          const leaf = join(f.directory, "leaf-alias");
          symlinkSync(f.evidence, leaf, "dir");
          const calls = f.commands.length;
          await assert.rejects(
            f.run("--resume", "--evidence-dir", leaf),
            /requires the original evidence directory/,
          );
          await chmod(f.evidence, 0o755);
          await assert.rejects(f.run("--resume"), /must not grant group or other permissions/);
          await chmod(f.evidence, 0o700);
          assert.equal(f.commands.length, calls);
        }
        // Aliases must still share the original lock, not create another lock.
        const lock = join(f.evidence, ".upgrade-lock");
        await mkdir(lock);
        const calls = f.commands.length;
        await assert.rejects(
          f.run("--resume", "--evidence-dir", evidence),
          /evidence directory is locked/,
        );
        assert.equal(f.commands.length, calls);
        await rm(lock, { recursive: true });
        await f.run("--resume", "--evidence-dir", evidence);
        assert.equal((await f.state()).dispatches, 1);
        assert.equal(existsSync(lock), false);
      });
    }
  });

  test("newline-suffixed evidence paths never use the existing sibling directory", async (t) => {
    const f = await fixture(t, { agent: true });
    const evidence = f.evidence + "\n";
    const siblingParameters = join(f.evidence, "parameters.json");
    const sentinel = "Preserve the unrelated sibling's evidence.\n";
    await mkdir(f.evidence, { mode: 0o700 });
    await writeFile(siblingParameters, sentinel, { mode: 0o600 });

    // Shell command substitution would strip the newline, redirecting both
    // the lock and evidence writes into the pre-existing sibling directory.
    await f.failNext("fail-scale-worker");
    await assert.rejects(f.run("--evidence-dir", evidence), injectedFault);
    assert.equal(await readFile(siblingParameters, "utf8"), sentinel);
    assert.deepEqual(await readdir(f.evidence), ["parameters.json"]);
    assert.ok(existsSync(join(evidence, "prepared")));

    const lock = join(evidence, ".upgrade-lock");
    await mkdir(lock);
    const calls = f.commands.length;
    await assert.rejects(
      f.run("--resume", "--evidence-dir", evidence),
      /evidence directory is locked/,
    );
    assert.equal(f.commands.length, calls);
    await rm(lock, { recursive: true });

    // A lock held by the sibling must neither block this resume nor be removed.
    const siblingLock = join(f.evidence, ".upgrade-lock");
    await mkdir(siblingLock);
    await f.run("--resume", "--evidence-dir", evidence);
    assert.equal((await f.state()).dispatches, 1);
    assert.equal(existsSync(lock), false);
    assert.ok(existsSync(siblingLock));
    assert.equal(await readFile(siblingParameters, "utf8"), sentinel);
    assert.deepEqual((await readdir(f.evidence)).sort(), [".upgrade-lock", "parameters.json"]);
  });
});

// OCC admits a deploy in one transaction, so a 4xx answer with an OCC error code saved
// no revision: the helper names the Agent and the refusal, and --resume deploys it
// again. A 408 or 5xx answer, like a lost response, leaves the outcome unknown, and so
// does stderr with a second "Error: " line, here inside OCC's message. A refused service
// key is the helper's own credential failing, not an Agent refusal. Each case deploys two
// Agents; OCC accepts agt_ok, which is neither named nor deployed again on resume.
const refusedField =
  "Configuration setting tools.gatewayPolicy.actions.sessions must use reviewed task actions.";
for (const { name, error, refusal, keyRefused = false } of [
  {
    name: "HTTP 400",
    // occ indents the rejected field's details under the message; a control character
    // in OCC's message must not reach the terminal.
    error:
      `Error: OCC operation failed (HTTP 400): INVALID_REQUEST: ${refusedField}\u001b[2J\n` +
      '  {"path":"tools.gatewayPolicy.actions.sessions","code":"invalid_value"}',
    refusal: `OCC operation failed (HTTP 400): INVALID_REQUEST: ${refusedField}?[2J {"path":"tools.gatewayPolicy.actions.sessions","code":"invalid_value"}`,
  },
  {
    name: "HTTP 401 for the service key",
    error:
      "Error: OCC rejected the service key in /keys/upgrade.json: it is invalid, expired or revoked. Ask an Installation administrator for a new key.",
    refusal:
      "OCC rejected the service key in /keys/upgrade.json: it is invalid, expired or revoked. Ask an Installation administrator for a new key.",
    keyRefused: true,
  },
  {
    name: "HTTP 408",
    error: "Error: OCC operation failed (HTTP 408): REQUEST_TIMEOUT: The request timed out.",
  },
  {
    name: "HTTP 503",
    error:
      "Error: OCC operation failed (HTTP 503): DEPENDENCY_UNAVAILABLE: The selected compute Driver is unavailable.",
  },
  {
    name: "HTTP 503 whose message carries a refusal line",
    error:
      "Error: OCC operation failed (HTTP 503): DEPENDENCY_UNAVAILABLE: upstream answered\n" +
      `Error: OCC operation failed (HTTP 400): INVALID_REQUEST: ${refusedField}`,
  },
]) {
  const outcome = keyRefused
    ? "a service-key failure"
    : refusal
      ? "refused and redeployed on resume"
      : "an unknown outcome";
  test(`an Agent deploy answered with ${name} is ${outcome}`, async (t) => {
    const agent = (id) => ({
      id,
      status: "active",
      desiredRuntimeState: "running",
      executionMode: "embedded",
      activeRevisionId: "rev_old",
      deploymentInProgress: false,
    });
    const f = await fixture(t, {
      inventoryNamespaces: [
        { id: "ns_test", status: "ready", agents: [agent("agt_ok"), agent("agt_test")] },
      ],
      names: { ns_test: "Support", agt_ok: "Accepted", agt_test: "Mail triage" },
    });
    const state = await f.state();
    state.deployFailures = { agt_test: error };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const failure = await f.run().then(
      () => assert.fail("the upgrade must stop at the failed deploy"),
      (stopped) => stopped,
    );
    const prefix = join(f.evidence, "dispatch/ns_test--agt_test");
    assert.doesNotMatch(failure.stderr, /agt_ok/);
    assert.equal(existsSync(join(f.evidence, "dispatch/ns_test--agt_ok.json")), true);
    if (!refusal) {
      assert.deepEqual(failure.stderr.trimEnd().split("\n"), [
        `upgrade-production-images: at least one Agent deployment outcome is unknown; inspect ${join(f.evidence, "dispatch")} and reconcile it before resuming:`,
        '  - Agent agt_test "Mail triage" in Namespace ns_test',
      ]);
      assert.equal(existsSync(prefix + ".rejected"), false);
      await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
      assert.equal((await f.state()).dispatches, 2);
      return;
    }
    assert.deepEqual(
      failure.stderr.trimEnd().split("\n"),
      keyRefused
        ? [
            `upgrade-production-images: OCC rejected the service key in ${join(f.directory, "key")}, so it did not deploy 1 recorded Agent(s) and saved no revision for them:`,
            '  - Agent agt_test "Mail triage" in Namespace ns_test',
            "The key is invalid, expired or revoked; the Agents are not at fault. Ask an Installation administrator for a new key, point OCC_SERVICE_KEY_FILE at it, then repeat this command with --resume and the same evidence directory. The resume deploys these Agents once.",
          ]
        : [
            "upgrade-production-images: OCC refused to deploy 1 recorded Agent(s) with the new release and saved no revision for them:",
            `  - Agent agt_test "Mail triage" in Namespace ns_test: ${refusal}`,
            "Correct what each refusal names, such as a Configuration setting the new release refuses, then repeat this command with --resume and the same evidence directory. The resume deploys each refused Agent once; do not deploy it yourself. The refusals are in dispatch/*.rejected.",
          ],
    );
    assert.equal(await readFile(prefix + ".rejected", "utf8"), refusal + "\n");
    assert.equal(existsSync(prefix + ".intent"), false);
    // The operator corrected the cause; the resume sends only the refused deploy, once.
    await f.run("--resume");
    assert.equal((await f.state()).dispatches, 3);
    assert.deepEqual(
      (await f.events()).filter((event) => event.startsWith("agent-deploy")).toSorted(),
      ["agent-deploy agt_ok", "agent-deploy agt_test", "agent-deploy-failed agt_test"],
    );
  });
}

// Doctor shares the serving gateway container's memory limit, and an out-of-memory
// kill there stops the gateway too (finding 2697). Doctor, with a 384 MiB heap cap,
// starts after one read with 1 GiB free or two reads in a row with 640 MiB (the cap,
// off-heap memory and a margin); a dropped connection is read again, and a kill is named.
const doctorCommand = (heap) =>
  `doctor env NODE_OPTIONS=--max-old-space-size=${heap} node /app/openclaw.mjs doctor --lint --json --severity-min error`;
const doctorEvents = async (f) =>
  (await f.events()).filter((event) => /^(gateway-memory|doctor) /.test(event));
const scriptGatewayMemory = async (f, reads) => {
  const state = await f.state();
  state.gatewayFree = reads;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
};

// Exit 137 is a kill. Only the gateway container's status, with a restart after the
// gateway became Ready, shows that the container hit its memory limit.
test("OpenClaw Doctor waits for free gateway memory and names an OOM kill only from the container status", async (t) => {
  const f = await fixture(t, { agent: true });
  // Free MiB per read: a low read resets the count of good reads.
  await scriptGatewayMemory(f, ["transient", 700, 300, 700, 640]);
  await f.failNext("doctor-oom");
  const oom = await f.run().then(
    () => assert.fail("the upgrade must stop when the gateway is OOM-killed"),
    (stopped) => stopped,
  );
  assert.deepEqual(await doctorEvents(f), [
    "gateway-memory transient",
    "gateway-memory 700",
    "gateway-memory 300",
    "gateway-memory 700",
    "gateway-memory 640",
    doctorCommand(384),
  ]);
  assert.doesNotMatch(oom.stderr, /without checking its free memory/);
  assert.match(
    oom.stderr,
    /OpenClaw Doctor was killed \(exit 137\) in Agent agt_test's gateway\.\n.*Agent agt_test's gateway container was OOM-killed and restarted 1 time\(s\) after it became Ready/,
  );
  assert.match(oom.stderr, /OpenClaw Doctor failed for at least one replacement gateway/);
  // Resume runs Doctor again without a new deploy. Kubernetes kills the container for
  // another reason now: exit 137 again, but no OOM kill. Only the restart after this
  // run's Ready gateway counts; the earlier OOM restart predates it.
  await f.failNext("doctor-killed");
  const killed = await f.run("--resume").then(
    () => assert.fail("the upgrade must stop when Doctor is killed"),
    (stopped) => stopped,
  );
  assert.match(
    killed.stderr,
    /OpenClaw Doctor was killed \(exit 137\) in Agent agt_test's gateway\.\n.*Agent agt_test's gateway container restarted 1 time\(s\) after it became Ready \(last termination: Error\)\./,
  );
  assert.doesNotMatch(killed.stderr, /OOM-killed and restarted/);
  // A gateway without a memory limit (memory.max reads "max") has room.
  await scriptGatewayMemory(f, ["unlimited"]);
  await f.run("--resume");
  assert.equal((await f.state()).dispatches, 1);
  assert.deepEqual((await doctorEvents(f)).slice(6), [
    "gateway-memory 2048",
    doctorCommand(384),
    "gateway-memory unlimited",
    doctorCommand(384),
  ]);
});

// These cases each wait out a real upgrade timeout (3 s or 8 s) with their own fixture,
// so they run side by side instead of one after another.
describe("OpenClaw Doctor at the upgrade timeout", { concurrency: true }, () => {
  // A memory timeout at one gateway starts no further Doctor but waits for the ones
  // already running: the evidence lock must outlast them, or a second upgrade could
  // start while a Doctor still runs in a serving gateway. Doctor's own exit status, not
  // an exit code quoted on its stderr, classifies its failure.
  test("a Doctor memory timeout keeps the evidence lock until every started Doctor ends", async (t) => {
    const agent = (id) => ({
      id,
      status: "active",
      desiredRuntimeState: "running",
      executionMode: "embedded",
      activeRevisionId: "rev_old",
      deploymentInProgress: false,
    });
    // A poll that finds the deadline passed reads nothing; the timeout still names B's last
    // read (0 MiB), not "unknown".
    const f = await fixture(t, {
      inventoryNamespaces: [
        { id: "ns_test", status: "ready", agents: [agent("agt_a"), agent("agt_b")] },
      ],
    });
    // Gateway A has room at once; gateway B never does before the 3 s timeout. A's Doctor
    // runs past the timeout.
    await scriptGatewayMemory(f, [2048, ...Array(20).fill(0)]);
    const state = await f.state();
    state.doctorHoldMs = 6000;
    // The gateway was OOM-killed once before it became Ready; that restart is not Doctor's.
    state.gatewayRestarts = 1;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await f.failNext("doctor-hold");
    const failure = await f.run("--timeout-seconds", "3").then(
      () => assert.fail("the upgrade must stop at the memory timeout"),
      (stopped) => stopped,
    );
    // Bounded wait: without the join, A ends after the command has exited.
    for (let tries = 0; tries < 100; tries += 1) {
      if ((await f.events()).some((event) => event.startsWith("doctor-ended "))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const events = await f.events();
    assert.deepEqual(
      events.filter((event) => event.startsWith("doctor")),
      [doctorCommand(384), "doctor-ended lock held"],
    );
    assert.equal(existsSync(join(f.evidence, ".upgrade-lock")), false);
    const lines = failure.stderr.trimEnd().split("\n");
    assert.deepEqual(lines.slice(-3, -1), [
      "upgrade-production-images: OpenClaw Doctor failed (exit 1) in Agent agt_a's gateway.",
      "upgrade-production-images: Agent agt_a's gateway container did not restart after it became Ready.",
    ]);
    assert.match(
      lines.at(-1),
      /Agent agt_b's gateway did not keep 640 MiB free below its memory limit before the upgrade timeout \(last read: 0 MiB free\), so OpenClaw Doctor did not run/,
    );
  });

  test("OpenClaw Doctor does not run while the gateway lacks free memory", async (t) => {
    const f = await fixture(t, { agent: true });
    // Every read is 1 MiB short; the timeout names the last one, even when the final poll
    // finds the deadline passed and reads nothing.
    await scriptGatewayMemory(f, Array(20).fill(639));
    await assert.rejects(
      f.run("--timeout-seconds", "3"),
      /Agent agt_test's gateway did not keep 640 MiB free below its memory limit before the upgrade timeout \(last read: 639 MiB free\), so OpenClaw Doctor did not run/,
    );
    assert.equal(
      (await f.events()).some((event) => event.startsWith("doctor ")),
      false,
    );
  });

  // A read can admit Doctor and still end at the deadline. Doctor then does not start,
  // and the error is a plain timeout: the gateway had the memory, so the low-memory
  // message (with its "last read" of ample memory) would contradict itself.
  test("OpenClaw Doctor admitted at the upgrade deadline reports a plain timeout", async (t) => {
    const f = await fixture(t, { agent: true });
    // The low read and the slow read both start well before the 8 s deadline.
    await scriptGatewayMemory(f, [300, "slow:2048"]);
    const failure = await f.run("--timeout-seconds", "8").then(
      () => assert.fail("the upgrade must stop at the timeout"),
      (stopped) => stopped,
    );
    assert.deepEqual(await doctorEvents(f), ["gateway-memory 300", "gateway-memory slow:2048"]);
    assert.equal(
      failure.stderr.trimEnd().split("\n").at(-1),
      "upgrade-production-images: OpenClaw Doctor did not run before the upgrade timeout.",
    );
  });

  test(
    "OpenClaw Doctor keeps low memory admission closed across missing and transient reads",
    { concurrency: true },
    async (t) => {
      const cases = [];
      for (const unavailable of ["missing", "transient"]) {
        cases.push(
          t.test(unavailable, async (t) => {
            const f = await fixture(t, { agent: true });
            // Do not exhaust the script: the fixture defaults to ample memory afterward.
            await scriptGatewayMemory(f, [300, ...Array(100).fill(unavailable)]);
            // The reads after the low one measure nothing; the timeout names the low one.
            await assert.rejects(
              f.run("--timeout-seconds", "8"),
              /before the upgrade timeout \(last measured: 300 MiB free; later reads failed\), so OpenClaw Doctor did not run/,
            );
            const events = await doctorEvents(f);
            assert.equal(events[0], "gateway-memory 300");
            assert.ok(events.includes(`gateway-memory ${unavailable}`));
            assert.ok(!events.includes("gateway-memory 2048"));
            assert.ok(!events.some((event) => event.startsWith("doctor ")));
          }),
        );
      }
      await Promise.all(cases);
    },
  );
});

test("OpenClaw Doctor retains warning and run for initially unavailable transport observations", async (t) => {
  const f = await fixture(t, { agent: true });
  await scriptGatewayMemory(f, Array(3).fill("transient"));
  const result = await f.run();
  assert.match(result.stderr, /running OpenClaw Doctor without checking its free memory/);
  assert.deepEqual(await doctorEvents(f), [
    ...Array(3).fill("gateway-memory transient"),
    doctorCommand(384),
  ]);
});

test("OpenClaw Doctor recovers with fresh consecutive memory evidence after observation failures", async (t) => {
  const f = await fixture(t, { agent: true });
  const reads = [
    300,
    "transient",
    "transient",
    "transient",
    700,
    "missing",
    700,
    "transient",
    700,
    640,
  ];
  await scriptGatewayMemory(f, reads);
  await f.run();
  assert.deepEqual(await doctorEvents(f), [
    ...reads.map((free) => `gateway-memory ${free}`),
    doctorCommand(384),
  ]);
});

test(
  "OpenClaw Doctor reports unknown restart history unless Ready and post-read observations are comparable",
  { concurrency: true },
  async (t) => {
    const pod = (count = 0) => ({
      metadata: { namespace: "tenant", name: "gateway", uid: "gateway-uid" },
      spec: { containers: [{ name: "gateway", image: runtime }] },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [{ name: "gateway", restartCount: count, lastState: {} }],
      },
    });
    const withoutRows = pod();
    delete withoutRows.status.containerStatuses;
    const replacement = pod();
    replacement.metadata.uid = "replacement-uid";
    // Only Pod states the Kubernetes API returns: container statuses not reported, a Pod
    // replaced under the same name (new UID), and a lower restart count.
    const cases = [
      ["missing Ready row", withoutRows, pod()],
      ["missing post row", pod(), withoutRows],
      ["replacement Pod", pod(), replacement],
      ["decreased count", pod(2), pod(1)],
      ["additional restart without reason", pod(), pod(1), "restart"],
      ["true zero", pod(), pod(), true],
      ["unchanged nonzero", pod(3), pod(3), true],
    ];
    const runs = [];
    for (const [name, ready, after, comparable] of cases) {
      runs.push(
        t.test(name, async (t) => {
          const f = await fixture(t, { agent: true });
          const state = await f.state();
          state.gatewayReady = ready;
          state.gatewayAfter = after;
          await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
          await f.failNext("doctor-error");
          const failure = await f.run().then(
            () => assert.fail("Doctor command failure must stop the upgrade"),
            (stopped) => stopped,
          );
          assert.match(failure.stderr, /OpenClaw Doctor failed \(exit 1\)/);
          if (comparable === "restart") {
            assert.match(
              failure.stderr,
              /restarted 1 time\(s\) after it became Ready \(last termination: none\)/,
            );
            assert.doesNotMatch(
              failure.stderr,
              /did not restart|OOM-killed and restarted|history since Ready is unknown/,
            );
          } else if (comparable) {
            assert.match(failure.stderr, /gateway container did not restart after it became Ready/);
            assert.doesNotMatch(failure.stderr, /restart history since Ready is unknown/);
          } else {
            assert.match(failure.stderr, /restart history since Ready is unknown/);
            assert.doesNotMatch(failure.stderr, /did not restart|OOM-killed and restarted/);
          }
        }),
      );
    }
    await Promise.all(runs);
  },
);

// Doctor passing proves nothing about a gateway that Kubernetes then evicted, replaced
// or restarted (finding 2736: node memory pressure evicted a gateway after its Doctor
// passed, and the upgrade still reported success). Each case changes the gateway right
// after a passing Doctor, in a state the Kubernetes API returns.
test(
  "a gateway changed after a passing Doctor fails the upgrade and resume checks its replacement",
  { concurrency: true },
  async (t) => {
    const pod = ({
      name = "gateway",
      uid = "gateway-uid",
      phase = "Running",
      ready = true,
    } = {}) => ({
      metadata: { namespace: "tenant", name, uid },
      spec: { containers: [{ name: "gateway", image: runtime }] },
      status: {
        phase,
        conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
        containerStatuses: [{ name: "gateway", restartCount: 0, lastState: {} }],
      },
    });
    // The Deployment's replacement Pod, Ready on the new revision.
    const replacement = pod({ name: "gateway-2", uid: "gateway-2-uid" });
    // The kubelet ends an evicted Pod and keeps it (phase Failed, reason Evicted).
    const evicted = pod({ phase: "Failed", ready: false });
    evicted.status.reason = "Evicted";
    // On the dogfood cluster the evicted gateway ended with phase Succeeded.
    const ended = pod({ phase: "Succeeded", ready: false });
    const cases = [
      ["evicted", { revisionPods: [evicted, replacement] }, /was evicted \(phase Failed\)/],
      ["ended", { revisionPods: [ended, replacement] }, /stopped \(phase Succeeded, reason none\)/],
      ["deleted", { revisionPods: [replacement] }, /no longer exists \(evicted or deleted\)/],
      [
        "replaced under the same name",
        { gatewayAfter: pod({ uid: "gateway-uid-2" }) },
        /was replaced by a new Pod with the same name/,
      ],
      [
        "restarted",
        { gatewayRestarts: 1, gatewayLastReason: "Error" },
        /restarted 1 time\(s\) \(last termination: Error\)/,
      ],
      ["not Ready", { gatewayAfter: pod({ ready: false }) }, /is not Ready/],
    ];
    const runs = [];
    for (const [name, afterDoctor, change] of cases) {
      runs.push(
        t.test(name, async (t) => {
          const f = await fixture(t, { agent: true });
          const state = await f.state();
          state.afterDoctor = afterDoctor;
          await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
          const failure = await f.run().then(
            () => assert.fail("a gateway changed after Doctor must stop the upgrade"),
            (stopped) => stopped,
          );
          assert.match(
            failure.stderr,
            new RegExp(
              `Agent agt_test's gateway Pod tenant/gateway ${change.source} after it became Ready for OpenClaw Doctor\\.`,
            ),
          );
          assert.match(
            failure.stderr,
            /repeat the command with --resume and the same evidence directory/,
          );
          assert.doesNotMatch(failure.stdout, /Upgraded/);
          assert.deepEqual(
            (await f.events()).filter((event) => event.startsWith("doctor ")),
            [doctorCommand(384)],
          );
        }),
      );
    }
    await Promise.all(runs);
    // Resume after the eviction: the ended Pod stays in the API, but the readiness wait
    // ignores it, runs Doctor in the replacement and checks that Pod instead. No new deploy.
    const f = await fixture(t, { agent: true });
    const state = await f.state();
    state.afterDoctor = { revisionPods: [evicted, replacement] };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run(), /did not stay on the same Ready Pod without restarts/);
    const resumed = await f.run("--resume");
    assert.match(resumed.stdout, /Upgraded runtime image/);
    assert.equal((await f.state()).dispatches, 1);
    assert.deepEqual(
      (await f.events()).filter((event) => event.startsWith("doctor ")),
      [doctorCommand(384), doctorCommand(384)],
    );
    const targets = (await readFile(join(f.evidence, "doctor-targets.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      targets.map((target) => target.gatewayName),
      ["gateway-2"],
    );
    // An eviction while Doctor runs kills Doctor (exit 137) without a container restart. The
    // failure must still name the eviction, so it is not read as a Doctor or memory problem.
    const killed = await fixture(t, { agent: true });
    const killedState = await killed.state();
    killedState.afterDoctor = { revisionPods: [evicted, replacement] };
    await writeFile(join(killed.directory, "state.json"), JSON.stringify(killedState));
    await killed.failNext("doctor-evicted");
    const failure = await killed.run().then(
      () => assert.fail("a Doctor killed by an eviction must stop the upgrade"),
      (stopped) => stopped,
    );
    assert.match(failure.stderr, /OpenClaw Doctor was killed \(exit 137\)/);
    assert.match(
      failure.stderr,
      /Agent agt_test's gateway Pod tenant\/gateway was evicted \(phase Failed\) after it became Ready for OpenClaw Doctor\./,
    );
    assert.match(failure.stderr, /OpenClaw Doctor failed for at least one replacement gateway/);
    assert.doesNotMatch(failure.stdout, /Upgraded/);
    // A dedicated Agent serves through its gateway and Codex agent Pods, and the readiness
    // wait requires both. Node memory pressure during the Doctors evicts only the agent Pod
    // (finding 2755): Doctor in the untouched gateway passes, but the upgrade must name the
    // agent Pod instead of reporting success, and resume checks the replacement.
    const agentPod = ({
      name = "agent",
      uid = "agent-uid",
      phase = "Running",
      ready = true,
    } = {}) => ({
      metadata: { namespace: "tenant", name, uid },
      spec: { containers: [{ name: "agent", image: runtime }] },
      status: {
        phase,
        ...(phase === "Failed" ? { reason: "Evicted" } : {}),
        conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
        containerStatuses: [{ name: "agent", restartCount: 0, lastState: {} }],
      },
    });
    const dedicated = await fixture(t, {
      inventoryNamespaces: [
        {
          id: "ns_test",
          status: "ready",
          agents: [
            {
              id: "agt_test",
              status: "active",
              desiredRuntimeState: "running",
              executionMode: "dedicated",
              activeRevisionId: "rev_old",
              deploymentInProgress: false,
            },
          ],
        },
      ],
    });
    const dedicatedState = await dedicated.state();
    dedicatedState.revisionPods = [pod(), agentPod()];
    dedicatedState.afterDoctor = {
      revisionPods: [
        pod(),
        agentPod({ phase: "Failed", ready: false }),
        agentPod({ name: "agent-2", uid: "agent-2-uid" }),
      ],
    };
    await writeFile(join(dedicated.directory, "state.json"), JSON.stringify(dedicatedState));
    const agentFailure = await dedicated.run().then(
      () => assert.fail("an agent Pod evicted during Doctor must stop the upgrade"),
      (stopped) => stopped,
    );
    assert.match(
      agentFailure.stderr,
      /Agent agt_test's agent Pod tenant\/agent was evicted \(phase Failed\) after it became Ready for OpenClaw Doctor\./,
    );
    assert.doesNotMatch(agentFailure.stderr, /gateway Pod tenant\/gateway|OpenClaw Doctor failed/);
    assert.match(agentFailure.stderr, /did not stay on the same Ready Pod without restarts/);
    assert.doesNotMatch(agentFailure.stdout, /Upgraded/);
    const resumedDedicated = await dedicated.run("--resume");
    assert.match(resumedDedicated.stdout, /Upgraded runtime image/);
    assert.equal((await dedicated.state()).dispatches, 1);
    const [dedicatedTarget] = (
      await readFile(join(dedicated.evidence, "doctor-targets.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      dedicatedTarget.revisionPods.map(({ role, name }) => [role, name]),
      [
        ["gateway", "gateway"],
        ["agent", "agent-2"],
      ],
    );
  },
);

// Doctors in several gateways on one node can together exhaust its memory, so they run
// one at a time: each ends before the next gateway's memory check and Doctor start.
test("OpenClaw Doctor runs in one gateway at a time", async (t) => {
  const agent = (id) => ({
    id,
    status: "active",
    desiredRuntimeState: "running",
    executionMode: "embedded",
    activeRevisionId: "rev_old",
    deploymentInProgress: false,
  });
  const f = await fixture(t, {
    inventoryNamespaces: [
      { id: "ns_test", status: "ready", agents: [agent("agt_a"), agent("agt_b"), agent("agt_c")] },
    ],
  });
  const state = await f.state();
  state.doctorSpanMs = 500;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await f.run();
  assert.deepEqual(
    (await f.events()).filter((event) => /^(gateway-memory|doctor)/.test(event)),
    Array(3)
      .fill(["gateway-memory 2048", doctorCommand(384), "doctor-end"])
      .flat(),
  );
});

// Values that would wrap shell arithmetic (a negative deadline or Doctor threshold)
// are refused before any upgrade effect; the largest accepted values still run.
test("upgrade options reject overflowing values before upgrade effects", async (t) => {
  for (const [flag, value, message] of [
    ["--doctor-heap-mib", "9223372036854775168", /must be at most 9223372036854775167/],
    ["--doctor-heap-mib", "9223372036854775808", /must be at most 9223372036854775167/],
    ["--doctor-heap-mib", "18446744073709551616", /must be at most 9223372036854775167/],
    ["--doctor-heap-mib", "9".repeat(100), /must be at most 9223372036854775167/],
    ["--timeout-seconds", "86401", /--timeout-seconds must be at most 86400/],
    ["--timeout-seconds", "9223372036854775807", /--timeout-seconds must be at most 86400/],
  ]) {
    const f = await fixture(t, { agent: true });
    const before = await f.state();
    await assert.rejects(f.run(flag, value), message);
    assert.deepEqual(await f.state(), before);
    assert.deepEqual(await f.events(), []);
    assert.equal(existsSync(f.evidence), false);
  }
  const f = await fixture(t, { agent: true });
  await scriptGatewayMemory(f, ["unlimited"]);
  await f.run("--doctor-heap-mib", "9223372036854775167", "--timeout-seconds", "86400");
  assert.deepEqual(await doctorEvents(f), [
    "gateway-memory unlimited",
    doctorCommand("9223372036854775167"),
  ]);
});

// A Doctor that exhausts its capped heap is named; resume with a larger cap, whose
// memory gate grows with it. Without readable cgroup files Doctor runs with a warning.
test("OpenClaw Doctor that runs out of its heap cap resumes with a larger cap", async (t) => {
  const f = await fixture(t, { agent: true });
  await scriptGatewayMemory(f, ["missing"]);
  await f.failNext("doctor-heap");
  const failure = await f.run().then(
    () => assert.fail("the upgrade must stop when Doctor runs out of heap"),
    (stopped) => stopped,
  );
  assert.match(failure.stderr, /running OpenClaw Doctor without checking its free memory/);
  assert.match(
    failure.stderr,
    /OpenClaw Doctor ran out of its 384 MiB heap in Agent agt_test's gateway\. Repeat the command with --resume and a larger --doctor-heap-mib/,
  );
  assert.deepEqual(await doctorEvents(f), ["gateway-memory missing", doctorCommand(384)]);
  // 1100 MiB is short of one read's 1408 MiB at a 768 MiB cap, so two reads are needed.
  await scriptGatewayMemory(f, [1100, 1100]);
  await f.run("--resume", "--doctor-heap-mib", "768");
  assert.equal((await f.state()).dispatches, 1);
  assert.deepEqual((await doctorEvents(f)).slice(2), [
    "gateway-memory 1100",
    "gateway-memory 1100",
    doctorCommand(768),
  ]);
});

test("resume refuses a pending Helm release or unrelated Secret changes", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run(), injectedFault);
  const state = await f.state();
  state.helmStatus = "pending-upgrade";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run("--resume"), /Helm reports pending-upgrade/);
  state.helmStatus = "deployed";
  state.secret.data.retained = "Y2hhbmdlZA==";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run("--resume"), /Installation Secret identity or unrelated data changed/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test("resume rejects malformed protected inputs before another mutation", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run(), injectedFault);
  const path = join(f.directory, "values.json");
  const original = await readFile(path, "utf8");
  const events = await f.events();
  // Real yq parses these files. An empty document or non-mapping must stop
  // recovery before it tries the candidate alternative or repeats a write.
  for (const content of ["", `${original}\n---\n`, `42\n---\n${original}`]) {
    await writeFile(path, content);
    await assert.rejects(f.run("--resume"), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Cannot compare upgrade YAML:.*only YAML mappings/);
      assert.doesNotMatch(error.stderr, /protected Helm values changed|jq:|Error:/);
      return true;
    });
    assert.deepEqual(await f.events(), events);
  }
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test("resume preserves protected edits when comparison evidence is write-only or unwritable", async (t) => {
  // Root bypasses file permissions; this regression needs an unprivileged owner.
  assert.notEqual(
    process.getuid?.(),
    0,
    "comparison-file permissions require an unprivileged user",
  );
  const f = await fixture(t, { controllerOnly: true });
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run(), injectedFault);
  const path = join(f.directory, "values.json");
  const values = JSON.parse(await readFile(path, "utf8"));
  const changed = JSON.stringify({ ...values, outsideReviewedUpgrade: true });
  await writeFile(path, changed);
  const events = await f.events();
  // Both valid inputs differ. Evidence permissions cannot make them equal or
  // permit recovery to overwrite the operator's protected file.
  for (const mode of [0o600, 0o200, 0o400]) {
    for (const name of ["compare-actual.json", "compare-expected.json"]) {
      const output = join(f.evidence, name);
      await chmod(output, mode);
      if (mode === 0o200) {
        await assert.rejects(readFile(output), { code: "EACCES" });
      }
    }
    await assert.rejects(f.run("--resume"), (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        mode === 0o400 ? /Cannot compare upgrade YAML/ : /protected Helm values changed/,
      );
      assert.doesNotMatch(error.stderr, /jq:|Permission denied/);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), changed);
    assert.deepEqual(await f.events(), events);
  }
});

test("preparation rejects non-mapping candidate documents before protected-setting comparisons", async (t) => {
  for (const name of ["candidate-values.json", "candidate-installation.json"]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { candidates: true, controllerOnly: true });
      const path = join(f.directory, name);
      const content = `${await readFile(path, "utf8")}\n---\n`;
      // Real yq must reject the trailing empty document before a projection
      // misreports it as a protected-setting or Plugin Driver change.
      await writeFile(path, content);
      await assert.rejects(f.run(), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Cannot compare upgrade YAML:.*only YAML mappings/);
        assert.doesNotMatch(error.stderr, /protected setting|Plugin Driver|jq:|Error:/);
        return true;
      });
      assert.equal(await readFile(path, "utf8"), content);
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("reviewed settings survive an interrupted controller upgrade without losing unrelated Secret data", async (t) => {
  const f = await fixture(t, {
    candidates: true,
    pluginDrivers: [{ id: "occ-plugin", configuration: {} }],
    controllerOnly: true,
    repositoryCredentials: true,
    simulatePair: true,
  });
  // The Secret write succeeds, but its client loses the response before Helm.
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run(), injectedFault);
  const interrupted = await f.state();
  const liveInstallation = JSON.parse(
    Buffer.from(interrupted.secret.data["installation.yaml"], "base64").toString(),
  );
  assert.deepEqual(liveInstallation.drivers.plugin, [
    { id: "occ-plugin", configuration: {} },
    { id: "codex-plugin", configuration: { catalogSource: "openai-curated" } },
  ]);
  assert.equal(liveInstallation.drivers.compute.configuration.images.gateway, oldRuntime);
  assert.equal(
    liveInstallation.backend[0].configuration.registryPath,
    "/etc/openclaw/repository-registry/registry.json",
  );
  assert.equal(
    liveInstallation.repository.nativeSender.publicCaPath,
    "/etc/openclaw/repository-ca/ca.crt",
  );
  assert.equal(
    liveInstallation.drivers.compute.configuration.network.repositoryCredentials.port,
    8443,
  );
  assert.equal(interrupted.secret.data.retained, "cHJlc2VydmVk");
  await f.run("--resume");
  const finalState = await f.state();
  const liveValues = JSON.parse(
    (await execute("yq", ["-o=json", ".", join(f.directory, "live-values")])).stdout,
  );
  assert.equal(liveValues.api.channelDirectoryProxyUrl, "http://198.51.100.25:3128");
  assert.equal(liveValues.images.controller, newController);
  assert.equal(liveValues.repositoryCredentials.hostname, "git.system.svc.cluster.local");
  assert.equal(liveValues.controlPlane.installationChecksum, finalState.checksum);
  assert.equal(finalState.secret.metadata.annotations.retained, "yes");
  assert.equal((await f.events()).filter((event) => event === "secret-replaced").length, 1);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  assert.equal(finalState.dispatches, 0);
});

test("stale baseline image fields stop before any writes", { concurrency: true }, async (t) => {
  const cases = [];
  for (const file of ["values", "installation"]) {
    cases.push(
      t.test(file, async (subtest) => {
        const f = await fixture(subtest, { controllerOnly: file === "values" });
        const path = join(f.directory, `${file}.json`);
        const baseline = JSON.parse(await readFile(path, "utf8"));
        if (file === "values") {
          baseline.images.controller = `registry.example.invalid/controller@sha256:${"f".repeat(64)}`;
        } else {
          baseline.drivers.compute.configuration.images.gateway = runtime;
        }
        await writeFile(path, JSON.stringify(baseline));
        await assert.rejects(f.run(), /protected (Helm values|Installation YAML) differ/);
        assert.deepEqual(await f.events(), []);
      }),
    );
  }
  await Promise.all(cases);
});

test("resume refuses altered reviewed candidates before another mutation", async (t) => {
  const f = await fixture(t, { candidates: true });
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run(), injectedFault);
  const path = join(f.directory, "candidate-values.json");
  const candidate = JSON.parse(await readFile(path, "utf8"));
  candidate.api.channelDirectoryProxyUrl = "http://198.51.100.26:3128";
  await writeFile(path, JSON.stringify(candidate));
  await assert.rejects(f.run("--resume"), /reviewed candidate values changed after preparation/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test(
  "resume refuses changed prepared candidate and fleet evidence before another mutation",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const name of ["candidate-values.yaml", "targets.jsonl"]) {
      cases.push(
        t.test(name, async (subtest) => {
          const f = await fixture(subtest);
          await f.failNext("fail-scale-worker");
          await assert.rejects(f.run(), injectedFault);
          const events = await f.events();
          // An interrupted release must use the frozen candidate and Agent inventory.
          await writeFile(join(f.evidence, name), "{}\n");
          await assert.rejects(f.run("--resume"), /prepared upgrade evidence changed/);
          assert.deepEqual(await f.events(), events);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "candidate cannot redirect a mutable Installation Secret or change an image outside the selected flags",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const field of ["secret", "image"]) {
      cases.push(
        t.test(field, async (subtest) => {
          const f = await fixture(subtest, { candidates: true });
          const path = join(
            f.directory,
            field === "secret" ? "candidate-values.json" : "candidate-installation.json",
          );
          const candidate = JSON.parse(await readFile(path, "utf8"));
          if (field === "secret") {
            candidate.installation.secretName = "other-installation";
          } else {
            candidate.drivers.compute.configuration.images.agent = runtime;
          }
          await writeFile(path, JSON.stringify(candidate));
          await assert.rejects(
            f.run(),
            field === "secret"
              ? /switching the Installation reference requires an immutable predecessor/
              : /candidate Installation change/,
          );
          assert.deepEqual(await f.events(), []);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "candidate cannot change repository identity, grants, trust, or the Compute peer",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const change of [
      "registry",
      "driver",
      "duration",
      "peer",
      "compute-authentication",
      "remove",
      "add",
    ]) {
      cases.push(
        t.test(change, async (subtest) => {
          const f = await fixture(subtest, {
            candidates: true,
            repositoryCredentials: change !== "add",
          });
          const path = join(f.directory, "candidate-installation.json");
          const candidate = JSON.parse(await readFile(path, "utf8"));
          // These inputs select a registry, grant authority, TLS trust, and the
          // credential service's network peer; no upgrade mutation may follow drift.
          if (change === "registry") {
            candidate.backend[0].configuration.registryPath = "/etc/other/registry.json";
          } else if (change === "driver") {
            candidate.repository.nativeSender.publicCaPath = "/etc/other/ca.crt";
          } else if (change === "duration") {
            candidate.repository.configuration.sessionDurationSeconds = 3600;
          } else if (change === "peer") {
            candidate.drivers.compute.configuration.network.repositoryCredentials.podLabels[
              "app.kubernetes.io/component"
            ] = "other";
          } else if (change === "compute-authentication") {
            candidate.drivers.compute.configuration.authentication = {
              mode: "kubeconfig",
              kubeconfigPath: "/etc/other/kubeconfig",
              context: "other",
            };
          } else if (change === "remove") {
            delete candidate.repository;
            delete candidate.backend;
          } else {
            candidate.repository = { id: "repository-credentials", configuration: {} };
            candidate.backend = [
              {
                id: "github-primary",
                type: "github",
                configuration: { registryPath: "/etc/other/registry.json" },
                drivers: { repo: "repository-credentials" },
              },
            ];
          }
          await writeFile(path, JSON.stringify(candidate));
          await assert.rejects(f.run(), /candidate Installation changes/);
          assert.deepEqual(await f.events(), []);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "candidate cannot change cluster credentials or other protected trust settings",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const change of [
      "execution-kubeconfig",
      "gateway-routing",
      "chatgpt-secret",
      "service-principal",
      "trusted-proxy",
      "configuration-authentication",
      "plugin-executable",
      "plugin-hosted",
      "plugin-null",
      "plugin-add-occ",
      "unreviewed-values",
    ]) {
      cases.push(
        t.test(change, async (subtest) => {
          const f = await fixture(subtest, { candidates: true, controllerOnly: true });
          const valuesPath = join(f.directory, "candidate-values.json");
          const installationPath = join(f.directory, "candidate-installation.json");
          const values = JSON.parse(await readFile(valuesPath, "utf8"));
          const installation = JSON.parse(await readFile(installationPath, "utf8"));
          // Each candidate redirects an identity or trust boundary while retaining
          // the supported proxy and catalog changes; preparation must stop first.
          if (change === "execution-kubeconfig") {
            values.executionCluster = {
              enabled: true,
              apiKubeconfigSecretName: "other-api",
              workerKubeconfigSecretName: "other-worker",
              apiCidrs: ["198.51.100.0/24"],
            };
          } else if (change === "gateway-routing") {
            values.gatewayRouting = { enabled: true, apiKeySecretName: "other-routing-key" };
          } else if (change === "chatgpt-secret") {
            values.backend = { chatgpt: { enabled: true, secretName: "other-chatgpt" } };
          } else if (change === "service-principal") {
            installation.drivers.compute.configuration.servicePrincipalCredentials = {
              mode: "projectedServiceAccountToken",
              audience: "other-audience",
              expirationSeconds: 900,
            };
          } else if (change === "trusted-proxy") {
            installation.drivers.compute.configuration.network = {
              gatewayTrustedProxyCidrs: ["198.51.100.0/24"],
            };
          } else if (change === "configuration-authentication") {
            installation.drivers.configuration = {
              id: "config-kubernetes",
              configuration: {
                authentication: {
                  mode: "kubeconfig",
                  kubeconfigPath: "/etc/other",
                  context: "other",
                },
              },
            };
          } else if (change === "plugin-executable") {
            installation.drivers.plugin[0].configuration.codexExecutable = "/etc/other/codex";
          } else if (change === "plugin-hosted") {
            installation.drivers.plugin[0].configuration.catalogSource = "hosted";
          } else if (change === "plugin-add-occ") {
            installation.drivers.plugin.push({ id: "occ-plugin", configuration: {} });
          } else if (change === "plugin-null") {
            installation.drivers.plugin = null;
          } else {
            values.controlPlane = { extraSetting: true };
          }
          await writeFile(valuesPath, JSON.stringify(values));
          await writeFile(installationPath, JSON.stringify(installation));
          await assert.rejects(f.run(), /candidate (values|Installation) change/);
          assert.deepEqual(await f.events(), []);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "repository-enabled upgrades require both image selections before mutation",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const controllerOnly of [true, false]) {
      cases.push(
        t.test(controllerOnly ? "controller release" : "runtime release", async (subtest) => {
          const f = await fixture(subtest, { repositoryCredentials: true, controllerOnly });
          // Either release restarts the worker and broker, so neither may reuse an unverified pair.
          await assert.rejects(f.run(), /require explicit controller and broker image selections/);
          assert.deepEqual(await f.events(), []);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test("broker image selection requires an enabled broker before mutation", async (t) => {
  const f = await fixture(t, { controllerOnly: true });
  const broker = `registry.example.invalid/broker@sha256:${"f".repeat(64)}`;
  await assert.rejects(
    f.run("--broker-image", broker),
    /requires repository credentials to be enabled/,
  );
  assert.deepEqual(await f.events(), []);
});

test("an unchecked repository image pair cannot start an upgrade", async (t) => {
  const f = await fixture(t, { repositoryCredentials: true, controllerOnly: true });
  const broker = `registry.example.invalid/broker@sha256:${"f".repeat(64)}`;
  // Selecting digests alone does not establish their admission compatibility.
  await assert.rejects(f.run("--broker-image", broker), /failed compatibility qualification/);
  assert.deepEqual(await f.events(), []);
});

// Twelve stranded Agents list ten plus "and 2 more"; exactly ten list all of them, with no
// "and N more" line.
for (const count of [12, 10]) {
  test(`${count} running Agents without an active revision are named with their remedy before mutation`, async (t) => {
    const agent = (id, fields = {}) => ({
      id,
      status: "active",
      desiredRuntimeState: "running",
      executionMode: "dedicated",
      deploymentInProgress: false,
      ...fields,
    });
    const stranded = Array.from({ length: count }, (_, index) => `agt_stranded_${index + 1}`);
    const f = await fixture(t, {
      inventoryNamespaces: [
        {
          id: "ns_alpha",
          status: "ready",
          agents: [
            agent("agt_healthy", { activeRevisionId: "rev_old" }),
            agent("agt_stopped", { desiredRuntimeState: "stopped" }),
            ...stranded.slice(0, 2).map((id) => agent(id)),
          ],
        },
        { id: "ns_beta", status: "ready", agents: stranded.slice(2).map((id) => agent(id)) },
      ],
      // agt_stranded_2 and ns_beta have no readable name, and agt_stranded_3's is not a string;
      // agt_stranded_1's name carries a quote, a newline, DEL, and a C1 control.
      names: {
        ns_alpha: "Team Alpha",
        agt_stranded_1: 'Mail "triage"\nbot\u007f\u009b',
        agt_stranded_3: 42,
      },
    });
    const failure = await f.run().then(
      () => assert.fail("the upgrade must refuse"),
      (error) => error,
    );
    const lines = failure.stderr.trimEnd().split("\n");
    assert.deepEqual(lines, [
      "upgrade-production-images: the deployment inventory contains a running Agent without an active revision; resolve its initial deployment first. No cluster changes were made.",
      '  - Agent agt_stranded_1 "Mail \\"triage\\"\\nbot\\u007f?" in Namespace ns_alpha "Team Alpha"',
      '  - Agent agt_stranded_2 (name unavailable) in Namespace ns_alpha "Team Alpha"',
      ...stranded
        .slice(2, 10)
        .map((id) => `  - Agent ${id} (name unavailable) in Namespace ns_beta (name unavailable)`),
      ...(count > 10
        ? [
            `  - and ${count - 10} more; see ${join(f.evidence, "inventory/deployment-inventory.json")}`,
          ]
        : []),
      "Stop or delete each running Agent without an active revision (occ --namespace NAMESPACE_ID agent stop AGENT_ID), or deploy it until it succeeds (occ --namespace NAMESPACE_ID agent deploy AGENT_ID), then start again with a new evidence directory. See docs/guides/deploy/production-upgrade.md#upgrade-agent-runtimes.",
    ]);
    // Only name reads: one per listed Agent and one per Namespace, nothing beyond the first ten.
    assert.deepEqual(await f.events(), [
      "read ns_alpha",
      "read agt_stranded_1",
      "read agt_stranded_2",
      "read ns_beta",
      ...stranded.slice(2, 10).map((id) => `read ${id}`),
    ]);
    assert.equal((await f.state()).dispatches, 0);
  });
}

test("a changed eligible node stops the upgrade before mutation", async (t) => {
  const f = await fixture(t, {
    agent: true,
    repositoryCredentials: true,
    simulatePair: true,
  });
  // Replace the selected node between preparation and the mutation boundary.
  await f.failNext("change-node");
  await assert.rejects(f.run(), /eligible control-plane nodes changed/);
  assert.deepEqual(await f.events(), []);
});

const capabilityProbe = (dispatches) => ({
  dispatches,
  requests: [{ method: "GET", path: "/v1/capabilities", body: "" }],
});

test(
  "deployed pair verification stops before Agent dispatch on failure",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const scenario of [
      { flag: "wrong-broker-identity", error: /deployed worker identity does not match/ },
      { flag: "fail-capability", error: /deployed controller cannot verify repository admission/ },
    ]) {
      cases.push(
        t.test(scenario.flag, async (subtest) => {
          const f = await fixture(subtest, {
            agent: true,
            repositoryCredentials: true,
            simulatePair: true,
          });
          // Helm has completed, but an unqualified Pod must not receive Agent work.
          await f.failNext(scenario.flag);
          await assert.rejects(f.run(), scenario.error);
          assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
          assert.equal((await f.state()).dispatches, 0);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "controller upgrade verifies worker placement with and without a repository broker",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const scenario of [
      { name: "broker disabled", repositoryCredentials: false, workerPlacement: "container" },
      {
        name: "broker enabled with existing chart",
        repositoryCredentials: true,
        workerPlacement: "container",
      },
      {
        name: "broker enabled with restartable worker",
        repositoryCredentials: true,
        workerPlacement: "restartable",
      },
    ]) {
      cases.push(
        t.test(scenario.name, async (subtest) => {
          const f = await fixture(subtest, {
            ...scenario,
            controllerOnly: true,
            simulatePair: scenario.repositoryCredentials,
          });
          const result = await f.run();
          assert.match(
            result.stdout,
            /Upgraded controller image; no Agent deployments were requested/,
          );
          assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
          assert.equal((await f.state()).controller, newController);
          assert.deepEqual(
            (await f.state()).capabilityProbes,
            scenario.repositoryCredentials ? [capabilityProbe(0), capabilityProbe(0)] : [],
          );
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "deployed capability gates Agent dispatch and completion",
  { concurrency: true },
  async (t) => {
    await Promise.all(
      [
        {
          name: "old before dispatch",
          replies: [{ status: 200, body: '{"durableAdmissionVersion":0}' }],
          dispatches: 0,
          failure: /deployed controller cannot verify repository admission capability\./,
        },
        {
          name: "denied at completion",
          replies: [readyCapability, { status: 403, body: "{}" }],
          dispatches: 1,
          failure:
            /deployed controller cannot verify repository admission capability at completion/,
        },
      ].map((scenario) =>
        t.test(scenario.name, async (subtest) => {
          const f = await fixture(subtest, {
            agent: true,
            repositoryCredentials: true,
            simulatePair: true,
            capabilityReplies: scenario.replies,
          });
          await assert.rejects(f.run(), (error) => {
            // The sender translates the Unix client's refusal; a direct-client bypass does not.
            assert.match(
              error.stderr,
              /DependencyUnavailableError: Repository credential control is unavailable\./,
            );
            assert.match(error.stderr, scenario.failure);
            return true;
          });
          const state = await f.state();
          assert.equal(state.dispatches, scenario.dispatches);
          // The second read follows the sole dispatch; a refusal cannot report completion.
          assert.deepEqual(
            state.capabilityProbes,
            scenario.dispatches === 0
              ? [capabilityProbe(0)]
              : [capabilityProbe(0), capabilityProbe(1)],
          );
        }),
      ),
    );
  },
);

test(
  "controller upgrade rejects missing, ambiguous, or invalid worker placement",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const scenario of [
      { name: "missing worker", repositoryCredentials: true, workerPlacement: "missing" },
      { name: "duplicate worker", repositoryCredentials: true, workerPlacement: "ambiguous" },
      {
        name: "nonrestartable worker",
        repositoryCredentials: true,
        workerPlacement: "nonrestartable",
      },
      {
        name: "init worker without broker",
        repositoryCredentials: false,
        workerPlacement: "restartable",
      },
      {
        name: "wrong worker image",
        repositoryCredentials: true,
        workerPlacement: "restartable",
        wrongImage: true,
      },
    ]) {
      cases.push(
        t.test(scenario.name, async (subtest) => {
          const f = await fixture(subtest, {
            ...scenario,
            controllerOnly: true,
            simulatePair: scenario.repositoryCredentials,
          });
          if (scenario.wrongImage) {
            const state = await f.state();
            state.workerObservedImage = oldRuntime;
            await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
          }
          // A malformed or unexpected Deployment must not be reported as a
          // successful controller rollout, even if the Helm request completed.
          await assert.rejects(f.run(), /exactly one worker with the selected controller image/);
          assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test("a stale bundled Collector config Secret stops the upgrade before mutation", async (t) => {
  const f = await fixture(t, { controllerOnly: true, collector: "stale" });
  await assert.rejects(
    f.run(),
    /Collector config Secret occ-demo-collector-config differs from this checkout's deploy\/logging \(collector\.yaml,kubernetes\.yaml\); refresh it/,
  );
  assert.deepEqual(await f.events(), []);
  assert.equal((await f.state()).controller, controller);
});

test("a missing bundled Collector config Secret stops the upgrade before mutation", async (t) => {
  const f = await fixture(t, { controllerOnly: true, collector: "missing" });
  await assert.rejects(
    f.run(),
    /cannot read the Collector config Secret occ-demo-collector-config/,
  );
  assert.deepEqual(await f.events(), []);
});

test(
  "a current or explicitly reviewed Collector config Secret lets the upgrade proceed",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const [collector, extra] of [
      ["current", []],
      ["stale", ["--collector-config-reviewed"]],
    ]) {
      cases.push(
        t.test(`${collector} ${extra.join(" ")}`.trim(), async (subtest) => {
          const f = await fixture(subtest, { controllerOnly: true, collector });
          await f.run(...extra);
          assert.equal((await f.state()).controller, newController);
          const drift = (await readFile(join(f.evidence, "collector-config-drift"), "utf8")).trim();
          assert.equal(drift, collector === "stale" ? "collector.yaml\nkubernetes.yaml" : "");
        }),
      );
    }
    await Promise.all(cases);
  },
);

// A startup preflight refusal stops the upgrade before quiescence: both writers keep the
// old release, nothing migrates, and the temporary preflight resources are removed.
async function assertStoppedBeforeWriters(f) {
  const state = await f.state();
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.jobs, {});
  assert.deepEqual(state.preflight.networkpolicies, {});
  return state;
}

test(
  "the image-upgrade startup preflight validates the API's mounted theme before stopping writers",
  { concurrency: true },
  async (t) => {
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
      return;
    }
    const runs = [];
    for (const [name, theme, failure] of [
      [
        "valid",
        { schemaVersion: 1, displayName: "Example Console", colors: { accent: "#2457C5" } },
        null,
      ],
      [
        "invalid color",
        { schemaVersion: 1, colors: { accent: "blue" } },
        /colors must use supported roles/,
      ],
      [
        "missing image",
        { schemaVersion: 1, logo: "missing.png" },
        /cannot read the configured bundle/,
      ],
    ]) {
      runs.push(
        t.test(name, async (t) => {
          const themeName = "console-theme-reviewed";
          const f = await fixture(t, {
            controllerOnly: true,
            chart: {
              values: (values) => ({
                ...values,
                api: { ...values.api, consoleTheme: { configMapName: themeName } },
              }),
              installation: (installation) => installation,
              configMaps: { [themeName]: { data: { "theme.json": JSON.stringify(theme) } } },
            },
          });
          // Helm renders the real theme mount. The generated Pod command runs real source
          // loaders against actual files; only external cluster command protocols are fixtures.
          if (failure) {
            await assert.rejects(
              f.run("--preflight-only"),
              (error) =>
                /the selected controller image cannot start the api with the candidate Installation:/.test(
                  error.stderr,
                ) &&
                /No OCC writer was stopped/.test(error.stderr) &&
                failure.test(error.stderr),
            );
            const state = await assertStoppedBeforeWriters(f);
            assert.deepEqual(
              state.preflight.deleted.map((resource) => resource.split("/")[0]).sort(),
              ["job.batch", "job.batch", "networkpolicy.networking.k8s.io", "secret"],
            );
            assert.match(await readFile(join(f.evidence, "preflight-api.log"), "utf8"), failure);
            assert.match(
              await readFile(join(f.evidence, "preflight-worker.log"), "utf8"),
              /installation-startup-ready/,
            );
          } else {
            const result = await f.run("--preflight-only");
            assert.match(result.stdout, /preflight/i);
            await assertStoppedBeforeWriters(f);
          }
        }),
      );
    }
    await Promise.all(runs);
  },
);

// The 2026-09-28 release example offered DevDay Presets through presets.files; later
// images no longer ship those files (finding 436). The selected controller image must
// reject that Installation before quiescence, so the old release keeps serving.
test("an Installation the selected controller image cannot load stops before any writer stops", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: {
      installation: (installation) => ({
        ...installation,
        presets: { includeDefaults: true, files: ["/app/deploy/presets/devday.json"] },
      }),
    },
  });
  await assert.rejects(f.run(), (error) =>
    /cannot start the api with the candidate Installation: .*Preset file \/app\/deploy\/presets\/devday\.json is unavailable\..*No OCC writer was stopped/s.test(
      error.stderr,
    ),
  );
  // The temporary NetworkPolicy, Secret and both Pods are removed after the refusal.
  const state = await assertStoppedBeforeWriters(f);
  // Both components fail the same way, and both logs are saved (finding 447).
  for (const component of ["api", "worker"]) {
    assert.match(
      await readFile(join(f.evidence, `preflight-${component}.log`), "utf8"),
      /Preset file \/app\/deploy\/presets\/devday\.json is unavailable\./,
    );
  }
  assert.deepEqual(state.preflight.deleted.map((resource) => resource.split("/")[0]).sort(), [
    "job.batch",
    "job.batch",
    "networkpolicy.networking.k8s.io",
    "secret",
  ]);
});

test("a Driver refusal preserves field diagnostics before upgrade quiescence", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: {
      installation: (installation) => {
        installation.drivers.compute.configuration.runtime.gatewayStorageClassName = "Bad_Class";
        return installation;
      },
    },
  });
  await assert.rejects(f.run(), (error) => {
    assert.match(
      error.stderr,
      /cannot start the api with the candidate Installation: .*DRIVER_CONFIGURATION_INVALID.*No OCC writer was stopped/s,
    );
    assert.doesNotMatch(error.stderr, /Bad_Class/);
    return true;
  });
  await assertStoppedBeforeWriters(f);
  for (const component of ["api", "worker"]) {
    const log = await readFile(join(f.evidence, `preflight-${component}.log`), "utf8");
    const line = log.split("\n").find((line) => line.startsWith("DRIVER_CONFIGURATION_INVALID: "));
    assert.ok(line, log);
    assert.deepEqual(JSON.parse(line.slice("DRIVER_CONFIGURATION_INVALID: ".length)), [
      {
        path: "/runtime/gatewayStorageClassName",
        code: "INVALID_FORMAT",
        message:
          "SQLite-compatible gateway storage class must be a DNS-safe Kubernetes resource name.",
      },
    ]);
  }
});

// The API and worker read the stored Installation name from the database and refuse
// one that breaks the Name rule (INSTALLATION_NAME_INVALID). The preflight Pods check
// the name OCC returns with the selected image's rule, so the refusal comes before any
// writer stops instead of after (dogfood D525). The Pod carries the stored name as JSON,
// so a trailing no-break space survives and a line break (a control character) gets the
// same refusal rather than a parse failure. Each case reads a different component's Pod.
for (const [name, installationName, component, ...flags] of [
  [
    "a stored Installation name that breaks the Name rule stops before any writer stops",
    "Production\u00a0",
    "api",
  ],
  [
    "preflight-only refuses a stored Installation name with a line break",
    "Production\n",
    "worker",
    "--preflight-only",
  ],
]) {
  test(name, async (t) => {
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      installationName,
      chart: { installation: (installation) => installation },
    });
    await assert.rejects(f.run(...flags), (error) => {
      for (const stopped of ["api", "worker"]) {
        assert.match(
          error.stderr,
          new RegExp(
            `the ${stopped} startup preflight stopped: The stored Installation name breaks the Name rule: 1 to 200 characters, .*\\. \\(INSTALLATION_NAME_INVALID\\) No OCC writer was stopped; the old release keeps serving\\. Rename the Installation as in docs/guides/deploy/production-upgrade-recovery\\.md#correct-an-invalid-installation-name`,
          ),
        );
      }
      return true;
    });
    await assertStoppedBeforeWriters(f);
    const pod = JSON.parse(
      await readFile(join(f.evidence, `preflight-${component}-job.json`), "utf8"),
    ).spec.template;
    assert.deepEqual(
      pod.spec.containers[0].env.find(
        (variable) => variable.name === "OCC_UPGRADE_PREFLIGHT_INSTALLATION_NAME",
      ),
      { name: "OCC_UPGRADE_PREFLIGHT_INSTALLATION_NAME", value: JSON.stringify(installationName) },
    );
  });
}

// An OCC that returns no stored name cannot be checked, so the upgrade stops while
// building the first preflight Pod, before it creates one or stops a writer.
test("an Installation read without a stored name stops before any preflight Pod", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    installationName: null,
    chart: { installation: (installation) => installation },
  });
  await assert.rejects(f.run(), (error) => {
    assert.match(
      error.stderr,
      /upgrade-startup-preflight: OCC did not return the stored Installation name\./,
    );
    assert.match(
      error.stderr,
      /cannot build the api startup preflight Job from the rendered chart; no OCC writer was stopped\./,
    );
    return true;
  });
  // Only the NetworkPolicy and Secret were created, and both are removed again.
  const state = await assertStoppedBeforeWriters(f);
  assert.deepEqual(state.preflight.deleted.map((resource) => resource.split("/")[0]).sort(), [
    "networkpolicy.networking.k8s.io",
    "secret",
  ]);
});

// Releases with the shared tenant namespace refuse to start on a single-cluster
// Installation that still has split-layout Gateway storage. The startup preflight
// runs that Compute check with the selected image before quiescence, so the old
// release keeps serving and the operator is pointed at the documented options.
test("split-layout Gateway storage stops the startup preflight before any writer stops", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const namespaceId = "ns_split_00000000-0000-4000-8000-000000000001";
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    kubernetesNamespaces: [
      {
        metadata: {
          name: kubernetesGatewayNamespaceName(namespaceId),
          labels: { "openclaw.dev/gateway-namespace": namespaceId },
        },
      },
    ],
  });
  await assert.rejects(f.run(), (error) => {
    for (const component of ["api", "worker"]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight refused the candidate release: Existing split-layout Gateway storage prevents this single-cluster upgrade\\..* No OCC writer was stopped; the old release keeps serving\\. See docs/reference/drivers/kubernetes-compute\\.md#existing-split-layout-installations\\.`,
        ),
      );
    }
    return true;
  });
  // Each Pod read the Namespaces itself; nothing was stopped or migrated.
  assert.equal(f.kubernetesReads.filter((path) => path === "/api/v1/namespaces").length, 2);
  const state = await f.state();
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.jobs, {});
  assert.deepEqual(state.preflight.networkpolicies, {});
});

// A Kubernetes API the preflight Pod cannot use is not a refusal of the release:
// the helper says so, names the access the Pod had, and still stops first.
test("a denied Kubernetes API stops the startup preflight as incomplete", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    kubernetesDenied: true,
  });
  await assert.rejects(f.run(), (error) => {
    for (const component of ["api", "worker"]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight could not complete: .* No OCC writer was stopped; the old release keeps serving\\. The Pod uses the installed release's service account and RBAC`,
        ),
      );
    }
    assert.doesNotMatch(error.stderr, /refused the candidate release|split-layout/);
    return true;
  });
  const state = await f.state();
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.jobs, {});
  assert.deepEqual(state.preflight.networkpolicies, {});
});

// Two-cluster tenant grants in the execution stand-in. Both preflight Pods share
// one kubeconfig there, so a grant set is the union of the API and worker roles.
const tenantNamespaces = ["oce-unbound", "oce-tenant"].map((name) => ({
  metadata: { name, labels: { "openclaw.dev/namespace": `ns_${name}` } },
}));
const rule = (attributes) =>
  [
    attributes.group || "core",
    attributes.verb,
    attributes.resource + (attributes.subresource ? `/${attributes.subresource}` : ""),
  ].join(" ");
// The openclaw-execution release-era tenant roles: API Deployment lists; worker Pod
// reads and proxy reads (plus writes the check never asks about).
const releaseTenantRules = [
  "apps list deployments",
  "core get pods",
  "core list pods",
  "core get pods/proxy",
];
// Bootstrap Jobs use the batch API even when runtime log access is disabled.
const currentWorkerRules = [
  "core patch pods",
  "batch get jobs",
  "batch create jobs",
  "batch delete jobs",
];
const currentTenantRules = [
  ...releaseTenantRules,
  ...currentWorkerRules,
  "core get pods/log",
  "core get events",
  "core list events",
];
// oce-unbound has no tenant RoleBinding, so nothing is allowed there.
const tenantGrants = (rules) => (attributes) =>
  attributes.namespace === "oce-tenant" && rules.includes(rule(attributes));

// The execution chart is a separate Helm release that the helper does not upgrade.
// Each startup preflight Pod asks the execution cluster, as its own identity, for
// the tenant rules this release needs, so a chart left at the release-era grants
// stops the upgrade before any writer stops and names the documented step.
test("a two-cluster execution chart without the new tenant grants stops the startup preflight", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    executionCluster: { namespaces: tenantNamespaces, allows: tenantGrants(releaseTenantRules) },
  });
  await assert.rejects(f.run(), (error) => {
    for (const [component, missing] of [
      ["api", "get pods/log, get events, list events"],
      ["worker", "patch pods, get jobs, create jobs, delete jobs"],
    ]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight refused the candidate release: The execution cluster's tenant ${component} grant in Namespace oce-tenant lacks ${missing}\\. Upgrade the openclaw-execution chart before this release\\. No OCC writer was stopped; the old release keeps serving\\. Upgrade the execution release as in docs/testing/kubernetes\\.md#upgrade-the-execution-chart`,
        ),
      );
    }
    return true;
  });
  // The unbound tenant Namespace was skipped after its baseline review.
  assert.deepEqual(
    f.accessReviews
      .filter((review) => review.namespace === "oce-unbound")
      .map(rule)
      .sort(),
    ["apps list deployments", "core get pods"],
  );
  await assertStoppedBeforeWriters(f);
});

test("a two-cluster execution chart with the new tenant grants passes the startup preflight", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    executionCluster: { namespaces: tenantNamespaces, allows: tenantGrants(currentTenantRules) },
  });
  await f.run();
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
  // Each component asked for its own new rules in the bound tenant Namespace.
  assert.deepEqual(
    f.accessReviews
      .filter((review) => review.namespace === "oce-tenant")
      .map(rule)
      .sort(),
    [
      "apps list deployments",
      "batch create jobs",
      "batch delete jobs",
      "batch get jobs",
      "core get events",
      "core get pods",
      "core get pods",
      "core get pods/log",
      "core get pods/proxy",
      "core list events",
      "core list pods",
      "core patch pods",
    ],
  );
  assert.ok(f.executionReads.includes("/api/v1/namespaces/kube-system"));
});

// An execution authorizer that cannot evaluate the reviews leaves the check incomplete:
// the helper says which kubeconfig and access the Pod needed, and still stops first.
test("an unevaluated two-cluster tenant grant review stops the startup preflight as incomplete", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    executionCluster: {
      namespaces: tenantNamespaces,
      allows: () => ({ allowed: false, evaluationError: "webhook authorizer unavailable" }),
    },
  });
  await assert.rejects(f.run(), (error) => {
    for (const component of ["api", "worker"]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight could not complete: The execution cluster tenant grant review failed: could not evaluate .* in Namespace oce-unbound: webhook authorizer unavailable No OCC writer was stopped; the old release keeps serving\\. The Pod used its execution cluster kubeconfig, which must list Namespaces and create SelfSubjectAccessReviews there`,
        ),
      );
    }
    assert.doesNotMatch(error.stderr, /refused the candidate release|openclaw-execution chart/);
    return true;
  });
  await assertStoppedBeforeWriters(f);
});

// With runtime logs off, the release's tenant API role carries no log or Event reads, so
// the preflight asks only for the rules that release needs.
test("a two-cluster upgrade with runtime logs off needs no log grants in the execution chart", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: {
      installation: (installation) => installation,
      values: (values) => ({ ...values, agentRuntimeLogs: { enabled: false } }),
    },
    executionCluster: {
      namespaces: tenantNamespaces,
      allows: tenantGrants([...releaseTenantRules, ...currentWorkerRules]),
    },
  });
  await f.run();
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
  assert.deepEqual(
    f.accessReviews
      .filter((review) => review.namespace === "oce-tenant")
      .map(rule)
      .sort(),
    [
      "apps list deployments",
      "batch create jobs",
      "batch delete jobs",
      "batch get jobs",
      "core get pods",
      "core get pods",
      "core get pods/proxy",
      "core list pods",
      "core patch pods",
    ],
  );
});

// The helper waits for every preflight Pod and saves its status and log before it
// reports, so a refusal names each failing component, not only the first.
test("a failed startup preflight reports and saves every component before cleanup", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightResults: {
      api: {
        status: {
          phase: "Pending",
          containerStatuses: [{ name: "api", state: { waiting: { reason: "ImagePullBackOff" } } }],
        },
      },
      worker: { phase: "Failed", log: "loading drivers\nworker cannot load the Installation\n" },
    },
  });
  await assert.rejects(f.run(), (error) => {
    assert.match(
      error.stderr,
      /the api startup preflight Pod cannot start \(ImagePullBackOff\); no OCC writer was stopped\./,
    );
    assert.match(
      error.stderr,
      /cannot start the worker with the candidate Installation: loading drivers worker cannot load the Installation No OCC writer was stopped/,
    );
    return true;
  });
  const status = JSON.parse(await readFile(join(f.evidence, "preflight-api-status.json"), "utf8"));
  assert.equal(status.status.containerStatuses[0].state.waiting.reason, "ImagePullBackOff");
  assert.match(await readFile(join(f.evidence, "preflight-api.log"), "utf8"), /waiting to start/);
  assert.equal(
    JSON.parse(await readFile(join(f.evidence, "preflight-worker-status.json"), "utf8")).status
      .phase,
    "Failed",
  );
  assert.equal(
    await readFile(join(f.evidence, "preflight-worker.log"), "utf8"),
    "loading drivers\nworker cannot load the Installation\n",
  );
  const state = await f.state();
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.jobs, {});
  assert.deepEqual(state.preflight.deleted.map((resource) => resource.split("/")[0]).sort(), [
    "job.batch",
    "job.batch",
    "secret",
  ]);
});

// Bash must not remove a NUL and turn malformed output into the literal ready marker.
test("startup preflight rejects a ready marker containing a NUL byte", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightResults: {
      api: { phase: "Succeeded", log: "installation-startup-\0ready\n" },
    },
  });
  await assert.rejects(f.run("--preflight-only"), /cannot read the api startup preflight logs/);
  assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
  await assertStoppedBeforeWriters(f);
});

test("a preflight Pod that outlives the timeout does not hide another component's failure", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightResults: {
      api: {
        status: {
          phase: "Pending",
          conditions: [
            {
              type: "PodScheduled",
              status: "False",
              reason: "Unschedulable",
              message: "0/3 nodes are available",
            },
          ],
        },
      },
      worker: { phase: "Failed", log: "worker cannot load the Installation\n" },
    },
  });
  await assert.rejects(f.run("--timeout-seconds", "3"), (error) => {
    assert.match(
      error.stderr,
      /the api startup preflight did not finish before the timeout \(Unschedulable: 0\/3 nodes are available\)/,
    );
    assert.match(error.stderr, /cannot start the worker with the candidate Installation/);
    return true;
  });
  assert.equal(
    await readFile(join(f.evidence, "preflight-worker.log"), "utf8"),
    "worker cannot load the Installation\n",
  );
  const state = await f.state();
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.jobs, {});
});

test("an Installation the selected controller image loads passes the preflight and upgrades", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  // Truncating this valid release at 29 characters leaves a dot; derived Job
  // names must still meet Kubernetes admission rules after their suffix is added.
  const release = `${"a".repeat(28)}.b`;
  const f = await fixture(t, {
    controllerOnly: true,
    release,
    // A 200-character name: if Kubernetes expanded $(OCC_CONFIG_PATH) in the Pod's
    // environment, the preflight would see a longer name and refuse it.
    installationName: `${"A".repeat(182)}$(OCC_CONFIG_PATH)`,
    chart: { installation: (installation) => installation },
  });
  await f.run("--timeout-seconds", "60");
  const state = await f.state();
  assert.equal(state.controller, newController);
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.jobs, {});
  const jobs = state.preflight.created.filter((resource) => resource.kind === "job.batch");
  assert.equal(jobs.length, 2);
  for (const { name } of jobs) {
    assert.ok(name.length <= 63, "Kubernetes Job names cannot exceed 63 characters");
    assert.match(name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
    assert.ok(state.preflight.deleted.includes(`job.batch/${name}`));
  }
  const secret = state.preflight.created.find((resource) => resource.kind === "secret");
  assert.ok(secret.name.startsWith(`${release}-upgrade-preflight-`));
  const job = JSON.parse(await readFile(join(f.evidence, "preflight-worker-job.json"), "utf8"));
  const pod = job.spec.template;
  assert.equal(job.apiVersion, "batch/v1");
  assert.equal(job.kind, "Job");
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.parallelism, 1);
  assert.equal(job.spec.completions, 1);
  assert.equal(job.spec.activeDeadlineSeconds, 60);
  assert.equal(pod.spec.restartPolicy, "Never");
  // The Pod runs the selected image with the chart's service account and Installation mount.
  assert.equal(pod.spec.containers[0].image, newController);
  assert.equal(pod.spec.serviceAccountName, "openclaw-enterprise-worker");
  assert.equal(
    pod.spec.volumes.find((volume) => volume.name === "installation-startup").secret.secretName,
    state.preflight.deleted
      .find((resource) => resource.startsWith("secret/"))
      .slice("secret/".length),
  );
  // Both Pods ran Kubernetes Compute preflight on this shared-layout state.
  for (const component of ["api", "worker"]) {
    const log = await readFile(join(f.evidence, `preflight-${component}.log`), "utf8");
    assert.match(log, /^kubernetes-compute-preflight-passed$/m);
    assert.match(log, /^installation-startup-ready$/m);
  }
  assert.equal(f.kubernetesReads.filter((path) => path === "/api/v1/namespaces").length, 2);
  // The chart's default-deny policy selects the preflight Pods too. The temporary
  // policy selects exactly them and grants the candidate's dependency egress.
  const policy = JSON.parse(
    await readFile(join(f.evidence, "preflight-networkpolicy.json"), "utf8"),
  );
  assert.deepEqual(policy.spec.podSelector.matchLabels, pod.metadata.labels);
  const rendered = (await readFile(join(f.evidence, "preflight-rendered.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const initialization = rendered.find(
    (document) =>
      document?.apiVersion === "batch/v1" &&
      document.kind === "Job" &&
      document.metadata.name === `${release}-initialization`,
  );
  assert.ok(
    initialization?.spec.template.spec.initContainers?.some(
      (container) => container.name === "installation-check",
    ),
    "the upgrade initialization Job includes the installation-check init container",
  );
  assert.deepEqual(
    policy.spec.egress,
    rendered.find(
      (document) =>
        document?.kind === "NetworkPolicy" &&
        document.metadata.name === "openclaw-enterprise-dependency-egress",
    ).spec.egress,
  );
  assert.deepEqual(state.preflight.networkpolicies, {});
  assert.ok(
    state.preflight.deleted.includes(`networkpolicy.networking.k8s.io/${policy.metadata.name}`),
  );
});

test("preflight-only checks the candidate without preparing or deploying it", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    agent: true,
    chart: { installation: (installation) => installation },
  });
  await assert.rejects(f.run("--resume", "--preflight-only"), /cannot be combined/);
  assert.equal(existsSync(f.evidence), false);
  assert.match((await f.run("--preflight-only")).stdout, /Preflight passed/);
  assert.match(
    await readFile(join(f.evidence, "preflight-worker.log"), "utf8"),
    /^installation-startup-ready$/m,
  );
  // The API Pod checked the recorded Agent's draft with the selected image's deploy rules.
  assert.match(
    await readFile(join(f.evidence, "preflight-api.log"), "utf8"),
    /^agent-drafts-accepted$/m,
  );
  assert.equal(existsSync(join(f.evidence, "prepared")), false);
  await assert.rejects(f.run("--resume"), /not a prepared deployment/);
  await assertStoppedBeforeWriters(f);
});

// A draft saved before the selected release retired one of its settings: deploy admission
// refuses it, so before finding 2809 the upgrade moved the controller and then stopped at the
// fleet deploy with the Agents on the old runtime. The API preflight Pod runs the selected
// image's own stored-Configuration rules on each recorded Agent's draft, so the rehearsal and
// the release itself stop before any writer stops, with OCC's deploy message for each Agent.
for (const preflightOnly of [true, false]) {
  test(`${preflightOnly ? "preflight-only" : "the release"} refuses an Agent draft the selected image would not deploy`, async (t) => {
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
      return;
    }
    const f = await fixture(t, {
      agent: true,
      chart: { installation: (installation) => installation },
      configurationValues: {
        cfg_agt_test: { security: { preset: "corporate" }, tools: { exec: { mode: "full" } } },
      },
    });
    await assert.rejects(f.run(...(preflightOnly ? ["--preflight-only"] : [])), (error) => {
      assert.match(
        error.stderr,
        /the selected controller image refuses to deploy 1 recorded Agent draft\(s\):\n {2}- Agent agt_test "Mail triage" in Namespace ns_test: Configuration setting security\.preset must be removed: the OpenClaw runtime retired it \(configure the individual security controls explicitly\)\.\nNo OCC writer was stopped; the old release keeps serving\./,
      );
      return true;
    });
    const state = await assertStoppedBeforeWriters(f);
    assert.equal(state.dispatches, 0);
    assert.equal(existsSync(join(f.evidence, "prepared")), false);
    // Only the API Pod carries the drafts; the worker's check is unchanged.
    const api = JSON.parse(await readFile(join(f.evidence, "preflight-api-job.json"), "utf8")).spec
      .template;
    const worker = JSON.parse(await readFile(join(f.evidence, "preflight-worker-job.json"), "utf8"))
      .spec.template;
    assert.ok(api.spec.volumes.some((volume) => volume.name === "upgrade-preflight-agent-drafts"));
    assert.ok(
      !worker.spec.volumes.some((volume) => volume.name === "upgrade-preflight-agent-drafts"),
    );
  });
}

// Deploy admission checks the model provider settings before the other stored-value rules
// (finding 1549), so the preflight runs them too: a baseUrl the runtime cannot use stops the
// rehearsal with deploy's message instead of the fleet deploy (finding 2816).
test("preflight-only refuses a draft's model provider setting that deploy refuses", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    agent: true,
    chart: { installation: (installation) => installation },
    configurationValues: {
      cfg_agt_test: { models: { providers: { openai: { baseUrl: "ftp://models.example/v1" } } } },
    },
  });
  await assert.rejects(f.run("--preflight-only"), (error) => {
    assert.match(
      error.stderr,
      /refuses to deploy 1 recorded Agent draft\(s\):\n {2}- Agent agt_test "Mail triage" in Namespace ns_test: Configuration field \/models\/providers\/openai\/baseUrl must be an absolute http or https URL\.\n/,
    );
    return true;
  });
  await assertStoppedBeforeWriters(f);
});

// Run the generated API program with the real resolver. Catalog rows may use full refs or
// remainders, but each must name a selected primary or fallback, including entry selections.
test("the release checks saved model catalogs before stopping writers", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  for (const valid of [false, true]) {
    await t.test(valid ? "selected rows pass" : "an unselected row refuses", async (t) => {
      const values = {
        agents: {
          defaults: {
            model: {
              primary: "openai/synthetic-primary",
              fallbacks: ["openai/synthetic-fallback"],
            },
          },
          entries: {
            researcher: {
              model: {
                primary: "openai/synthetic-primary",
                fallbacks: ["openai/synthetic-entry"],
              },
            },
          },
        },
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
              models: [
                { id: "synthetic-primary" },
                { id: "openai/synthetic-fallback" },
                { id: valid ? "synthetic-entry" : "synthetic-unselected-private-value" },
              ],
            },
          },
        },
      };
      const f = await fixture(t, {
        agent: true,
        chart: { installation: (installation) => installation },
        configurationValues: { cfg_agt_test: values },
      });
      if (valid) {
        await f.run();
        assert.equal((await f.state()).dispatches, 1);
        assert.match(
          await readFile(join(f.evidence, "preflight-api.log"), "utf8"),
          /^agent-drafts-accepted$/m,
        );
      } else {
        await assert.rejects(f.run(), (error) => {
          assert.match(
            error.stderr,
            /Agent agt_test "Mail triage" in Namespace ns_test: Configuration setting models\.providers\.openai\.models may list only entries whose id names a primary or fallback model set in agents\.defaults\.model or agents\.entries\./,
          );
          assert.match(error.stderr, /No OCC writer was stopped; the old release keeps serving\./);
          assert.doesNotMatch(error.stdout + error.stderr, /synthetic-/);
          return true;
        });
        const state = await assertStoppedBeforeWriters(f);
        assert.equal(state.dispatches, 0);
        assert.equal(existsSync(join(f.evidence, "prepared")), false);
        const log = await readFile(join(f.evidence, "preflight-api.log"), "utf8");
        assert.doesNotMatch(log, /synthetic-|agent-drafts-accepted/);
      }
    });
  }
});

// The degraded draft-check paths. Each one either warns and lets OCC check the draft at deploy,
// as before finding 2809, or stops before any writer stops; none reports drafts as checked
// when they were not (finding 2815).

// Shared rules are available, but the resolver capability is not callable.
// Exercise the generated reporter and the ordinary release's log collector together.
test("the release refuses an image with an unavailable draft resolver", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    agent: true,
    chart: { installation: (installation) => installation },
    configurationValues: { cfg_agt_test: {} },
    unavailableDraftResolver: true,
  });
  await assert.rejects(f.run(), (error) => {
    assert.match(
      error.stderr,
      /upgrade-production-images: the selected controller image could not check saved Agent drafts because its configured Harness resolver is unavailable\. No OCC writer was stopped; the old release keeps serving\. Select a corrected controller image and start again with a new evidence directory\./,
    );
    assert.doesNotMatch(
      error.stdout + error.stderr,
      /correct the Installation|cannot start the api|refuses to deploy|cannot check Agent drafts before the upgrade|agent-drafts-accepted|installation-startup-ready/,
    );
    return true;
  });
  const log = await readFile(join(f.evidence, "preflight-api.log"), "utf8");
  assert.match(log, /^Agent draft check could not load the configured Harness resolver\.$/m);
  assert.doesNotMatch(
    log,
    /agent-draft-check-unavailable|agent-drafts-accepted|Agent draft refused:|installation-startup-ready/,
  );
  const status = JSON.parse(await readFile(join(f.evidence, "preflight-api-status.json"), "utf8"));
  assert.equal(status.status.phase, "Failed");
  assert.match(
    await readFile(join(f.evidence, "preflight-worker.log"), "utf8"),
    /^installation-startup-ready$/m,
  );
  const state = await assertStoppedBeforeWriters(f);
  assert.equal(state.dispatches, 0);
  assert.equal(state.controller, controller);
  assert.equal(state.helmStatus, "deployed");
  assert.equal(existsSync(join(f.evidence, "prepared")), false);
  assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
});

// An image built before the shared rule cannot check drafts. Its preflight Pod runs and says
// so; the helper warns and the upgrade deploys, so this draft, which a newer image would
// refuse, is refused only by the deploy.
test("an image without the draft rules warns, and the upgrade continues", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    agent: true,
    chart: { installation: (installation) => installation },
    olderDraftRules: true,
    configurationValues: { cfg_agt_test: { security: { preset: "corporate" } } },
  });
  const result = await f.run();
  assert.match(
    result.stderr,
    /upgrade-production-images: the selected controller image cannot check Agent drafts before the upgrade; OCC checks each draft when the upgrade deploys it\./,
  );
  const log = await readFile(join(f.evidence, "preflight-api.log"), "utf8");
  assert.match(log, /^agent-draft-check-unavailable$/m);
  assert.doesNotMatch(log, /^agent-drafts-accepted$/m);
  const state = await f.state();
  assert.equal(state.dispatches, 1);
  assert.deepEqual(state.preflight.secrets, {});
});

// The Secret's values may total 1 MiB. Drafts that do not fit beside the candidate
// Installation are not sent: the helper warns and the preflight goes on. Random text does not
// compress, so the drafts stay over 1 MiB gzipped.
test("drafts that do not fit in the preflight Secret warn, and the preflight passes", async (t) => {
  const f = await fixture(t, {
    agent: true,
    configurationValues: {
      cfg_agt_test: {
        plugins: {
          entries: { knowledge: { config: { note: randomBytes(1100 * 1024).toString("base64") } } },
        },
      },
    },
  });
  const result = await f.run("--preflight-only");
  assert.match(result.stdout, /Preflight passed/);
  assert.match(
    result.stderr,
    /upgrade-production-images: the recorded Agents' drafts do not fit in the startup preflight Secret beside the candidate Installation, so it does not check them; OCC checks each draft when the upgrade deploys it\./,
  );
  // Neither the Secret nor the API Pod carried the drafts.
  const api = JSON.parse(await readFile(join(f.evidence, "preflight-api-job.json"), "utf8")).spec
    .template;
  assert.ok(!api.spec.volumes.some((volume) => volume.name === "upgrade-preflight-agent-drafts"));
  assert.ok(
    !api.spec.containers[0].env.some(
      (variable) => variable.name === "OCC_UPGRADE_PREFLIGHT_AGENT_DRAFTS",
    ),
  );
});

// The drafts get the part of the Secret's 1 MiB that the candidate Installation leaves: about
// 700 KiB of gzipped drafts fit beside a small Installation, but not beside a 400 KiB one.
test("the drafts budget is the Secret limit less the candidate Installation", async (t) => {
  const directory = await temporaryDirectory(t, "occ-upgrade-drafts-");
  const drafts = join(directory, "agent-drafts.jsonl");
  await writeFile(
    drafts,
    JSON.stringify({
      namespaceId: "ns_test",
      agentId: "agt_test",
      name: "Mail triage",
      configurationId: "cfg_agt_test",
      values: {
        plugins: {
          entries: { knowledge: { config: { note: randomBytes(700 * 1024).toString("base64") } } },
        },
      },
    }) + "\n",
  );
  const gather = async (installationBytes) => {
    const installation = join(directory, `installation-${installationBytes}.yaml`);
    await writeFile(installation, "x".repeat(installationBytes));
    return spawnResult(
      process.execPath,
      [
        "scripts/upgrade-startup-preflight.mjs",
        "drafts",
        drafts,
        installation,
        join(directory, `drafts-${installationBytes}.json.gz`),
      ],
      { cwd: repository },
    );
  };
  const small = await gather(1024);
  assert.equal(small.status, 0, small.stderr);
  assert.ok(statSync(join(directory, "drafts-1024.json.gz")).size > 640 * 1024);
  const large = await gather(400 * 1024);
  assert.equal(large.status, 3);
  assert.match(
    large.stderr,
    /1 Agent drafts take \d+ bytes gzipped; with the 409600-byte candidate Installation that is over the 1048576-byte Secret limit\./,
  );
  assert.equal(existsSync(join(directory, "drafts-409600.json.gz")), false);
});

// An API preflight that succeeds without either draft result, as an image that ignored the
// drafts would, is not taken as a check: the helper stops before any writer stops.
test("an API preflight that reports no draft result stops the upgrade", async (t) => {
  const f = await fixture(t, {
    agent: true,
    preflightResults: { api: { phase: "Succeeded", log: "installation-startup-ready\n" } },
  });
  await assert.rejects(
    f.run(),
    /the api startup preflight succeeded without checking the Agent drafts; no OCC writer was stopped\./,
  );
  const state = await assertStoppedBeforeWriters(f);
  assert.equal(state.dispatches, 0);
});

// The command fixture models API inventory and conditional deletion; it is not a live cluster.
// Read only the fixed identity records, never manifests or create stdout.
async function preflightIdentities(f) {
  const records = [];
  for (const slot of ["networkpolicy", "secret", "api", "worker", "api-pod", "worker-pod"]) {
    const filename = join(f.evidence, `preflight-${slot}-identity.json`);
    let handle;
    try {
      handle = await open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      assert.ok(stats.isFile());
      assert.equal(stats.mode & 0o777, 0o600);
      const text = await handle.readFile("utf8");
      const record = JSON.parse(text);
      assert.deepEqual(Object.keys(record).sort(), ["kind", "name", "uid"]);
      assert.doesNotMatch(
        text,
        /private-response-marker|private-manifest-sentinel|private-secret-sentinel|installation.yaml|apiVersion|spec|data/,
      );
      records.push(record);
    } finally {
      await handle.close();
    }
  }
  return records;
}

test("cleanup ownership: acknowledged identities survive a real interruption", async (t) => {
  // Valid opaque UIDs need not be UUIDs, safe filenames, or unescaped JSON strings.
  const uid = '../opaque/"\\雪;$(value)';
  const f = await fixture(t, {
    controllerOnly: true,
    preflightPolicy: true,
    preflightFault: { target: "secret", mode: "interrupt", uid },
    preflightResults: {
      api: { phase: "Succeeded", log: "installation-startup-ready\n" },
      worker: { phase: "Succeeded", log: "installation-startup-ready\n" },
    },
  });
  const failure = await f.run().catch((error) => error);
  assert.equal(failure.code, 143);
  assert.match(failure.stderr, /upgrade interrupted/);
  assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
  const state = await f.state();
  const records = await preflightIdentities(f);
  assert.equal(records.length, 4);
  assert.equal(statSync(f.evidence).mode & 0o777, 0o700);
  assert.ok(!(await readdir(f.evidence)).some((name) => name.endsWith("-identity.json.tmp")));
  assert.deepEqual(records, state.preflight.created);
  assert.equal(records.find((record) => record.kind === "secret").uid, uid);
  assert.equal(new Set(records.map((record) => record.uid)).size, 4);
  assert.deepEqual(state.preflight.deleted, []);
  const secret = Object.values(state.preflight.secrets)[0];
  for (const value of Object.values(secret.data)) {
    assert.ok(!JSON.stringify(records).includes(value), "no Secret data in identity evidence");
  }
  assert.deepEqual(await f.events(), []);
});

test("cleanup ownership: local publication failure retains guarded cleanup", async (t) => {
  for (const mode of ["evidence-file", "evidence-symlink"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, {
        controllerOnly: true,
        preflightPolicy: true,
        preflightFault: { target: "secret", mode },
      });
      const failure = await f.run().catch((error) => error);
      assert.equal(failure.code, 1);
      assert.match(
        failure.stderr,
        /create acknowledged, but local identity evidence could not be confirmed/,
      );
      assert.doesNotMatch(failure.stderr, /ownership unconfirmed|Traceback|unrelated sentinel/);
      assert.ok(!failure.stderr.includes(f.evidence), "no local path in the diagnostic");
      const state = await f.state();
      assert.deepEqual(state.preflight.secrets, {});
      assert.equal(state.preflight.deleted.length, 2);
      assert.equal(state.preflight.created.length, 2, "stops before creating Jobs");
      const destination = join(f.evidence, "preflight-secret-identity.json");
      assert.equal(await readFile(destination, "utf8"), "unrelated sentinel");
      if (mode === "evidence-symlink") {
        assert.equal(await readFile(join(f.directory, "unrelated"), "utf8"), "unrelated sentinel");
      }
      assert.ok(!(await readdir(f.evidence)).some((name) => name.endsWith("-identity.json.tmp")));
      assert.deepEqual(await f.events(), []);
    });
  }
});

// kubectl's create output stays off the terminal but is kept in the private evidence
// directory, so an operator can tell a refusal from a lost or unusable acknowledgement.
for (const [target, mode, acknowledged, errors, reason, kubectlOutput] of [
  [
    "networkpolicy.networking.k8s.io",
    "conflict",
    0,
    "preflight-networkpolicy-create.err",
    "kubectl reported an error for the create; see preflight-networkpolicy-create.err in the evidence directory.",
    /^Error from server \(AlreadyExists\): networkpolicies "[^"]+" already exists$/m,
  ],
  [
    "secret",
    "lost",
    1,
    "preflight-secret-create.err",
    "kubectl reported an error for the create; see preflight-secret-create.err in the evidence directory.",
    /^create acknowledgement lost: private-response-marker$/m,
  ],
  // The Secret's create ends a pipeline, so its status reaches the message as that pipeline's.
  [
    "secret",
    "empty",
    1,
    "preflight-secret-create.err",
    "The create returned no usable UID; kubectl's error output, if any, is in preflight-secret-create.err in the evidence directory.",
    /^$/,
  ],
  [
    "api",
    "empty",
    2,
    "preflight-api-job-create.err",
    "The create returned no usable UID; kubectl's error output, if any, is in preflight-api-job-create.err in the evidence directory.",
    /^$/,
  ],
  // Bash command substitution would otherwise strip this invalid receipt's newline.
  [
    "worker",
    "newline",
    3,
    "preflight-worker-job-create.err",
    "The create returned no usable UID; kubectl's error output, if any, is in preflight-worker-job-create.err in the evidence directory.",
    /^$/,
  ],
]) {
  test(`cleanup ownership: ${target} ${mode} preserves unconfirmed inventory`, async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightPolicy: true,
      preflightFault: { target, mode },
    });
    const failure = await f.run().catch((error) => error);
    const state = await f.state();
    const jobTarget = target === "api" || target === "worker";
    const inventory = jobTarget
      ? "jobs"
      : {
          secret: "secrets",
          "networkpolicy.networking.k8s.io": "networkpolicies",
        }[target];
    const remaining = Object.values(state.preflight[inventory]);
    assert.equal(remaining.length, 1, "the unconfirmed object survives");
    const identities = await preflightIdentities(f);
    assert.equal(identities.length, acknowledged);
    assert.ok(!identities.some((record) => record.uid === remaining[0].metadata.uid));
    if (jobTarget) {
      // An unacknowledged Job may still be running: preserve its mounted input and egress.
      assert.equal(Object.keys(state.preflight.secrets).length, 1);
      assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
      assert.equal(Object.keys(state.preflight.pods).length, 1);
      assert.equal(state.preflight.deleted.length, acknowledged - 2);
      assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
    } else {
      assert.equal(
        ["secrets", "pods", "jobs", "networkpolicies"].flatMap((kind) =>
          Object.values(state.preflight[kind]),
        ).length,
        1,
        "only the unconfirmed object survives",
      );
      assert.equal(
        state.preflight.deleted.length,
        acknowledged,
        "acknowledged objects are cleaned",
      );
    }
    assert.equal(failure.code, 1);
    assert.ok(
      failure.stderr.includes(
        `/${remaining[0].metadata.name}; no cleanup was attempted for this name. ${reason} Check whether`,
      ),
    );
    assert.match(
      failure.stderr,
      /Check whether this object remains in the selected namespace\. Correct the failure and use a fresh evidence directory\. This run stopped no OCC writer\./,
    );
    assert.match(await readFile(join(f.evidence, errors), "utf8"), kubectlOutput);
    assert.equal(statSync(join(f.evidence, errors)).mode & 0o777, 0o600);
    assert.ok(!failure.stderr.includes(remaining[0].metadata.uid), "create response stays private");
    assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
    assert.deepEqual(await f.events(), [], "no writer stops or migration");
  });
}

test("cleanup ownership: a Secret manifest kubectl quotes stays out of the evidence", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightPolicy: true,
    preflightFault: { target: "secret", mode: "decode" },
  });
  const failure = await f.run().catch((error) => error);
  const state = await f.state();
  assert.equal(failure.code, 1);
  assert.match(
    failure.stderr,
    /ownership unconfirmed for secret\/[^;]+; no cleanup was attempted for this name\. kubectl reported an error for the create; see preflight-secret-create\.err in the evidence directory\./,
  );
  // kubectl refused before any request; only the NetworkPolicy existed and is cleaned.
  assert.deepEqual(state.preflight.secrets, {});
  assert.equal(state.preflight.deleted.length, 1);
  assert.equal((await preflightIdentities(f)).length, 1);
  // The diagnosis survives, but not the Installation bytes the Secret carried.
  const errors = await readFile(join(f.evidence, "preflight-secret-create.err"), "utf8");
  assert.match(errors, /^error: unable to decode "STDIN": Object 'Kind' is missing in '/);
  const installation = await readFile(join(f.evidence, "candidate-installation.yaml"));
  assert.ok(installation.length > 24, "the fixture Installation is long enough to redact");
  assert.ok(!errors.includes(installation.toString("base64")), "Secret data stays out");
  assert.match(errors, /\[redacted\]/);
  assert.deepEqual(await f.events(), []);
});

test("cleanup ownership: same-name replacement survives EXIT cleanup", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightPolicy: true,
    preflightFault: { target: "api", mode: "replacement" },
    preflightResults: {
      worker: { phase: "Failed", log: "primary startup failure\n" },
    },
  });
  const failure = await f.run().catch((error) => error);
  const state = await f.state();
  assert.equal(Object.values(state.preflight.jobs).length, 1);
  assert.equal(Object.values(state.preflight.jobs)[0].foreign, true);
  const records = await preflightIdentities(f);
  assert.deepEqual(records, [...state.preflight.created, ...state.preflight.children]);
  const replacement = Object.values(state.preflight.jobs)[0];
  assert.notEqual(
    records.find((record) => record.name === replacement.metadata.name).uid,
    replacement.metadata.uid,
  );
  assert.equal(state.preflight.deleted.length, 1, "the other acknowledged Job is cleaned");
  assert.equal(Object.keys(state.preflight.pods).length, 1, "the original Job child remains");
  assert.equal(Object.keys(state.preflight.secrets).length, 1);
  assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
  assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /primary startup failure/);
  // The warning says the identity did not match, and the API's answer stays private.
  assert.match(
    failure.stderr,
    /could not confirm cleanup of job\.batch\/[^:]+: an object with a different UID now holds this name, so it was left in place; see preflight-cleanup\.err in the evidence directory\./,
  );
  assert.match(
    await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8"),
    /^job\.batch\/[^\n]+-api-[^\n]+:\nError from server \(Conflict\): .*Precondition failed: UID in precondition: /m,
  );
  assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
  assert.deepEqual(await f.events(), []);
});

test("cleanup ownership: a refused DELETE is reported as a failed request", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightPolicy: true,
    preflightFault: { target: "secret", mode: "delete-refused" },
    preflightResults: {
      worker: { phase: "Failed", log: "primary startup failure\n" },
    },
  });
  const failure = await f.run().catch((error) => error);
  const state = await f.state();
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /primary startup failure/);
  assert.equal(Object.values(state.preflight.secrets).length, 1);
  assert.equal(state.preflight.deleted.length, 3, "cleanup continues for other owned objects");
  assert.match(
    failure.stderr,
    /could not confirm cleanup of secret\/[^:]+: the delete request failed; see preflight-cleanup\.err in the evidence directory\./,
  );
  assert.doesNotMatch(failure.stderr, /different UID/);
  const errors = await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8");
  assert.match(
    errors,
    /^secret\/[^\n]+:\nError from server \(Forbidden\): secrets "[^"]+" is forbidden: /m,
  );
  assert.equal(statSync(join(f.evidence, "preflight-cleanup.err")).mode & 0o777, 0o600);
  assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
  assert.deepEqual(await f.events(), []);
});

// Each refused DELETE appends its answer, so the first one is still there to read.
test("cleanup ownership: every refused DELETE keeps its answer in the evidence", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightPolicy: true,
    preflightFault: { target: "job.batch", mode: "delete-refused" },
    preflightResults: {
      worker: { phase: "Failed", log: "primary startup failure\n" },
    },
  });
  const failure = await f.run().catch((error) => error);
  const state = await f.state();
  assert.equal(failure.code, 1);
  assert.equal(Object.values(state.preflight.pods).length, 2);
  assert.equal(Object.keys(state.preflight.jobs).length, 2);
  assert.equal(Object.keys(state.preflight.secrets).length, 1);
  assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
  assert.deepEqual(state.preflight.deleted, []);
  assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
  const errors = await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8");
  for (const component of ["api", "worker"]) {
    assert.match(
      failure.stderr,
      new RegExp(
        `could not confirm cleanup of job\\.batch/[^:]+-${component}-[^:]+: the delete request failed;`,
      ),
    );
    assert.match(
      errors,
      new RegExp(
        `^job\\.batch/[^\\n]+-${component}-[^\\n]+:\\nError from server \\(Forbidden\\): jobs "`,
        "m",
      ),
    );
  }
  assert.doesNotMatch(failure.stdout + failure.stderr, /private-(?:delete-)?response-marker/);
});

// A label is discovery data, not proof that the selected Job controls this Pod.
test("startup preflight refuses a label-matched Pod owned by another Job", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightPolicy: true,
    preflightFault: { target: "api", mode: "foreign-child" },
  });
  const failure = await f.run("--preflight-only").catch((error) => error);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /cannot establish the api startup preflight child Pod identity/);
  const state = await f.state();
  assert.equal(Object.keys(state.preflight.pods).length, 1, "the foreign Pod remains untouched");
  assert.equal(Object.keys(state.preflight.secrets).length, 1);
  assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
  const records = await preflightIdentities(f);
  assert.ok(!records.some((record) => record.name === Object.keys(state.preflight.pods)[0]));
  assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
  assert.deepEqual(await f.events(), []);
});

// A successful DELETE response does not prove that all consumers have stopped.
// This command fixture retains the child after accepting Job deletion; it does not
// simulate Kubernetes garbage collection or establish live cluster behavior.
test("startup preflight retains dependencies while an acknowledged Job child remains", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightPolicy: true,
    preflightFault: { target: "api", mode: "retained-child" },
  });
  const failure = await f.run("--preflight-only").catch((error) => error);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /startup preflight cleanup is incomplete/);
  assert.match(failure.stderr, /retained the candidate Secret and NetworkPolicy/);
  const state = await f.state();
  assert.deepEqual(state.preflight.jobs, {});
  assert.equal(Object.keys(state.preflight.pods).length, 1);
  assert.equal(Object.keys(state.preflight.secrets).length, 1);
  assert.equal(Object.keys(state.preflight.networkpolicies).length, 1);
  assert.deepEqual(
    state.preflight.deleted.map((resource) => resource.split("/")[0]),
    ["job.batch", "job.batch"],
  );
  assert.match(
    await readFile(join(f.evidence, "preflight-cleanup.err"), "utf8"),
    /Timed out stopping job\.batch\//,
  );
  assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
  assert.deepEqual(await f.events(), []);
});

// The first observation establishes a Pod UID; a later same-name replacement must
// not inherit permission to supply logs or the successful preflight result.
for (const mode of ["replace-after-observation", "replace-during-logs"]) {
  test(`startup preflight discards unbound logs: ${mode}`, async (t) => {
    const f = await fixture(t, {
      controllerOnly: true,
      preflightFault: { target: "api", mode },
      ...(mode === "replace-after-observation"
        ? {
            preflightResults: { api: { phase: "Running", log: "unbound-log-sentinel\n" } },
          }
        : {}),
    });
    const failure = await f.run("--preflight-only").catch((error) => error);
    assert.equal(failure.code, 1);
    const state = await f.state();
    assert.equal(
      (state.preflight.logRequests ?? []).includes("api"),
      mode === "replace-during-logs",
    );
    const log = await readFile(join(f.evidence, "preflight-api.log"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return "";
    });
    assert.doesNotMatch(log, /unbound-log-sentinel/);
    assert.doesNotMatch(failure.stdout + failure.stderr, /unbound-log-sentinel/);
    assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
    assert.deepEqual(await f.events(), []);
  });
}

test("startup preflight refuses a failed Job even when its retained child succeeded", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightFault: { target: "api", mode: "job-deadline" },
  });
  const failure = await f.run("--preflight-only").catch((error) => error);
  assert.equal(failure.code, 1);
  const job = JSON.parse(await readFile(join(f.evidence, "preflight-api-job-status.json"), "utf8"));
  assert.deepEqual(job.status.conditions, [
    { type: "Failed", status: "True", reason: "DeadlineExceeded" },
  ]);
  const pod = JSON.parse(await readFile(join(f.evidence, "preflight-api-status.json"), "utf8"));
  assert.equal(pod.status.phase, "Succeeded");
  assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
  await assertStoppedBeforeWriters(f);
});

test("startup preflight without a child points to available timeout evidence", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightFault: { target: "api", mode: "no-child" },
  });
  const failure = await f.run("--preflight-only", "--timeout-seconds", "1").catch((error) => error);
  assert.equal(failure.code, 1);
  for (const file of ["preflight-api-job-status.json", "preflight-api-pods.json"]) {
    assert.ok(failure.stderr.includes(file));
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(f.evidence, file), "utf8")));
  }
  assert.doesNotMatch(failure.stderr, /preflight-api-status\.json/);
  assert.equal(existsSync(join(f.evidence, "preflight-api-status.json")), false);
  assert.equal(existsSync(join(f.evidence, "startup-preflight-passed")), false);
  await assertStoppedBeforeWriters(f);
});

// These cases exercise the actual upgrade command against controlled Helm and
// Kubernetes protocols. The separate disposable-cluster proof checks Helm itself.
async function completedHookInPendingRelease(f) {
  const intent = await assertHelmIntent(f, 1, 2);
  const directory = join(f.evidence, "helm-attempts", intent.attempt.nonce);
  const docs = yamlDocuments(await readFile(join(directory, "rendered.yaml"), "utf8")).map(
    loadYaml,
  );
  const hook = docs.find((doc) => doc.kind === "Job");
  const ordinary = docs.filter((doc) => doc !== hook);
  const state = await f.state();
  state.helmStatus = "pending-upgrade";
  state.recoveryRelease = {
    name: state.release,
    namespace: "system",
    version: 2,
    config: await yamlFile(join(directory, "values.yaml")),
    manifest: ordinary.map((doc) => JSON.stringify(doc)).join("\n---\n"),
    hooks: [
      {
        name: hook.metadata.name,
        manifest: JSON.stringify(hook),
        events: ["pre-install", "pre-upgrade"],
        last_run: { phase: "Running" },
      },
    ],
    info: { status: "pending-upgrade" },
  };
  state.recoveryResources = Object.fromEntries(
    docs.map((desired) => {
      const actual = structuredClone(desired);
      const component = desired.metadata.name.endsWith("api") ? "api" : "worker";
      Object.assign(actual.metadata, {
        namespace: "system",
        resourceVersion: "1",
        uid: desired.kind === "Job" ? "initializer-job" : `${component}-deployment-uid`,
      });
      if (desired.kind === "Job") {
        actual.status = { conditions: [{ type: "Complete", status: "True" }], succeeded: 1 };
      } else {
        actual.metadata.annotations = {
          "meta.helm.sh/release-name": state.release,
          "meta.helm.sh/release-namespace": "system",
        };
      }
      return [`${desired.kind}/${desired.metadata.name}`, actual];
    }),
  );
  state.recoveryPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...structuredClone(hook.spec.template.metadata),
      name: "initializer-pod",
      namespace: "system",
      uid: "initializer-pod-uid",
      resourceVersion: "1",
      ownerReferences: [
        {
          apiVersion: "batch/v1",
          kind: "Job",
          name: hook.metadata.name,
          uid: "initializer-job",
          controller: true,
        },
      ],
    },
    spec: structuredClone(hook.spec.template.spec),
    status: {
      phase: "Succeeded",
      initContainerStatuses: hook.spec.template.spec.initContainers.map(({ name }) => ({
        name,
        state: { terminated: { exitCode: 0 } },
      })),
      containerStatuses: [{ name: "bootstrap", state: { terminated: { exitCode: 0 } } }],
    },
  };
  state.recoveryResources["Pod/initializer-pod"] = state.recoveryPod;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  return state;
}

const recoverHelm = [
  "--resume",
  "--recover-helm",
  "--migration-history-checked",
  "--recovery-reviewed",
];

// Clearing this proxy is an allowed candidate-values change. Stock Helm can
// leave its old NetworkPolicy behind when interrupted before ordinary updates.
async function interruptedProxyRemoval(t, selectedProxy = "") {
  const f = await fixture(t, { recoveryHooks: true });
  const values = await yamlFile(join(f.directory, "values.json"));
  values.api = { ...values.api, channelDirectoryProxyUrl: "http://198.51.100.25:3128" };
  for (const file of ["values.json", "live-values"]) {
    await writeFile(join(f.directory, file), JSON.stringify(values));
  }
  const candidate = structuredClone(values);
  candidate.api.channelDirectoryProxyUrl = selectedProxy;
  const candidatePath = join(f.directory, "remove-proxy.json");
  await writeFile(candidatePath, JSON.stringify(candidate), { mode: 0o600 });
  const policy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "openclaw-enterprise-api-channel-directory-egress",
      namespace: "system",
      uid: "old-egress-policy",
      resourceVersion: "1",
    },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/component": "api" } },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [{ ipBlock: { cidr: "198.51.100.25/32" } }],
          ports: [{ protocol: "TCP", port: 3128 }],
        },
      ],
    },
  };
  const state = await f.state();
  state.recoveryBaselineResources = selectedProxy ? [] : [policy];
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  const run = (...args) => f.run("--candidate-values", candidatePath, ...args);
  await f.failNext("lost-helm-response");
  await assert.rejects(run(), injectedFault);
  const pending = await completedHookInPendingRelease(f);
  return { f, run, pending, policy, key: `${policy.kind}/${policy.metadata.name}` };
}

test("same-candidate recovery refuses retained predecessor resources and checks their absence on resume", async (t) => {
  const { f, run, pending, policy, key } = await interruptedProxyRemoval(t);
  const originalIntent = await readFile(join(f.evidence, "helm-started"), "utf8");
  for (const mode of ["live", "deleting", "keep", "forbidden"]) {
    await t.test(mode, async () => {
      const state = structuredClone(pending);
      state.recoveryResources[key] = structuredClone(policy);
      if (mode === "deleting") {
        state.recoveryResources[key].metadata.deletionTimestamp = "2026-01-01T00:00:00Z";
      } else if (mode === "keep") {
        state.recoveryResources[key].metadata.annotations = { "helm.sh/resource-policy": "keep" };
      } else if (mode === "forbidden") {
        delete state.recoveryResources[key];
        state.retiredResourceReadError = true;
      }
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(
        run(...recoverHelm),
        mode === "forbidden"
          ? /Helm evidence command failed/
          : /predecessor-only resource still exists/,
      );
      assert.equal((await f.state()).rollbackSubmissions, undefined);
      assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
    });
  }
  const withRetiredEnv = structuredClone(pending);
  const oldEnv = { name: "OCC_CHANNEL_DIRECTORY_PROXY_URL", value: "http://198.51.100.25:3128" };
  withRetiredEnv.recoveryResources[
    "Deployment/openclaw-enterprise-api"
  ].spec.template.spec.containers[0].env.push(oldEnv);
  await writeFile(join(f.directory, "state.json"), JSON.stringify(withRetiredEnv));
  await assert.rejects(run(...recoverHelm), /live environment differs/);
  assert.equal((await f.state()).rollbackSubmissions, undefined);
  assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
  // Explicit operator reconciliation removes the retired policy and env entry. If a later
  // acceptance step fails, its recreation must also block ordinary resume.
  await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
  await f.failNext("fail-rollout-api");
  await assert.rejects(run(...recoverHelm), injectedFault);
  assert.ok(existsSync(join(f.evidence, "helm-recovery", "acknowledged.json")));
  const recovered = await f.state();
  recovered.recoveryResources[key] = policy;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(recovered));
  await assert.rejects(run("--resume"), /predecessor-only resource still exists/);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
  delete recovered.recoveryResources[key];
  const apiEnv =
    recovered.recoveryResources["Deployment/openclaw-enterprise-api"].spec.template.spec
      .containers[0].env;
  apiEnv.push(oldEnv);
  await writeFile(join(f.directory, "state.json"), JSON.stringify(recovered));
  await assert.rejects(run("--resume"), /live environment differs/);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
  apiEnv.pop();
  await writeFile(join(f.directory, "state.json"), JSON.stringify(recovered));
  await run("--resume");
  assert.equal((await f.state()).rollbackSubmissions, 1);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  assert.equal(await readFile(join(f.evidence, "helm-started"), "utf8"), originalIntent);
});

test("same-candidate recovery verifies a changed retained environment selection after rollback", async (t) => {
  const { f, run, pending } = await interruptedProxyRemoval(t, "http://198.51.100.26:3128");
  // A retained scalar can legitimately differ before rollback. This protocol
  // fault keeps its old value afterward; it must not receive acknowledgement.
  const entries =
    pending.recoveryResources["Deployment/openclaw-enterprise-api"].spec.template.spec.containers[0]
      .env;
  entries.find((entry) => entry.name === "OCC_CHANNEL_DIRECTORY_PROXY_URL").value =
    "http://198.51.100.25:3128";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
  await assert.rejects(run(...recoverHelm), /live environment differs/);
  assert.equal((await f.state()).rollbackSubmissions, 1);
  assert.equal(existsSync(join(f.evidence, "helm-recovery", "acknowledged.json")), false);
});

for (const [stage, read, rollbacks] of [
  ["before dispatch", 2, 0],
  ["after rollback", 3, 1],
]) {
  test(`same-candidate recovery refuses a predecessor resource recreated ${stage}`, async (t) => {
    const { f, run, pending } = await interruptedProxyRemoval(t);
    pending.retiredResourceAppearsAt = read;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
    await assert.rejects(run(...recoverHelm), /predecessor-only resource still exists/);
    assert.equal((await f.state()).rollbackSubmissions ?? 0, rollbacks);
    assert.ok(existsSync(join(f.evidence, "helm-recovery", "intent.json")));
    assert.equal(existsSync(join(f.evidence, "helm-recovery", "acknowledged.json")), false);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  });
}

test("same-candidate recovery refuses a retired regular worker placement", async (t) => {
  const f = await fixture(t, { recoveryHooks: true });
  // Chart change 24ae029557 moves the broker-enabled worker to a restartable
  // init container. A same-candidate patch cannot remove its old placement.
  const worker = { name: "worker", image: controller, args: ["apps/controller/src/worker.mjs"] };
  const previous = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "broker-worker", namespace: "system" },
    spec: { template: { spec: { containers: [worker] } } },
  };
  const candidate = structuredClone(previous);
  candidate.spec.template.spec = {
    initContainers: [{ ...worker, restartPolicy: "Always" }],
    containers: [{ name: "repository-credentials", image: controller }],
  };
  const initial = await f.state();
  initial.recoveryBaselineResources = [previous];
  initial.recoveryCandidateResources = [candidate];
  await writeFile(join(f.directory, "state.json"), JSON.stringify(initial));
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const pending = await completedHookInPendingRelease(f);
  const podSpec = pending.recoveryResources["Deployment/broker-worker"].spec.template.spec;
  podSpec.containers.push(worker);
  await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
  await assert.rejects(f.run(...recoverHelm), /retired container placement still exists/);
  assert.equal((await f.state()).rollbackSubmissions, undefined);
  assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
  podSpec.containers.pop();
  await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
  await f.failNext("fail-rollout-api");
  await assert.rejects(f.run(...recoverHelm), injectedFault);
  const acknowledged = await f.state();
  const live = acknowledged.recoveryResources["Deployment/broker-worker"].spec.template.spec;
  live.containers.push(worker);
  await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
  await assert.rejects(f.run("--resume"), /retired container placement still exists/);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
  live.containers.pop();
  await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
  await f.run("--resume");
  assert.equal((await f.state()).rollbackSubmissions, 1);
});

test("same-candidate recovery requires changed custom-resource specs already reconciled", async (t) => {
  const f = await fixture(t, { recoveryHooks: true });
  // The real EnvoyProxy shape added node placement in chart change 78131ffa33.
  // This controlled protocol proves admission, not a running Envoy controller.
  const previous = {
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "EnvoyProxy",
    metadata: { name: "gateway", namespace: "system" },
    spec: {
      provider: {
        type: "Kubernetes",
        kubernetes: { envoyService: { name: "gateway", type: "ClusterIP" } },
      },
    },
  };
  const candidate = structuredClone(previous);
  candidate.spec.provider.kubernetes.envoyDeployment = {
    pod: { nodeSelector: { "oce-role": "control" } },
  };
  const initial = await f.state();
  initial.recoveryBaselineResources = [previous];
  initial.recoveryCandidateResources = [candidate];
  await writeFile(join(f.directory, "state.json"), JSON.stringify(initial));
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const pending = await completedHookInPendingRelease(f);
  pending.recoveryResources["EnvoyProxy/gateway"].metadata.uid = "envoy-proxy-uid";
  for (const spec of [previous.spec, { ...candidate.spec, admissionDefault: true }]) {
    const state = structuredClone(pending);
    state.recoveryResources["EnvoyProxy/gateway"].spec = spec;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run(...recoverHelm), /changed custom-resource spec is not reconciled/);
    assert.equal((await f.state()).rollbackSubmissions, undefined);
    assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
  }
  await writeFile(join(f.directory, "state.json"), JSON.stringify(pending));
  await f.failNext("fail-rollout-api");
  await assert.rejects(f.run(...recoverHelm), injectedFault);
  const acknowledged = await f.state();
  acknowledged.recoveryResources["EnvoyProxy/gateway"].spec = previous.spec;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
  await assert.rejects(f.run("--resume"), /changed custom-resource spec is not reconciled/);
  acknowledged.recoveryResources["EnvoyProxy/gateway"].spec = candidate.spec;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
  await f.run("--resume");
  assert.equal((await f.state()).rollbackSubmissions, 1);
});

test("same-candidate recovery uses completed attempt-bound hooks and never repeats an acknowledged rollback", async (t) => {
  const f = await fixture(t, { recoveryHooks: true });
  // Recovery cannot act before the operator supplies both required attestations.
  await assert.rejects(
    f.run("--resume", "--recover-helm"),
    /requires --resume --migration-history-checked --recovery-reviewed/,
  );
  await assert.rejects(f.run("--recovery-reviewed"), /requires --recover-helm/);
  assert.deepEqual(await f.events(), []);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  await completedHookInPendingRelease(f);
  const original = await readFile(join(f.evidence, "helm-started"), "utf8");
  // Rollback is acknowledged but ordinary acceptance is interrupted. Resume
  // must finish acceptance without rerunning migration or rollback.
  await f.failNext("fail-rollout-api");
  await assert.rejects(f.run(...recoverHelm), injectedFault);
  assert.equal((await f.state()).version, 3);
  const acknowledged = await f.state();
  for (const resource of [
    "Deployment/openclaw-enterprise-api",
    "Deployment/openclaw-enterprise-worker",
    "Job/oce-initialization",
    "Pod/initializer-pod",
  ]) {
    const changed = structuredClone(acknowledged);
    const actual = resource.startsWith("Secret/")
      ? changed.secret
      : changed.recoveryResources[resource];
    actual.metadata.uid += "-replacement";
    await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
    await assert.rejects(f.run("--resume"), /recovery resource identity changed/);
    assert.equal((await f.state()).rollbackSubmissions, 1);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  }
  // Rollout changes resource versions without replacing the acknowledged objects.
  for (const resource of Object.values(acknowledged.recoveryResources)) {
    resource.metadata.resourceVersion = "later-version";
  }
  await writeFile(join(f.directory, "state.json"), JSON.stringify(acknowledged));
  await f.run("--resume");
  assert.equal(await readFile(join(f.evidence, "helm-started"), "utf8"), original);
  assert.equal((await f.state()).rollbackSubmissions, 1);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  assert.ok(existsSync(join(f.evidence, "completed")));
});

test("recovery refuses stale hooks, wrong Pod ownership and changed execution without submitting Helm", async (t) => {
  const f = await fixture(t, { recoveryHooks: true });
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const original = await completedHookInPendingRelease(f);
  for (const [name, change, refusal] of [
    [
      "stale nonce",
      (state) => {
        state.recoveryResources["Job/oce-initialization"].metadata.annotations[
          "openclaw.dev/upgrade-attempt"
        ] = randomUUID();
      },
      /original upgrade attempt/,
    ],
    [
      "wrong owner",
      (state) => {
        state.recoveryPod.metadata.ownerReferences[0].uid = "another-job";
      },
      /Pod identity/,
    ],
    [
      "changed command",
      (state) => {
        state.recoveryPod.spec.initContainers[0].args = ["unrelated.mjs"];
      },
      /Pod identity/,
    ],
    [
      "added entrypoint",
      (state) => {
        state.recoveryPod.spec.containers[0].command = ["unreviewed"];
      },
      /Pod identity/,
    ],
    [
      "post-upgrade hook",
      (state) => {
        state.recoveryRelease.hooks[0].events.push("post-upgrade");
      },
      /other hook events/,
    ],
  ]) {
    await t.test(name, async () => {
      const state = structuredClone(original);
      change(state);
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(f.run(...recoverHelm), refusal);
      assert.equal((await f.state()).rollbackSubmissions, undefined);
      assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
    });
  }
});

test("a staged retry cannot replace the published Helm attempt and an actual retry gets a fresh nonce", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-migration");
  await assert.rejects(f.run(), injectedFault);
  const original = await assertHelmIntent(f, 1, 2);
  const preparation = await readFile(join(f.evidence, "parameters.json"), "utf8");
  // The new candidate is staged before quiescence; stopping here must leave
  // the accepted failed submission authoritative on the next resume.
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run("--resume", "--migration-history-checked"), injectedFault);
  assert.deepEqual(await assertHelmIntent(f, 1, 2), original);
  await assert.rejects(f.run("--resume"), /migration --check/);
  assert.equal((await f.state()).helmSubmissions, 1);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run("--resume", "--migration-history-checked"), injectedFault);
  const retry = await assertHelmIntent(f, 2, 3);
  assert.notEqual(retry.attempt.nonce, original.attempt.nonce);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(f.evidence, "helm-attempts", original.attempt.nonce, "intent.json"),
        "utf8",
      ),
    ),
    original,
  );
  assert.equal(await readFile(join(f.evidence, "parameters.json"), "utf8"), preparation);
  await f.run("--resume");
});

test("a retry published before Helm accepts it can resume from its exact predecessor", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-migration");
  await assert.rejects(f.run(), injectedFault);
  const original = await assertHelmIntent(f, 1, 2);
  // B is published, but Helm refuses it before creating a revision. A remains live.
  await f.failNext("reject-helm-submission");
  await assert.rejects(f.run("--resume", "--migration-history-checked"), injectedFault);
  const retry = await assertHelmIntent(f, 2, 3);
  assert.notEqual(retry.attempt.nonce, original.attempt.nonce);
  const predecessor = await f.state();
  assert.equal(predecessor.version, 2);
  const events = await f.events();
  // The retained values belong only to the exact predecessor revision.
  await writeFile(join(f.directory, "state.json"), JSON.stringify({ ...predecessor, version: 3 }));
  await assert.rejects(f.run("--resume", "--migration-history-checked"), /live Helm values/);
  await writeFile(join(f.directory, "state.json"), JSON.stringify(predecessor));
  const liveValues = await readFile(join(f.directory, "live-values"), "utf8");
  await writeFile(
    join(f.directory, "live-values"),
    JSON.stringify({ ...loadYaml(liveValues), unrelated: true }),
  );
  await assert.rejects(f.run("--resume", "--migration-history-checked"), /live Helm values/);
  await writeFile(join(f.directory, "live-values"), liveValues);
  assert.deepEqual(await f.events(), events);
  await f.run("--resume", "--migration-history-checked");
  assert.equal((await f.state()).version, 3);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 2);
});

test("a first intent interrupted before publication can finish its identical staged write", async (t) => {
  for (const stagedFileExists of [false, true]) {
    await t.test(stagedFileExists ? "after staging" : "before staging", async (subtest) => {
      const f = await fixture(subtest);
      await f.failNext("reject-helm-submission");
      await assert.rejects(f.run(), injectedFault);
      const intent = await assertHelmIntent(f, 1, 2);
      const original = await readFile(join(f.evidence, "helm-started"), "utf8");
      const directory = join(f.evidence, "helm-attempts", intent.attempt.nonce);
      // Retain the exact real intent, modeling interruption after its exclusive
      // creation but before publication. No Helm revision or migration was created.
      await rm(join(f.evidence, "helm-started"));
      if (stagedFileExists) {
        const staged = join(directory, "helm-started.tmp");
        await writeFile(staged, JSON.stringify({ ...intent, expectedRevision: 3 }), {
          mode: 0o600,
        });
        await assert.rejects(f.run("--resume"), /staged Helm submission intent changed/);
        assert.equal((await f.state()).helmSubmissions, 1);
        await writeFile(staged, original);
      }
      await f.run("--resume");
      assert.equal(await readFile(join(directory, "intent.json"), "utf8"), original);
      assert.equal((await f.state()).version, 2);
      assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    });
  }
});

test("ordinary resume rejects a well-formed revision pair that differs from the immutable intent", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const original = await assertHelmIntent(f, 1, 2);
  const state = await f.state();
  state.version = 3;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await writeFile(
    join(f.evidence, "helm-started"),
    JSON.stringify({
      ...original,
      previousRevision: 2,
      expectedRevision: 3,
    }),
  );
  const events = await f.events();
  await assert.rejects(f.run("--resume"), /submission intent/);
  assert.deepEqual(await f.events(), events);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
});

test("recovery rejects admission-added execution settings even when absent from the candidate", async (t) => {
  const f = await fixture(t, { recoveryHooks: true });
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const original = await completedHookInPendingRelease(f);
  for (const [field, value] of [
    ["lifecycle", { postStart: { exec: { command: ["unreviewed"] } } }],
    ["env", [{ name: "NODE_OPTIONS", value: "--require=/unreviewed.js" }]],
    ["envFrom", [{ secretRef: { name: "unreviewed" } }]],
    ["workingDir", "/unreviewed"],
    ["startupProbe", { exec: { command: ["unreviewed"] } }],
    ["volumeMounts", [{ name: "unreviewed", mountPath: "/unreviewed" }]],
    ["volumeDevices", [{ name: "unreviewed", devicePath: "/dev/unreviewed" }]],
  ]) {
    await t.test(field, async () => {
      const state = structuredClone(original);
      state.recoveryPod.spec.containers[0][field] = value;
      if (field === "volumeMounts" || field === "volumeDevices") {
        state.recoveryPod.spec.volumes = [
          {
            name: "unreviewed",
            ...(field === "volumeDevices"
              ? { persistentVolumeClaim: { claimName: "unreviewed-block" } }
              : { emptyDir: {} }),
          },
        ];
      }
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(f.run(...recoverHelm), /Pod identity/);
      assert.equal((await f.state()).rollbackSubmissions, undefined);
      assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
    });
  }
});

test("an unacknowledged same-candidate rollback cannot be replayed or silently adopted", async (t) => {
  const f = await fixture(t, { recoveryHooks: true });
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  await completedHookInPendingRelease(f);
  await f.failNext("lost-rollback-response");
  await assert.rejects(f.run(...recoverHelm), /outcome is unresolved/);
  // The controlled server accepted recovery, but the helper did not acknowledge
  // it. A healthy successor alone must not authorize replay or adoption.
  assert.equal((await f.state()).version, 3);
  const intent = await readFile(join(f.evidence, "helm-recovery", "intent.json"), "utf8");
  await assert.rejects(f.run(...recoverHelm), /Do not replay recovery/);
  assert.equal((await f.state()).rollbackSubmissions, 1);
  assert.equal(await readFile(join(f.evidence, "helm-recovery", "intent.json"), "utf8"), intent);
  assert.equal(existsSync(join(f.evidence, "completed")), false);
});

test("a staged retry with replaced local values still cannot replace the published attempt", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-migration");
  await assert.rejects(f.run(), injectedFault);
  const original = await assertHelmIntent(f, 1, 2);
  const preparation = await readFile(join(f.evidence, "parameters.json"), "utf8");
  // Simulate loss at the last native read after local values replacement, before
  // publishing the next intent. Resume must require explicit reconciliation.
  await f.failNext("fail-before-helm-intent");
  await assert.rejects(f.run("--resume", "--migration-history-checked"), injectedFault);
  assert.notEqual(
    (await yamlFile(join(f.directory, "values.json"))).installation.upgradeAttemptId,
    original.attempt.nonce,
  );
  await assert.rejects(
    f.run("--resume", "--migration-history-checked"),
    /protected Helm values changed/,
  );
  assert.deepEqual(await assertHelmIntent(f, 1, 2), original);
  assert.equal((await f.state()).helmSubmissions, 1);
  assert.equal(await readFile(join(f.evidence, "parameters.json"), "utf8"), preparation);
});

test("failed attempt preparation preserves native dry-run diagnostics before stopping writers", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-server-dry-run");
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 9);
    assert.match(error.stderr, /Helm preparation failed/);
    return true;
  });
  const attempts = await readdir(join(f.evidence, "helm-attempts"));
  assert.equal(attempts.length, 1);
  await assertPrivateReceipt(
    join(f.evidence, "helm-attempts", attempts[0], "server-dry-run-error.log"),
    "synthetic server dry-run diagnostic\n",
  );
  assert.deepEqual(await f.events(), []);
  assert.equal(existsSync(join(f.evidence, "prepared")), false);
});

test("recovery refuses a container override of the inherited initializer identity", async (t) => {
  const f = await fixture(t, { recoveryHooks: true });
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const original = await completedHookInPendingRelease(f);
  // Admission may leave the Job intact and override identity only on its Pod.
  for (const placement of ["initContainers", "containers"]) {
    for (const [key, value] of [
      ["runAsUser", 1001],
      ["runAsGroup", 1001],
      ["runAsNonRoot", false],
    ]) {
      await t.test(`${placement} ${key}`, async () => {
        const state = structuredClone(original);
        state.recoveryPod.spec[placement][0].securityContext[key] = value;
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
        await assert.rejects(f.run(...recoverHelm), /Pod identity/);
        assert.equal((await f.state()).rollbackSubmissions, undefined);
        assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
      });
    }
  }
});

test("recovery compares initializer resource quantities by value and refuses changed limits", async (t) => {
  const f = await fixture(t, {
    recoveryHooks: true,
    initializationResources: {
      requests: { cpu: "0.1", memory: "128Mi" },
      limits: { cpu: "0.5", memory: "1.5Gi" },
    },
  });
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run(), injectedFault);
  const original = await completedHookInPendingRelease(f);
  // Kubernetes serializes equivalent fixed-point quantities canonically on
  // the Job and Pod; the stored Helm manifest retains the original spelling.
  for (const spec of [
    original.recoveryResources["Job/oce-initialization"].spec.template.spec,
    original.recoveryPod.spec,
  ]) {
    for (const container of [...spec.initContainers, ...spec.containers]) {
      container.resources.requests.cpu = "100m";
      container.resources.limits = { cpu: "500m", memory: "1536Mi" };
    }
  }
  for (const [placement, section, resource, value] of [
    ["containers", "limits", "memory", "1537Mi"],
    ["initContainers", "requests", "cpu", "101m"],
  ]) {
    const changed = structuredClone(original);
    changed.recoveryPod.spec[placement][0].resources[section][resource] = value;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(changed));
    await assert.rejects(f.run(...recoverHelm), /Pod identity/);
    assert.equal((await f.state()).rollbackSubmissions, undefined);
    assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
  }
  await writeFile(join(f.directory, "state.json"), JSON.stringify(original));
  await f.run(...recoverHelm);
  assert.equal((await f.state()).rollbackSubmissions, 1);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("recovery refuses admission changes to Pod and container security settings", async (t) => {
  for (const change of ["Pod sysctls", "container seccomp", "init capabilities"]) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest, { recoveryHooks: true });
      await f.failNext("lost-helm-response");
      await assert.rejects(f.run(), injectedFault);
      const state = await completedHookInPendingRelease(f);
      // Admission can preserve every requested field while adding privileges or
      // overriding a profile inherited from the Pod onto one container.
      const spec = state.recoveryPod.spec;
      if (change === "Pod sysctls") {
        spec.securityContext.sysctls = [
          { name: "net.ipv4.ip_local_port_range", value: "1024 65535" },
        ];
      } else if (change === "container seccomp") {
        spec.containers[0].securityContext.seccompProfile = { type: "Unconfined" };
      } else {
        spec.initContainers[0].securityContext.capabilities.add = ["NET_ADMIN"];
      }
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await assert.rejects(f.run(...recoverHelm), /Pod identity/);
      assert.equal((await f.state()).rollbackSubmissions, undefined);
      assert.equal(existsSync(join(f.evidence, "helm-recovery")), false);
    });
  }
});
