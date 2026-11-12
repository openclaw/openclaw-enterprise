import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runFixtureCommand } from "./production-rehearsal-custody.ts";
import {
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
  withBoundedTeardown,
} from "./kubernetes-real.mjs";
import { createModelProviderFiles, writeModelProviderTrust } from "./runtime-model-provider.mjs";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{64}$/;
const ownerLabel = "dev.openclaw.native-model-barrier";
const pointer = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");

// This is a controlled provider, not external model acceptance. The caller owns
// an exclusive disposable k3d cluster and stops its Agent before this teardown.
export async function prepareNativeModelBarrier(
  context,
  { directory, kubeconfigPath, kubernetesContext, cluster, codexImage, providerImage },
) {
  context = withBoundedTeardown(context);
  assert.equal(process.platform, "linux");
  assert.ok(["x64", "arm64"].includes(process.arch));
  assert.match(cluster, /^[a-z0-9][a-z0-9-]{0,40}$/);
  assert.equal(kubernetesContext, `k3d-${cluster}`);
  for (const image of [codexImage, providerImage]) {
    assert.match(image, /^\S+@sha256:[a-f0-9]{64}$/);
  }
  const selection = { kubeconfigPath, kubernetesContext };
  const owner = randomUUID();
  const prefix = `oce-native-model-${owner}`;
  const root = resolve(directory, `model-${owner.slice(0, 8)}`);
  const controlDirectory = join(root, "control");
  const controlPath = join(controlDirectory, "provider.sock");
  assert.ok(Buffer.byteLength(controlPath) < 104, "Use a short fixture directory for Unix sockets");
  const tag = `docker.io/library/${prefix}:trust`;
  const dnsKey = `${prefix}.server`;
  const octets = randomBytes(2);
  const subnet = `11.${octets[0]}.${octets[1]}`;
  const address = `${subnet}.2`;
  const modelKey = `synthetic-${randomBytes(24).toString("hex")}`;
  const environment = { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock" };
  for (const key of ["DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_TLS"]) {
    environment[key] = undefined;
  }
  environment.OPENAI_API_KEY = undefined;
  let rootCreated = false;
  let closing = false;
  let uncertain = false;
  let armDispatched = false;
  let releaseDispatched = false;
  let cleanupDeadline;
  let preparation;
  let networkId;
  let providerId;
  let trustedId;
  let reference;
  let dnsUid;
  let dnsCreated = false;
  let gateId;
  let nodes = [];
  const obligations = new Set();
  const invoke = (program, args, options = {}) => {
    const timeout = cleanupDeadline
      ? Math.min(30_000, cleanupDeadline - Date.now())
      : (options.timeout ?? 120_000);
    assert.ok(timeout > 0, "Provider cleanup deadline elapsed");
    return runFixtureCommand(
      program,
      args,
      { ...options, env: environment, timeout },
      () => "fixture command failed (output withheld)",
      true,
    );
  };
  const command = (program, args, options) => {
    assert.ok(!closing, "Fixture is closing");
    context.signal?.throwIfAborted();
    return invoke(program, args, options).catch((error) => {
      uncertain ||=
        error.outcome?.timedOut || error.outcome?.interrupted || error.outcome?.terminationFailed;
      throw error;
    });
  };
  const docker = (args, cleanup = false) =>
    (cleanup ? invoke : command)("docker", ["--host=unix:///var/run/docker.sock", ...args]);
  const kube = (args, options, cleanup = false) =>
    (cleanup ? invoke : command)(
      "kubectl",
      kubectlArguments(selection, ["--request-timeout=30s", ...args]),
      options,
    );
  const inspect = async (kind, name, cleanup = false) =>
    JSON.parse(await docker([kind, "inspect", name], cleanup))[0];
  const dns = async (cleanup = false) => {
    const text = await kube(
      [
        "-n",
        "kube-system",
        "get",
        "configmap",
        "coredns-custom",
        "--ignore-not-found",
        "-o",
        "json",
      ],
      undefined,
      cleanup,
    );
    return text.trim() ? JSON.parse(text) : undefined;
  };
  const dnsValue = `api.openai.com:53 {\n    hosts {\n        ${address} api.openai.com\n    }\n}\n`;
  const record = () =>
    writeFile(
      join(root, "ownership.json"),
      JSON.stringify(
        {
          owner,
          cluster,
          networkId,
          providerId,
          trustedId,
          reference,
          dnsUid,
          nodes: nodes.map(({ id, name, uid }) => ({ id, name, uid })),
          obligations: [...obligations],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  const reserve = async (kind) => {
    obligations.add(kind);
    await record();
  };
  const nodeCommand = (node, args, cleanup = false) =>
    docker(["exec", node.id, "ctr", "-n", "k8s.io", "images", ...args], cleanup);
  const nodeEntries = async (node, cleanup = false) =>
    (await nodeCommand(node, ["list"], cleanup))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/));
  async function assertNode(node, cleanup = false) {
    const current = await inspect("container", node.id, cleanup);
    assert.equal(current.Name, `/${node.name}`);
    assert.equal(current.Config.Labels["k3d.cluster"], cluster);
    assert.equal(current.State.Running, true);
  }
  async function control(value) {
    assert.ok(!closing, "Fixture is closing");
    context.signal?.throwIfAborted();
    const stat = await lstat(controlPath);
    assert.ok(stat.isSocket() && (stat.mode & 0o777) === 0o600);
    assert.equal(stat.uid, process.getuid());
    return new Promise((resolveReply, reject) => {
      const socket = connect(controlPath);
      let text = "";
      let reply;
      socket.setTimeout(5_000, () => socket.destroy(new Error("Provider control timed out")));
      socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
      socket.on("data", (chunk) => {
        text += chunk;
        if (text.length > 8_192) {
          socket.destroy(new Error("Provider control reply too large"));
        } else if (text.includes("\n")) {
          try {
            reply = JSON.parse(text.slice(0, text.indexOf("\n")));
          } catch {
            socket.destroy(new Error("Malformed provider control reply"));
            return;
          }
          socket.end();
          socket.destroy();
        }
      });
      socket.on("error", reject);
      socket.on("close", () => {
        if (reply?.ok === true) {
          resolveReply(reply);
        } else {
          reject(new Error("Provider control did not acknowledge operation"));
        }
      });
    });
  }

  context.after(async () => {
    closing = true;
    await Promise.allSettled([preparation]);
    if (!rootCreated) {
      return;
    }
    assert.ok(!uncertain, `Fixture command outcome is uncertain; preserve ${root}`);
    cleanupDeadline = Date.now() + 150_000;
    const failures = [];
    const settle = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    // CAS protects other tests' CoreDNS keys; never restore an old whole ConfigMap.
    if (obligations.has("dns")) {
      await settle(async () => {
        const current = await dns(true);
        if (!current) {
          assert.ok(!dnsUid);
          return;
        }
        if (dnsUid) {
          assert.equal(current.metadata.uid, dnsUid);
        } else {
          assert.equal(current.metadata.labels?.[ownerLabel], owner);
        }
        const patches = [
          { op: "test", path: "/metadata/uid", value: current.metadata.uid },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: current.metadata.resourceVersion,
          },
        ];
        if (current.data?.[dnsKey] !== undefined) {
          assert.equal(current.data[dnsKey], dnsValue);
          patches.push(
            { op: "test", path: `/data/${pointer(dnsKey)}`, value: dnsValue },
            { op: "remove", path: `/data/${pointer(dnsKey)}` },
          );
          await kube(
            [
              "-n",
              "kube-system",
              "patch",
              "configmap",
              "coredns-custom",
              "--type=json",
              "-p",
              JSON.stringify(patches),
            ],
            undefined,
            true,
          );
        }
        const after = await dns(true);
        assert.equal(after.metadata.uid, current.metadata.uid);
        assert.equal(after.data?.[dnsKey], undefined);
        if (dnsCreated && Object.keys(after.data ?? {}).length === 0) {
          assert.equal(after.metadata.labels?.[ownerLabel], owner);
          await kube(
            [
              "delete",
              "--raw",
              "/api/v1/namespaces/kube-system/configmaps/coredns-custom",
              "-f",
              "-",
            ],
            {
              input: JSON.stringify({
                apiVersion: "v1",
                kind: "DeleteOptions",
                preconditions: {
                  uid: after.metadata.uid,
                  resourceVersion: after.metadata.resourceVersion,
                },
              }),
            },
            true,
          );
        }
        await kube(
          ["-n", "kube-system", "rollout", "restart", "deployment/coredns"],
          undefined,
          true,
        );
        await kube(
          ["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=25s"],
          undefined,
          true,
        );
      });
    }
    if (obligations.has("provider")) {
      await settle(async () => {
        const ids = (await docker(["ps", "-aq", "--filter", `name=^/${prefix}$`], true)).trim();
        if (!ids) {
          return;
        }
        const current = await inspect("container", prefix, true);
        assert.equal(current.Config.Labels[ownerLabel], owner);
        if (providerId) {
          assert.equal(current.Id, providerId);
        }
        await docker(["rm", "--force", "--volumes", current.Id], true);
      });
    }
    if (obligations.has("network")) {
      await settle(async () => {
        const ids = (
          await docker(["network", "ls", "-q", "--filter", `name=^${prefix}$`], true)
        ).trim();
        if (!ids) {
          return;
        }
        const current = await inspect("network", prefix, true);
        assert.equal(current.Labels[ownerLabel], owner);
        if (networkId) {
          assert.equal(current.Id, networkId);
        }
        for (const id of Object.keys(current.Containers ?? {})) {
          const node = nodes.find((entry) => entry.id === id);
          assert.ok(node, "Unexpected consumer of fixture network");
          await assertNode(node, true);
          await docker(["network", "disconnect", current.Id, id], true);
        }
        await docker(["network", "rm", current.Id], true);
      });
    }
    if (obligations.has("import")) {
      for (const node of nodes) {
        await settle(async () => {
          await assertNode(node, true);
          for (const [name, , digest] of await nodeEntries(node, true)) {
            if (name !== tag && name !== reference) {
              continue;
            }
            assert.match(digest, digestPattern);
            if (reference) {
              assert.ok(reference.endsWith(`@${digest}`));
            }
            await nodeCommand(node, ["rm", name], true);
          }
        });
      }
    }
    if (obligations.has("image")) {
      await settle(async () => {
        const ids = (await docker(["image", "ls", "--quiet", "--no-trunc", tag], true)).trim();
        if (!ids) {
          return;
        }
        const current = await inspect("image", tag, true);
        assert.equal(current.Config.Labels[ownerLabel], owner);
        if (trustedId) {
          assert.equal(current.Id, trustedId);
        }
        await docker(["image", "rm", tag], true);
      });
    }
    if (failures.length) {
      throw new AggregateError(failures, `Provider cleanup incomplete; retained ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  });

  preparation = (async () => {
    await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    rootCreated = true;
    await record();
    await validateExplicitK3dLoopbackContext(selection);
    const observed = JSON.parse(await kube(["get", "nodes", "-o", "json"])).items;
    assert.ok(observed.length > 0 && observed.length <= 4);
    for (const node of observed) {
      assert.match(node.metadata.name, new RegExp(`^k3d-${cluster}-(server|agent)-[0-9]+$`));
      const container = await inspect("container", node.metadata.name);
      assert.match(container.Id, idPattern);
      assert.equal(container.Config.Labels["k3d.cluster"], cluster);
      assert.ok(
        node.status.addresses.some(
          ({ type, address: ip }) =>
            type === "InternalIP" &&
            Object.values(container.NetworkSettings.Networks).some(
              (network) => network.IPAddress === ip,
            ),
        ),
      );
      nodes.push({ id: container.Id, name: node.metadata.name, uid: node.metadata.uid });
      await assertNode(nodes.at(-1));
    }
    await record();
    const platform = `linux/${process.arch === "x64" ? "amd64" : process.arch}`;
    const base = JSON.parse(
      await docker(["image", "inspect", "--platform", platform, codexImage]),
    )[0];
    const files = join(root, "model");
    await createModelProviderFiles({ directory: files, caName: prefix, run: command });
    await mkdir(controlDirectory, { mode: 0o700 });
    const trust = join(root, "trust");
    await writeModelProviderTrust({ context: trust, caPath: join(files, "ca.pem") });
    assert.equal((await docker(["image", "ls", "--quiet", tag])).trim(), "");
    await reserve("image");
    await command(
      "docker",
      [
        "--host=unix:///var/run/docker.sock",
        "build",
        "--network=none",
        "--platform",
        platform,
        "--pull=false",
        "--label",
        `${ownerLabel}=${owner}`,
        "--build-arg",
        `RUNTIME_IMAGE=${codexImage}`,
        "--tag",
        tag,
        trust,
      ],
      { timeout: 300_000 },
    );
    const built = await inspect("image", tag);
    for (const field of ["User", "Entrypoint", "Cmd", "WorkingDir"]) {
      assert.deepEqual(built.Config[field], base.Config[field]);
    }
    assert.deepEqual(built.RootFS.Layers.slice(0, base.RootFS.Layers.length), base.RootFS.Layers);
    assert.deepEqual(built.Config.Labels, { ...base.Config.Labels, [ownerLabel]: owner });
    trustedId = built.Id;
    assert.match(trustedId, digestPattern);
    for (const node of nodes) {
      assert.ok(!(await nodeEntries(node)).some(([name]) => name === tag));
    }
    await reserve("import");
    await command("k3d", ["image", "import", "--cluster", cluster, tag], { timeout: 180_000 });
    for (const node of nodes) {
      await assertNode(node);
      const entry = (await nodeEntries(node)).find(([name]) => name === tag);
      assert.ok(entry, "Trust image must be imported into every selected node");
      assert.match(entry[2], digestPattern);
      let manifest = JSON.parse(
        await docker(["exec", node.id, "ctr", "-n", "k8s.io", "content", "get", entry[2]]),
      );
      if (manifest.manifests) {
        const choices = manifest.manifests.filter(
          (item) =>
            item.platform?.os === "linux" && item.platform?.architecture === platform.split("/")[1],
        );
        assert.equal(choices.length, 1);
        manifest = JSON.parse(
          await docker([
            "exec",
            node.id,
            "ctr",
            "-n",
            "k8s.io",
            "content",
            "get",
            choices[0].digest,
          ]),
        );
      }
      assert.equal(
        manifest.config.digest,
        trustedId,
        "Imported runtime must be the built CA derivative",
      );
      const candidate = `${tag.slice(0, tag.lastIndexOf(":"))}@${entry[2]}`;
      if (reference) {
        assert.equal(candidate, reference);
      }
      reference = candidate;
      await nodeCommand(node, ["tag", tag, reference]);
    }
    assert.equal(
      (await docker(["network", "ls", "--quiet", "--filter", `name=^${prefix}$`])).trim(),
      "",
    );
    await reserve("network");
    networkId = (
      await docker([
        "network",
        "create",
        "--internal",
        "--subnet",
        `${subnet}.0/28`,
        "--label",
        `${ownerLabel}=${owner}`,
        prefix,
      ])
    ).trim();
    assert.match(networkId, idPattern);
    for (let index = 0; index < nodes.length; index++) {
      await assertNode(nodes[index]);
      await docker([
        "network",
        "connect",
        "--ip",
        `${subnet}.${index + 3}`,
        networkId,
        nodes[index].id,
      ]);
    }
    assert.equal((await docker(["ps", "-aq", "--filter", `name=^/${prefix}$`])).trim(), "");
    await reserve("provider");
    providerId = (
      await docker([
        "run",
        "--pull=never",
        "--platform",
        platform,
        "--detach",
        "--name",
        prefix,
        "--label",
        `${ownerLabel}=${owner}`,
        "--network",
        networkId,
        "--ip",
        address,
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--sysctl",
        "net.ipv4.ip_unprivileged_port_start=0",
        "--volume",
        `${files}:/fixture:ro`,
        "--volume",
        `${controlDirectory}:/control:rw`,
        "--env",
        "PROBE_ENDPOINT_MODE=answer",
        "--env",
        "PROBE_ENDPOINT_HOST=0.0.0.0",
        "--env",
        "PROBE_ENDPOINT_ECHO_PATTERN=OCC-[A-Za-z0-9_-]+",
        "--env",
        "PROBE_ENDPOINT_CONTROL_SOCKET=/control/provider.sock",
        "--env",
        `PROBE_ENDPOINT_CREDENTIAL_DIGESTS=${JSON.stringify({ fixture: createHash("sha256").update(modelKey).digest("hex") })}`,
        "--entrypoint",
        "node",
        providerImage,
        "/fixture/endpoint.mjs",
      ])
    ).trim();
    assert.match(providerId, idPattern);
    await record();
    const deadline = Date.now() + 30_000;
    while (
      !(await lstat(controlPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }))
    ) {
      assert.ok(Date.now() < deadline, "Provider control socket did not start");
      context.signal?.throwIfAborted();
      await delay(100);
    }
    const before = await dns();
    dnsUid = before?.metadata.uid;
    dnsCreated = !before;
    assert.equal(before?.data?.[dnsKey], undefined);
    assert.ok(
      !Object.values(before?.data ?? {}).some((value) => /api\.openai\.com/.test(value)),
      "Another provider already owns cluster DNS",
    );
    await reserve("dns");
    if (before) {
      await kube([
        "-n",
        "kube-system",
        "patch",
        "configmap",
        "coredns-custom",
        "--type=json",
        "-p",
        JSON.stringify([
          { op: "test", path: "/metadata/uid", value: dnsUid },
          { op: "test", path: "/metadata/resourceVersion", value: before.metadata.resourceVersion },
          ...(before.data ? [] : [{ op: "add", path: "/data", value: {} }]),
          { op: "add", path: `/data/${pointer(dnsKey)}`, value: dnsValue },
        ]),
      ]);
    } else {
      await kube(["create", "-f", "-"], {
        input: JSON.stringify({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: "coredns-custom",
            namespace: "kube-system",
            labels: { [ownerLabel]: owner },
          },
          data: { [dnsKey]: dnsValue },
        }),
      });
    }
    const after = await dns();
    assert.equal(after.data[dnsKey], dnsValue);
    dnsUid = after.metadata.uid;
    await record();
    await kube(["-n", "kube-system", "rollout", "restart", "deployment/coredns"]);
    await kube(["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=120s"], {
      timeout: 150_000,
    });
    return {
      modelKey,
      codexImage: reference,
      providerImage,
      directory: root,
      async arm({ marker, timeoutMs = 300_000 }) {
        assert.equal(armDispatched, false, "Only one barrier may be armed");
        armDispatched = true;
        const reply = await control({ op: "arm", marker, timeoutMs });
        gateId = reply.gateId;
        assert.equal(reply.state, "armed");
        return reply;
      },
      status: ({ gateId: expected }) => {
        assert.ok(gateId && expected === gateId, "Wrong provider gate");
        return control({ op: "status", gateId });
      },
      release: ({ gateId: expected }) => {
        assert.ok(gateId && expected === gateId, "Wrong provider gate");
        assert.equal(releaseDispatched, false, "Release cannot be replayed");
        releaseDispatched = true;
        return control({ op: "release", gateId });
      },
    };
  })();
  return preparation;
}
