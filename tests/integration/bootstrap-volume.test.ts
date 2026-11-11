import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { immutableImageAccepted, imageReferenceCases } from "../fixtures/image-reference-cases.mjs";
import { commandPath as executablePath } from "../helpers/compose.mjs";
import { commandCalls, commandPath } from "../helpers/fake-commands.ts";
import { commandShim, startCommandServer } from "../helpers/fixture-command-server.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { rangeWideningLocale } from "../helpers/utf8-locale.mjs";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const client: unknown = controllerRequire("@kubernetes/client-node");
const yamlLoader = record(client).loadYaml;
assert.ok(typeof yamlLoader === "function");
const loadYaml = (source: string): unknown => yamlLoader(source);
const helper = join(repository, "scripts/prepare-bootstrap-volume");
const image = `registry.example.invalid/openclaw/controller@sha256:${"a".repeat(64)}`;
const shimTools = {
  bash: "/bin/bash",
  sleep: executablePath("sleep") || "/bin/sleep",
  setsid: executablePath("setsid") || "/usr/bin/setsid",
};

type KubectlOptions = {
  phase?: string;
  logs?: string;
  createReplyLost?: boolean;
  claimName?: string;
};

type CommandRequest = {
  args: string[];
  io: {
    readInput(): Promise<unknown>;
    stdout(text: string): void;
    stderr(text: string): void;
    exit(code: number): void;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

async function manifest(path: string): Promise<Record<string, unknown>> {
  return record(loadYaml(await readFile(path, "utf8")));
}

function stderr(error: unknown): string {
  return string(record(error).stderr);
}

// The stand-in kubectl is a bash shim answered by this test process (see
// fixture-command-server.mjs), so each call costs a bash start instead of a node start.
// It appends one JSON line per call to kubectl-state.jsonl, so a file that does not
// exist means no kubectl call reached the server.
async function writeFakeKubectl(t: TestContext, directory: string, options: KubectlOptions = {}) {
  const statePath = join(directory, "kubectl-state.jsonl");
  const manifestPath = join(directory, "manifest.yaml");
  const phase = options.phase ?? "Succeeded";
  const logs =
    options.logs ??
    `${JSON.stringify({ event: "bootstrap-volume.prepared", uid: 1000, gid: 1000, mode: "0700" })}\n`;
  const server = await startCommandServer({
    forwardedEnv: [],
    handle: async ({ args, io }: CommandRequest) => {
      await appendFile(statePath, JSON.stringify({ args }) + "\n");
      if (args.includes("create")) {
        await writeFile(manifestPath, string(await io.readInput()));
        if (options.createReplyLost) {
          io.stderr("Unable to connect to the server: EOF\n");
          io.exit(17);
          return;
        }
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
  const { clientToken, serverToken } = server;
  const port: unknown = server.port;
  assert.ok(typeof port === "number");
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

async function fixture(t: TestContext, options?: KubectlOptions) {
  const directory = await temporaryDirectory(t, "openclaw-bootstrap-volume-");
  const kubeconfig = join(directory, "kubeconfig");
  await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\n", { mode: 0o600 });
  const fake = await writeFakeKubectl(t, directory, options);
  return { directory, kubeconfig, ...fake };
}

// The stand-in kubectl appends one JSON line per call.
async function invocations(statePath: string): Promise<string[][]> {
  return (await commandCalls(statePath)).map((line) => {
    const parsed: unknown = JSON.parse(line);
    return array(record(parsed).args).map(string);
  });
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

  const pod = await manifest(manifestPath);
  const metadata = record(pod.metadata);
  const spec = record(pod.spec);
  assert.equal(pod.kind, "Pod");
  assert.match(string(metadata.name), /^occ-bootstrap-volume-prep-[a-z0-9]+$/);
  assert.equal(metadata.namespace, "openclaw-system");
  assert.equal(record(metadata.annotations)["openclaw.dev/bootstrap-claim"], claim);
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.enableServiceLinks, false);
  assert.equal(spec.restartPolicy, "Never");
  assert.equal(record(record(spec.securityContext).seccompProfile).type, "RuntimeDefault");
  assert.deepEqual(spec.nodeSelector, {
    pool: "control",
    "topology.kubernetes.io/zone": "us-west-2a",
    [`${prefix}/pool`]: "control",
  });
  const volumes = array(spec.volumes);
  assert.equal(volumes.length, 1);
  const volume = record(volumes[0]);
  assert.equal(volume.name, "bootstrap-output");
  assert.equal(record(volume.persistentVolumeClaim).claimName, claim);
  const container = record(array(spec.containers)[0]);
  assert.equal(container.name, "prepare");
  assert.equal(container.image, image);
  assert.deepEqual(container.command, ["node"]);
  const args = array(container.args);
  assert.equal(args[2], "/bootstrap");
  const script = string(args[1]);
  assert.match(script, /lstatSync\(root\)/);
  assert.match(script, /isSymbolicLink\(\)/);
  assert.match(script, /entry\.name !== "lost\+found"/);
  assert.match(script, /chownSync\(root, 1000, 1000\)/);
  assert.match(script, /chmodSync\(root, 0o700\)/);
  const securityContext = record(container.securityContext);
  assert.equal(securityContext.runAsUser, 0);
  assert.equal(securityContext.runAsGroup, 0);
  assert.equal(securityContext.allowPrivilegeEscalation, false);
  assert.equal(securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(record(securityContext.capabilities).drop, ["ALL"]);
  assert.deepEqual(record(securityContext.capabilities).add, ["CHOWN", "FOWNER"]);

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

  const pod = await manifest(manifestPath);
  assert.equal(record(pod.spec).nodeSelector, undefined);
});

test("prepare-bootstrap-volume identifies the attempted Pod when the create reply is lost", async (t) => {
  const { directory, kubeconfig, statePath, manifestPath } = await fixture(t, {
    createReplyLost: true,
  });
  const cluster = [
    "--kubeconfig",
    kubeconfig,
    "--context",
    "production",
    "--namespace",
    "openclaw-system",
  ];
  const run = execute(helper, [...cluster, "--claim", "claim", "--image", image], {
    cwd: repository,
    env: { ...compileCacheEnvironment, PATH: commandPath(directory) },
  });
  await assert.rejects(run, { code: 17, stdout: "" });
  const output = string(await run.catch((error: unknown) => stderr(error)));
  const pod = string(record((await manifest(manifestPath)).metadata).name);
  assert.match(output, /^Unable to connect to the server: EOF$/m);
  assert.ok(
    output.includes(`could not confirm creation of preparation Pod openclaw-system/${pod}`),
  );
  assert.ok(output.includes(`--request-timeout 10s describe pod ${pod}`));
  assert.match(output, /Resolve the create outcome before rerunning this helper/);
  assert.doesNotMatch(output, /retained for diagnosis/);
  assert.deepEqual(await invocations(statePath), [
    [
      ...cluster,
      "--request-timeout",
      "10s",
      "get",
      "persistentvolumeclaim",
      "claim",
      "--output",
      "name",
    ],
    [...cluster, "--request-timeout", "10s", "create", "--filename", "-"],
  ]);
});

test("prepare-bootstrap-volume retains the preparation Pod when Kubernetes reports failure", async (t) => {
  const { directory, kubeconfig, statePath } = await fixture(t, {
    phase: "Failed",
    logs: `${JSON.stringify({ event: "bootstrap-volume.rejected", error: "mounted root is not fresh" })}\n`,
  });
  // Copying the diagnostic into Bash must preserve paths with shell metacharacters.
  const selectedKubeconfig = join(directory, "kube config 'quoted' $literal");
  await writeFile(selectedKubeconfig, await readFile(kubeconfig), { mode: 0o600 });
  const env = { ...compileCacheEnvironment, PATH: commandPath(directory) };
  const run = execute(
    helper,
    [
      "--kubeconfig",
      selectedKubeconfig,
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
      env,
    },
  );
  await assert.rejects(run, (error: unknown) => {
    const output = stderr(error);
    return (
      output.includes("preparation Pod failed") &&
      output.includes("Preparation Pod retained for diagnosis") &&
      !output.includes("mounted root is not fresh")
    );
  });

  const calls = await invocations(statePath);
  assert.ok(!calls.some((args) => args.includes("delete") && args.includes("pod")));
  assert.equal(calls.length, 3, "failure guidance must not execute additional cluster requests");

  const output = string(await run.catch((error: unknown) => stderr(error)));
  const diagnostic = output.match(/^Inspect claim: (.+)$/m)?.[1];
  assert.ok(diagnostic, "failure guidance must include the claim inspection command");
  await execute("/bin/bash", ["-c", diagnostic], { cwd: repository, env });
  assert.deepEqual((await invocations(statePath)).slice(calls.length), [
    [
      "--kubeconfig",
      selectedKubeconfig,
      "--context",
      "production",
      "--namespace",
      "openclaw-system",
      "--request-timeout",
      "10s",
      "get",
      "persistentvolumeclaim",
      "occ-bootstrap-admin-password",
      "--output",
      "custom-columns=NAME:.metadata.name,PHASE:.status.phase,STORAGECLASS:.spec.storageClassName,VOLUME:.spec.volumeName",
    ],
  ]);
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
    (error: unknown) => {
      const output = stderr(error);
      return (
        output.includes("exactly one JSON success record") &&
        !output.includes("fixture-secret-value")
      );
    },
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
      const pod = await manifest(manifestPath);
      assert.equal(record(pod.metadata).namespace, namespace);
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
  const pod = await manifest(manifestPath);
  assert.deepEqual(record(pod.spec).nodeSelector, {
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
  type Overrides = { namespace?: string; claim?: string; image?: string; selector?: string };
  const argumentsFor = (overrides: Overrides) => {
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
  ] satisfies [Overrides, RegExp][]) {
    await assert.rejects(execute(helper, argumentsFor(overrides), base), (error: unknown) => {
      assert.match(stderr(error), message);
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
    assert.ok(typeof label === "string");
    assert.ok(typeof reference === "string");
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
        record(array(record((await manifest(manifestPath)).spec).containers)[0]).image,
        reference,
        label,
      );
      continue;
    }
    await assert.rejects(
      run,
      (error: unknown) => {
        assert.match(
          stderr(error),
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
