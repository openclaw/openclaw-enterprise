import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import type { TestContext } from "node:test";
import { dockerTrial, sourceCommit } from "../../deploy/examples/opensandbox/docker/sandbox.mts";
import type { FixtureCommandResult } from "../fixtures/repository-credentials/process.ts";

const ownerLabel = "openclaw.dev/opensandbox-git-probe";
const fixtureToken = /fixture_access_[0-9a-f]{48}/u;

function required(name: string): string {
  const value = process.env[name];
  assert(value, "Set " + name);
  return value;
}

const forwarder = String.raw`
const net = require("node:net");
net.createServer((client) => {
  const upstream = net.connect("/run/git-peer/peer.sock");
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(Number(process.argv[1]), "127.0.0.1");
`;

const gitRunner = String.raw`
const { execFile } = require("node:child_process");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { args, ca } = JSON.parse(readFileSync(0, "utf8"));
const workspace = "/tmp/oce-opensandbox-git";
if (ca !== undefined) {
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(workspace + "/ca.crt", ca, { mode: 0o600, flag: "wx" });
}
const env = {
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  HOME: workspace,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSL_CAINFO: workspace + "/ca.crt",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
};
execFile("git", ["-C", workspace, ...args], { env, timeout: 15000 }, (error, stdout, stderr) => {
  if (error && typeof error.code !== "number") {
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ code: error ? error.code : 0, stdout, stderr }));
});
`;

const checkCustody = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const { networkInterfaces } = require("node:os");
const { port } = JSON.parse(fs.readFileSync(0, "utf8"));
const token = /fixture_access_[0-9a-f]{48}/u;
const protectedNames = /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_APP_PRIVATE_KEY)$/u;
assert.equal(process.getuid(), 1000);
assert(!Object.values(networkInterfaces()).flat().some((address) => !address.internal));
assert(!Object.keys(process.env).some((name) => protectedNames.test(name)));
assert(!Object.values(process.env).some((value) => token.test(value)));
const status = fs.readFileSync("/proc/self/status", "utf8");
assert.match(status, /^CapEff:\s*0+$/mu);
assert.match(status, /^NoNewPrivs:\s*1$/mu);
let files = 0;
let bytes = 0;
function visit(path, depth) {
  assert(depth <= 16);
  if (!fs.existsSync(path)) {
    return;
  }
  const file = fs.lstatSync(path);
  if (file.isDirectory()) {
    fs.readdirSync(path).forEach((name) => visit(path + "/" + name, depth + 1));
  } else if (file.isFile()) {
    assert(++files <= 2000);
    assert((bytes += file.size) <= 20_000_000);
    assert(!token.test(fs.readFileSync(path, "latin1")));
  }
}
for (const path of ["/tmp/oce-opensandbox-git", "/home/node"]) {
  visit(path, 0);
}
for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/u.test(name))) {
  for (const field of ["cmdline", "environ"]) {
    try {
      assert(!token.test(fs.readFileSync("/proc/" + pid + "/" + field, "latin1")));
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) {
        throw error;
      }
    }
  }
}
const bypass = net.connect({ host: "127.0.0.1", port });
bypass.on("connect", () => {
  bypass.destroy();
  throw new Error("Direct origin unexpectedly reachable.");
});
bypass.on("error", (error) => {
  assert.equal(error.code, "ECONNREFUSED");
  console.log(JSON.stringify({ files, bytes, directOrigin: error.code }));
});
`;

type Workload = {
  Image: string;
  Config: { User: string; Labels: Record<string, string>; Env: string[] };
  HostConfig: { NetworkMode: string; Privileged: boolean; CapDrop: string[] };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
};

export async function startOpenSandboxGit(
  t: TestContext,
  { peer, origin, certFile }: { peer: URL; origin: URL; certFile: string },
) {
  for (const address of [peer, origin]) {
    assert.equal(address.hostname, "127.0.0.1");
    assert.equal(address.protocol, "https:");
  }
  assert.notEqual(peer.port, origin.port);

  const source = required("OCC_TEST_OPENSANDBOX_GIT_SOURCE");
  const python = required("OCC_TEST_OPENSANDBOX_GIT_PYTHON");
  assert(isAbsolute(source) && isAbsolute(python), "Use absolute paths to OpenSandbox and Python.");
  const image = required("OCC_TEST_OPENSANDBOX_GIT_IMAGE");
  const execd = required("OCC_TEST_OPENSANDBOX_GIT_EXECD_IMAGE");
  const trial = await dockerTrial(source, python, image, execd, ownerLabel);
  const { allocation, docker, imageId, directory } = trial;
  const mount = join(directory, "peer");
  const socket = join(mount, "peer.sock");
  const clients = new Set<Socket>();
  const relay = createServer((client) => {
    clients.add(client);
    const upstream = connect(Number(peer.port), "127.0.0.1");
    client.on("close", () => {
      clients.delete(client);
      upstream.destroy();
    });
    client.on("error", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  t.after(async () => {
    try {
      clients.forEach((client) => client.destroy());
      if (relay.listening) {
        await new Promise<void>((done, fail) =>
          relay.close((error) => (error ? fail(error) : done())),
        );
      }
    } finally {
      const result = await trial.close();
      if (result) {
        assert.equal(result.deleteStatus, 204, "The OpenSandbox delete reply was lost.");
        t.diagnostic("OpenSandbox delete and Docker readback confirmed workload removal.");
      }
    }
  });
  assert(Buffer.byteLength(socket) < 108, "Use a shorter TMPDIR for the fixture socket.");
  await mkdir(mount, { mode: 0o700 });
  relay.listen(socket);
  await once(relay, "listening");
  await chmod(socket, 0o600);
  const { id, container } = await trial.start({
    network: "none",
    memory: "512Mi",
    mount: { source: mount, destination: "/run/git-peer" },
    entrypoint: ["node", "-e", forwarder, peer.port],
    env: { HOME: "/home/node" },
  });
  const [observed] = JSON.parse(await docker(["container", "inspect", container])) as [Workload];
  assert.equal(observed.Image, imageId);
  assert.equal(observed.Config.User, "node");
  assert.equal(observed.Config.Labels["opensandbox.io/id"], id);
  assert.equal(observed.Config.Labels[ownerLabel], allocation);
  assert.equal(observed.HostConfig.NetworkMode, "none");
  assert.equal(observed.HostConfig.Privileged, false);
  assert.deepEqual(observed.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(
    observed.Mounts.map(({ Source, Destination, RW }) => ({ Source, Destination, RW })),
    [{ Source: mount, Destination: "/run/git-peer", RW: false }],
  );
  assert(!fixtureToken.test(JSON.stringify(observed.Config.Env)));
  t.diagnostic("OpenSandbox " + sourceCommit + " sandbox " + id + " uses image " + image);

  async function execute(program: string, input: object): Promise<unknown> {
    const output = await docker(
      ["exec", "-i", "-u", "1000:1000", container, "node", "-e", program],
      JSON.stringify(input),
    );
    assert(!fixtureToken.test(output), "Synthetic upstream token appeared in workload output.");
    return JSON.parse(output);
  }
  let ca: string | undefined = await readFile(certFile, "utf8");
  return {
    async git(args: string[], allowFailure = false): Promise<FixtureCommandResult> {
      const result = (await execute(gitRunner, { args, ca })) as FixtureCommandResult;
      ca = undefined;
      if (!allowFailure) {
        assert.equal(result.code, 0, "Git command failed inside OpenSandbox.");
      }
      return result;
    },
    proveCustody: () => execute(checkCustody, { port: Number(origin.port) }),
  };
}
