import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { immutableImageAccepted, imageReferenceCases } from "../fixtures/image-reference-cases.mjs";
import { commandPath as executablePath } from "../helpers/compose.mjs";
import { commandCalls, commandPath } from "../helpers/fake-commands.mjs";
import { commandShim, startCommandServer } from "../helpers/fixture-command-server.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { rangeWideningLocale } from "../helpers/utf8-locale.mjs";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { loadYaml } = controllerRequire("@kubernetes/client-node");
const helper = join(repository, "scripts/prepare-bootstrap-volume");
const image = `registry.example.invalid/openclaw/controller@sha256:${"a".repeat(64)}`;
const shimTools = {
  bash: "/bin/bash",
  sleep: executablePath("sleep") || "/bin/sleep",
  setsid: executablePath("setsid") || "/usr/bin/setsid",
};

// The stand-in kubectl is a bash shim answered by this test process (see
// fixture-command-server.mjs), so each call costs a bash start instead of a node start.
// It appends one JSON line per call to kubectl-state.jsonl, so a file that does not
// exist means no kubectl call reached the server.
async function writeFakeKubectl(t, directory, options = {}) {
  const statePath = join(directory, "kubectl-state.jsonl");
  const manifestPath = join(directory, "manifest.yaml");
  const phase = options.phase ?? "Succeeded";
  const logs =
    options.logs ??
    `${JSON.stringify({ event: "bootstrap-volume.prepared", uid: 1000, gid: 1000, mode: "0700" })}\n`;
  const server = await startCommandServer({
    forwardedEnv: [],
    handle: async ({ args, io }) => {
      await appendFile(statePath, JSON.stringify({ args }) + "\n");
      if (args.includes("create")) {
        await writeFile(manifestPath, await io.readInput());
        io.stdout("pod/created\n");
      } else if (args.includes("get") && args.includes("persistentvolumeclaim")) {
        io.stdout(`persistentvolumeclaim/${options.claimName ?? "occ-bootstrap-admin-password"}\n`);
      } else if (args.includes("get") && args.includes("pod")) {
        io.stdout(phase);
      } else if (args.includes("logs")) {
        io.stdout(logs);
      } else if (args.includes("delete") && args.includes("pod")) {
        io.stdout("pod/deleted\n");
      } else {
        io.stderr("unexpected kubectl invocation: " + args.join(" ") + "\n");
        io.exit(64);
        return;
      }
      io.exit(0);
    },
  });
  // Runs after the fixture directory's removal: every call has ended by then, because
  // each case awaits the helper.
  t.after(() => server.close());
  const kubectl = join(directory, "kubectl");
  const { port, clientToken, serverToken } = server;
  await writeFile(
    kubectl,
    commandShim({
      ...shimTools,
      port,
      clientToken,
      serverToken,
      command: "kubectl",
      forwardedEnv: [],
    }),
    { mode: 0o700 },
  );
  return { kubectl, statePath, manifestPath };
}

async function fixture(t, options) {
  const directory = await temporaryDirectory(t, "openclaw-bootstrap-volume-");
  const kubeconfig = join(directory, "kubeconfig");
  await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\n", { mode: 0o600 });
  const fake = await writeFakeKubectl(t, directory, options);
  return { directory, kubeconfig, ...fake };
}

// The stand-in kubectl appends one JSON line per call.
async function invocations(statePath) {
  return (await commandCalls(statePath)).map((line) => JSON.parse(line).args);
}

test("prepare-bootstrap-volume requires explicit cluster selectors and immutable images", async (t) => {
  const { directory, kubeconfig } = await fixture(t);
  const base = {
    cwd: repository,
    env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
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
  // Kubernetes also rejects an uppercase repository path; only the registry host and the tag
  // may use uppercase, as in the chart and profile preflight.
  for (const name of [
    "registry.example.invalid/openclaw/Controller",
    "registry.example.invalid:5000/Openclaw/controller:release_1",
    "Controller",
  ]) {
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
          `${name}@sha256:${"a".repeat(64)}`,
        ],
        base,
      ),
      /--image repository path must be lowercase/,
      name,
    );
  }
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
  // Empty values are allowed; nonempty values still follow the label-value rule.
  for (const selector of ["pool=-a", "pool=a-", "pool=a b", `pool=${"a".repeat(64)}`]) {
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
          selector,
        ],
        base,
      ),
      /--node-selector value must be a Kubernetes label value/,
      selector,
    );
  }
});

test("prepare-bootstrap-volume creates a hardened preparation Pod and removes it only after verified success", async (t) => {
  const { directory, kubeconfig, statePath, manifestPath } = await fixture(t);
  // Kubernetes accepts 253-byte DNS-subdomain names and qualified label prefixes,
  // even when their single segment exceeds the separate DNS-label name limit.
  const claim = "a".repeat(253);
  const prefix = "b".repeat(253);
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
      "--node-selector",
      `${prefix}/pool=control`,
    ],
    {
      cwd: repository,
      env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
    },
  );
  assert.ok(
    stdout.includes(
      `Prepared bootstrap volume claim openclaw-system/${claim} with UID/GID 1000 mode 0700`,
    ),
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
    [`${prefix}/pool`]: "control",
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
      env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
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
        env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
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
        env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
      },
    ),
    ({ stderr }) =>
      stderr.includes("exactly one JSON success record") &&
      !stderr.includes("fixture-secret-value"),
  );

  const calls = await invocations(statePath);
  assert.ok(!calls.some((args) => args.includes("delete") && args.includes("pod")));
});

