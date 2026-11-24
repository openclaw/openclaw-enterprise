import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { isIPv4 } from "node:net";
import { dockerTrial, sourceCommit } from "./sandbox.mts";

const [sourceArg, pythonArg, runtimeImage, execdImage, ...extra] = process.argv.slice(2);
assert(
  sourceArg && pythonArg && runtimeImage && execdImage && extra.length === 0,
  "Usage: node probe.mts OPENSANDBOX_SOURCE VENV_PYTHON OCE_IMAGE EXECD_IMAGE",
);
const subnet = process.env.OCE_OPENSANDBOX_PROBE_SUBNET;
const label = "openclaw.dev/opensandbox-probe";
const appPort = 18790;
const execdToken = randomBytes(32).toString("hex");
const codexToken = randomBytes(32).toString("hex");
const wrongToken = randomBytes(32).toString("hex");
const verifier = createHash("sha256").update(codexToken).digest("hex");
const peerCode = stripTypeScriptTypes(
  readFileSync(new URL("./peer.mts", import.meta.url), "utf8"),
  {
    mode: "strip",
  },
);

type Workload = {
  Image: string;
  Path: string;
  Args: string[];
  Mounts: unknown[];
  Config: { Labels: Record<string, string>; Env: string[]; User: string };
  HostConfig: {
    CapDrop: string[];
    NetworkMode: string;
    PortBindings?: Record<string, { HostIp: string }[]>;
    Privileged: boolean;
    SecurityOpt: string[];
  };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string; NetworkID: string }>;
  };
};
function receipt(check: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ check, ...details }));
}

