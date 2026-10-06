import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { loadYaml } = controllerRequire("@kubernetes/client-node");
const helper = join(repository, "scripts/prepare-bootstrap-volume");
const image = `registry.example.invalid/openclaw/controller@sha256:${"a".repeat(64)}`;

async function writeFakeKubectl(directory, options = {}) {
  const kubectl = join(directory, "kubectl");
  const statePath = join(directory, "kubectl-state.jsonl");
  const manifestPath = join(directory, "manifest.yaml");
  const phase = options.phase ?? "Succeeded";
  const logs =
    options.logs ??
    `${JSON.stringify({ event: "bootstrap-volume.prepared", uid: 1000, gid: 1000, mode: "0700" })}\n`;
  await writeFile(
    kubectl,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(statePath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("create")) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    fs.writeFileSync(${JSON.stringify(manifestPath)}, Buffer.concat(chunks));
    process.stdout.write("pod/created\\n");
  });
} else if (args.includes("get") && args.includes("persistentvolumeclaim")) {
  process.stdout.write("persistentvolumeclaim/${options.claimName ?? "occ-bootstrap-admin-password"}\\n");
} else if (args.includes("get") && args.includes("pod")) {
  process.stdout.write(${JSON.stringify(phase)});
} else if (args.includes("logs")) {
  process.stdout.write(${JSON.stringify(logs)});
} else if (args.includes("delete") && args.includes("pod")) {
  process.stdout.write("pod/deleted\\n");
} else {
  process.stderr.write("unexpected kubectl invocation: " + args.join(" ") + "\\n");
  process.exit(64);
}
`,
    { mode: 0o700 },
  );
  return { kubectl, statePath, manifestPath };
}

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-bootstrap-volume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const kubeconfig = join(directory, "kubeconfig");
  await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\n", { mode: 0o600 });
  const fake = await writeFakeKubectl(directory, options);
  return { directory, kubeconfig, ...fake };
}

async function invocations(statePath) {
  const contents = await readFile(statePath, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).args);
}

test("prepare-bootstrap-volume requires explicit cluster selectors and immutable images", async (t) => {
  const { directory, kubeconfig } = await fixture(t);
  const base = {
    cwd: repository,
    env: { PATH: `${directory}:${process.env.PATH}` },
  };

  await assert.rejects(
    execute(
      helper,
      ["--context", "ctx", "--namespace", "openclaw-system", "--claim", "claim", "--image", image],
      base,
    ),
    /--kubeconfig is required/,
  );
  await assert.rejects(
    execute(
      helper,
      [
        "--kubeconfig",
        kubeconfig,
        "--context",
        "ctx",
        "--namespace",
        "openclaw-system",
        "--claim",
        "claim",
        "--image",
        "registry.example.invalid/controller:latest",
      ],
      base,
    ),
    /approved immutable SHA-256 image reference/,
  );
  // Kubernetes rejects uppercase digest hex as InvalidImageName, so the helper
  // refuses it before creating a preparation Pod that could never start.
  await assert.rejects(
    execute(
      helper,
      [
        "--kubeconfig",
        kubeconfig,
        "--context",
        "ctx",
        "--namespace",
        "openclaw-system",
        "--claim",
        "claim",
        "--image",
        `registry.example.invalid/openclaw/controller@sha256:${"A".repeat(64)}`,
      ],
      base,
    ),
    /--image must be an approved immutable SHA-256 image reference/,
  );
  // A digest is exactly 64 hex characters.
  for (const digest of ["a".repeat(63), "a".repeat(65)]) {
    await assert.rejects(
      execute(
        helper,
        [
          "--kubeconfig",
          kubeconfig,
          "--context",
          "ctx",
          "--namespace",
          "openclaw-system",
          "--claim",
          "claim",
          "--image",
          `registry.example.invalid/openclaw/controller@sha256:${digest}`,
        ],
        base,
      ),
      /--image must be an approved immutable SHA-256 image reference/,
    );
  }
  await assert.rejects(
    execute(
      helper,
      [
        "--kubeconfig",
        kubeconfig,
        "--context",
        "ctx",
        "--namespace",
        "openclaw-system",
        "--claim",
        "Invalid_Claim",
        "--image",
        image,
      ],
      base,
    ),
    /--claim must be a DNS subdomain/,
  );
  await assert.rejects(
    execute(
      helper,
      [
        "--kubeconfig",
        kubeconfig,
        "--context",
        "ctx",
        "--namespace",
        "openclaw-system",
        "--claim",
        "claim",
        "--image",
        image,
        "--node-selector",
        "pool",
      ],
      base,
    ),
    /--node-selector must use KEY=VALUE/,
  );
});

test("prepare-bootstrap-volume creates a hardened preparation Pod and removes it only after verified success", async (t) => {
  const { directory, kubeconfig, statePath, manifestPath } = await fixture(t);
  const claim = "occ.bootstrap-admin.password";
  const { stdout } = await execute(
    helper,
    [
      "--kubeconfig",
      kubeconfig,
      "--context",
      "production",
      "--namespace",
      "openclaw-system",
      "--claim",
      claim,
      "--image",
      image,
      "--node-selector",
      "pool=control",
      "--node-selector",
      "topology.kubernetes.io/zone=us-west-2a",
    ],
    {
      cwd: repository,
      env: { PATH: `${directory}:${process.env.PATH}` },
    },
  );
  assert.match(
    stdout,
    /Prepared bootstrap volume claim openclaw-system\/occ\.bootstrap-admin\.password with UID\/GID 1000 mode 0700/,
  );

  const manifest = loadYaml(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.kind, "Pod");
  assert.match(manifest.metadata.name, /^occ-bootstrap-volume-prep-[a-z0-9]+$/);
  assert.equal(manifest.metadata.namespace, "openclaw-system");
  assert.equal(manifest.metadata.annotations["openclaw.dev/bootstrap-claim"], claim);
  assert.equal(manifest.spec.automountServiceAccountToken, false);
  assert.equal(manifest.spec.enableServiceLinks, false);
  assert.equal(manifest.spec.restartPolicy, "Never");
  assert.equal(manifest.spec.securityContext.seccompProfile.type, "RuntimeDefault");
  assert.deepEqual(manifest.spec.nodeSelector, {
    pool: "control",
    "topology.kubernetes.io/zone": "us-west-2a",
  });
  assert.equal(manifest.spec.volumes.length, 1);
  assert.equal(manifest.spec.volumes[0].name, "bootstrap-output");
  assert.equal(manifest.spec.volumes[0].persistentVolumeClaim.claimName, claim);
  const container = manifest.spec.containers[0];
  assert.equal(container.name, "prepare");
  assert.equal(container.image, image);
  assert.deepEqual(container.command, ["node"]);
  assert.equal(container.args[2], "/bootstrap");
  assert.match(container.args[1], /lstatSync\(root\)/);
  assert.match(container.args[1], /isSymbolicLink\(\)/);
  assert.match(container.args[1], /entry\.name !== "lost\+found"/);
  assert.match(container.args[1], /chownSync\(root, 1000, 1000\)/);
  assert.match(container.args[1], /chmodSync\(root, 0o700\)/);
  assert.equal(container.securityContext.runAsUser, 0);
  assert.equal(container.securityContext.runAsGroup, 0);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.deepEqual(container.securityContext.capabilities.add, ["CHOWN", "FOWNER"]);

  const calls = await invocations(statePath);
  assert.ok(calls.some((args) => args.includes("get") && args.includes("persistentvolumeclaim")));
  assert.ok(calls.some((args) => args.includes("create")));
  assert.ok(calls.some((args) => args.includes("get") && args.includes("pod")));
  assert.ok(calls.some((args) => args.includes("logs")));
  assert.ok(calls.some((args) => args.includes("delete") && args.includes("pod")));
  for (const args of calls) {
    assert.equal(args[args.indexOf("--kubeconfig") + 1], kubeconfig);
    assert.equal(args[args.indexOf("--context") + 1], "production");
    assert.equal(args[args.indexOf("--request-timeout") + 1], "10s");
    assert.equal(args[args.indexOf("--namespace") + 1], "openclaw-system");
  }
});

test("prepare-bootstrap-volume omits nodeSelector unless requested", async (t) => {
  const { directory, kubeconfig, manifestPath } = await fixture(t);
  await execute(
    helper,
    [
      "--kubeconfig",
      kubeconfig,
      "--context",
      "production",
      "--namespace",
      "openclaw-system",
      "--claim",
      "occ-bootstrap-admin-password",
      "--image",
      image,
    ],
    {
      cwd: repository,
      env: { PATH: `${directory}:${process.env.PATH}` },
    },
  );

  const manifest = loadYaml(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.spec.nodeSelector, undefined);
});

test("prepare-bootstrap-volume retains the preparation Pod when Kubernetes reports failure", async (t) => {
  const { directory, kubeconfig, statePath } = await fixture(t, {
    phase: "Failed",
    logs: `${JSON.stringify({ event: "bootstrap-volume.rejected", error: "mounted root is not fresh" })}\n`,
  });

  await assert.rejects(
    execute(
      helper,
      [
        "--kubeconfig",
        kubeconfig,
        "--context",
        "production",
        "--namespace",
        "openclaw-system",
        "--claim",
        "occ-bootstrap-admin-password",
        "--image",
        image,
      ],
      {
        cwd: repository,
        env: { PATH: `${directory}:${process.env.PATH}` },
      },
    ),
    ({ stderr }) =>
      stderr.includes("preparation Pod failed") &&
      stderr.includes("Preparation Pod retained for diagnosis") &&
      !stderr.includes("mounted root is not fresh"),
  );

  const calls = await invocations(statePath);
  assert.ok(!calls.some((args) => args.includes("delete") && args.includes("pod")));
});

test("prepare-bootstrap-volume refuses unverifiable success reports without printing Pod logs", async (t) => {
  const { directory, kubeconfig, statePath } = await fixture(t, {
    logs: `${JSON.stringify({
      event: "bootstrap-volume.prepared",
      uid: 1000,
      gid: 1000,
      mode: "0700",
    })}\n${JSON.stringify({ event: "debug", token: "fixture-secret-value" })}\n`,
  });

  await assert.rejects(
    execute(
      helper,
      [
        "--kubeconfig",
        kubeconfig,
        "--context",
        "production",
        "--namespace",
        "openclaw-system",
        "--claim",
        "occ-bootstrap-admin-password",
        "--image",
        image,
      ],
      {
        cwd: repository,
        env: { PATH: `${directory}:${process.env.PATH}` },
      },
    ),
    ({ stderr }) =>
      stderr.includes("exactly one JSON success record") &&
      !stderr.includes("fixture-secret-value"),
  );

  const calls = await invocations(statePath);
  assert.ok(!calls.some((args) => args.includes("delete") && args.includes("pod")));
});