test("prepare-bootstrap-volume preserves YAML-scalar namespace names as strings", async (t) => {
  for (const namespace of ["true", "407", "null", "1e3"]) {
    await t.test(namespace, async (t) => {
      const { directory, kubeconfig, manifestPath } = await fixture(t);
      await execute(
        helper,
        [
          "--kubeconfig",
          kubeconfig,
          "--context",
          "production",
          "--namespace",
          namespace,
          "--claim",
          "claim",
          "--image",
          image,
        ],
        {
          cwd: repository,
          env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
        },
      );
      const manifest = loadYaml(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.metadata.namespace, namespace);
    });
  }
});

test("prepare-bootstrap-volume preserves YAML-scalar node selector keys and values", async (t) => {
  // Each key is also its value, so neither side of a selector may be left unquoted.
  const keys = ["null", "yes", "on", "1e3", "0x10", "010"];
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
      "claim",
      "--image",
      image,
      ...keys.flatMap((key) => ["--node-selector", `${key}=${key}`]),
      // Kubernetes allows empty label values, as the chart does.
      "--node-selector",
      "node-role.kubernetes.io/infra=",
    ],
    {
      cwd: repository,
      env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
    },
  );
  const manifest = loadYaml(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.spec.nodeSelector, {
    ...Object.fromEntries(keys.map((key) => [key, key])),
    "node-role.kubernetes.io/infra": "",
  });
});

test("prepare-bootstrap-volume refuses non-ASCII names under a UTF-8 locale", async (t) => {
  const { directory, kubeconfig, statePath } = await fixture(t);
  const locale = await rangeWideningLocale();
  if (!locale) {
    t.skip("en_US.UTF-8 is not installed; other locales do not widen bash ranges");
    return;
  }
  const base = {
    cwd: repository,
    env: {
      ...compileCacheEnvironment,
      PATH: commandPath(directory),
      LANG: locale,
      LC_ALL: locale,
    },
  };
  const argumentsFor = (overrides) => {
    const values = {
      namespace: "openclaw-system",
      claim: "claim",
      image,
      ...overrides,
    };
    return [
      "--kubeconfig",
      kubeconfig,
      "--context",
      "ctx",
      "--namespace",
      values.namespace,
      "--claim",
      values.claim,
      "--image",
      values.image,
      ...(values.selector ? ["--node-selector", values.selector] : []),
    ];
  };
  for (const [overrides, message] of [
    [{ namespace: "ä" }, /--namespace must be a DNS label/],
    [{ namespace: "openclaw-ß" }, /--namespace must be a DNS label/],
    [{ claim: "ä" }, /--claim must be a DNS subdomain/],
    [{ claim: "é.example" }, /--claim must be a DNS subdomain/],
    [{ claim: "claim-٣" }, /--claim must be a DNS subdomain/],
    [
      { image: `registry.example.invalid/contrôleur@sha256:${"a".repeat(64)}` },
      /--image must be an approved immutable SHA-256 image reference/,
    ],
    [
      { image: `registry.example.invalid/controller@sha256:${"é".repeat(64)}` },
      /--image must be an approved immutable SHA-256 image reference/,
    ],
    [{ selector: "pool=ä" }, /--node-selector value must be a Kubernetes label value/],
    [{ selector: "é.example/pool=a" }, /--node-selector key must be a Kubernetes label key/],
  ]) {
    await assert.rejects(execute(helper, argumentsFor(overrides), base), (error) => {
      assert.match(error.stderr, message);
      return true;
    });
  }
  // Every refusal happens before kubectl runs.
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
});

// The helper takes exactly the references Kubernetes can pull with a lowercase SHA-256 digest,
// as profile preflight and the chart do for images.controller, and writes an accepted one,
// such as an IPv6 registry host, into the preparation Pod as written.
test("prepare-bootstrap-volume gives image references Kubernetes' verdict", async (t) => {
  for (const [label, reference, problem] of imageReferenceCases) {
    const { directory, kubeconfig, statePath, manifestPath } = await fixture(t);
    const run = execute(
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
        reference,
      ],
      {
        cwd: repository,
        env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
      },
    );
    if (immutableImageAccepted(reference, problem)) {
      await run;
      assert.equal(
        loadYaml(await readFile(manifestPath, "utf8")).spec.containers[0].image,
        reference,
        label,
      );
      continue;
    }
    await assert.rejects(
      run,
      (error) => {
        assert.match(
          error.stderr,
          problem === "uppercase-repository" && /@sha256:[a-f0-9]{64}$/.test(reference)
            ? /--image repository path must be lowercase/
            : /--image must be an approved immutable SHA-256 image reference/,
          label,
        );
        return true;
      },
      label,
    );
    // A refused reference never reaches kubectl.
    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" }, label);
  }
});