const trial = await dockerTrial(sourceArg, pythonArg, runtimeImage, execdImage, label);
const { allocation, ownership, docker, containers } = trial;
const networkName = "oce-opensandbox-" + allocation;
const peerName = networkName + "-peer";
let networkId: string | undefined;
let failed = false;
receipt("trial", {
  allocation,
  network: networkName,
  source: sourceCommit,
  runtimeImage,
  execdImage,
});
try {
  networkId = await docker([
    "network",
    "create",
    "--internal",
    "--ipv6=false",
    ...(subnet === undefined ? [] : ["--subnet", subnet]),
    "--label",
    ownership,
    networkName,
  ]);
  assert.match(networkId, /^[a-f0-9]{64}$/u);
  assert.equal(
    await docker(["network", "inspect", "--format", "{{.Internal}}", networkId]),
    "true",
  );
  const { id: sandboxId, container: workloadId } = await trial.start({
    network: networkName,
    memory: "768Mi",
    entrypoint: [
      "codex",
      "-c",
      'otel.exporter="none"',
      "app-server",
      "--listen",
      "ws://127.0.0.1:" + appPort,
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      verifier,
    ],
    env: { HOME: "/home/node", EXECD_ACCESS_TOKEN: execdToken },
  });
  receipt("sandbox-created", { sandboxId });
  const sandboxPath = "/v1/sandboxes/" + sandboxId;
  const [workload] = JSON.parse(await docker(["container", "inspect", workloadId])) as [Workload];
  assert.equal(workload.Config.Labels["opensandbox.io/id"], sandboxId);
  assert.equal(workload.Image, trial.imageId);
  assert.equal(workload.Config.User, "node");
  assert.equal(workload.HostConfig.NetworkMode, networkName);
  assert.equal(workload.HostConfig.Privileged, false);
  assert.equal(workload.Mounts.length, 0);
  assert.match(workload.Path, /\/bootstrap\.sh$/u);
  assert.equal(workload.Args[0], "codex");
  assert(workload.HostConfig.SecurityOpt.includes("no-new-privileges=true"));
  assert(workload.HostConfig.CapDrop.includes("ALL"));
  assert(workload.Args.includes(verifier));
  assert(
    workload.Config.Env.every(
      (item) =>
        !item.includes(codexToken) &&
        !/^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN|APP_SERVER_TOKEN)=/u.test(
          item,
        ),
    ),
  );
  assert(workload.Args.every((item) => !item.includes(codexToken)));
  for (const bindings of Object.values(workload.HostConfig.PortBindings ?? {})) {
    for (const binding of bindings ?? []) {
      assert.equal(binding.HostIp, "127.0.0.1");
    }
  }
  assert.deepEqual(Object.keys(workload.NetworkSettings.Networks), [networkName]);
  assert.doesNotMatch(
    await docker(["exec", workloadId, "cat", "/proc/net/route"]),
    /^\S+\s+00000000\s+/mu,
    "The sandbox must have no IPv4 default route.",
  );
  const network = workload.NetworkSettings.Networks[networkName];
  assert(network && network.NetworkID === networkId);
  assert(isIPv4(network.IPAddress));

  const discovered = await trial.api(sandboxPath + "/endpoints/" + appPort);
  assert.equal(discovered.status, 200);
  const endpoint = new URL("ws://" + ((await discovered.json()) as { endpoint: string }).endpoint);
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.equal(endpoint.pathname, "/proxy/" + appPort);
  assert.equal(endpoint.search, "");
  const peerEndpoint = "ws://" + network.IPAddress + ":44772" + endpoint.pathname;
  const codexVersion = await docker(["exec", workloadId, "codex", "--version"]);
  assert.match(codexVersion, /^codex-cli \d+\.\d+\.\d+/u);

  // Give the peer the synthetic authentication inputs on stdin.
  const result = await docker(
    [
      "run",
      "--rm",
      "-i",
      "--pull",
      "never",
      "--name",
      peerName,
      "--label",
      ownership,
      "--network",
      networkName,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "64",
      "--memory",
      "128m",
      "--entrypoint",
      "node",
      runtimeImage,
      "--input-type=module",
      "--eval",
      peerCode,
    ],
    JSON.stringify({
      endpoint: peerEndpoint,
      execdToken,
      codexToken,
      wrongToken,
    }),
  );
  const outcome: unknown = JSON.parse(result);
  assert.deepEqual(outcome, {
    initialized: true,
    missingExecd: 401,
    missingCodex: 401,
    wrongCodex: 401,
  });
  receipt("codex-peer", { version: codexVersion, result: outcome });
} catch (error) {
  failed = true;
  const message = error instanceof Error ? error.message : "Unknown failure";
  const sanitized = [execdToken, codexToken, wrongToken, verifier].reduce(
    (value, secret) => value.replaceAll(secret, "[redacted]"),
    message,
  );
  console.error("OpenSandbox probe failed: " + sanitized.slice(0, 400));
} finally {
  // A timed-out Docker CLI can leave the peer behind. Remove only the exact owned peer.
  try {
    const peers = await containers("name=^/" + peerName + "$");
    if (peers.length) {
      const owned = await trial.owned();
      assert(peers.length === 1 && owned.includes(peers[0]!));
      await docker(["container", "rm", "-f", ...peers]);
    }
  } catch {
    failed = true;
    console.error("Peer cleanup unconfirmed for " + ownership);
  }
  try {
    const deletion = await trial.close(async () => {
      const networks = await docker([
        "network",
        "ls",
        "--no-trunc",
        "--filter",
        "label=" + ownership,
        "-q",
      ]);
      if (networkId !== undefined || networks) {
        assert.match(networks, /^[a-f0-9]{64}$/u);
        if (networkId !== undefined) {
          assert.equal(networks, networkId);
        }
        assert.equal(
          await docker(["network", "inspect", "--format", "{{.Name}}", networks]),
          networkName,
        );
        await docker(["network", "rm", networks]);
        assert.equal(await docker(["network", "ls", "--filter", "label=" + ownership, "-q"]), "");
        receipt("network-cleanup", { networks: 0 });
      }
    });
    if (deletion) {
      receipt("sandbox-cleanup", deletion);
      if (deletion.deleteStatus !== 204) {
        failed = true;
      }
    }
  } catch {
    failed = true;
    console.error(
      "OpenSandbox cleanup unconfirmed for " +
        ownership +
        ". Private state retained at " +
        trial.directory,
    );
  }
}
process.exitCode = failed ? 1 : 0;
