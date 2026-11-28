import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";

const clusterArn = "arn:aws:eks:us-west-2:123456789012:cluster/oce-test";
const endpoint = "https://eks.example.test";
const ca = Buffer.from("fixture authority").toString("base64");

async function rejectedInventory(
  t: TestContext,
  fault: "wrong-ca" | "ec2-page" | "preferences-managed",
) {
  const directory = await mkdtemp(join(tmpdir(), "oce-address-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const awsLog = join(directory, "provider-reads");
  const proxyLog = join(directory, "api-reads");
  const kubeconfig = join(directory, "kubeconfig");
  const helpers = { interpreter: process.execPath };
  await writeCommand(
    directory,
    "aws",
    `const { appendFileSync } = require("node:fs");
const [service, operation, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(awsLog)}, service + " " + operation + "\\n");
if (!args.includes("--region") || args[args.indexOf("--region") + 1] !== "us-west-2") process.exit(9);
if (service === "eks" && args[args.indexOf("--name") + 1] !== "oce-test") process.exit(9);
if (service === "ec2" && !["Name=vpc-id,Values=vpc-1234", "Name=group-id,Values=sg-abcd",
    "Name=description,Values=Amazon EKS oce-test"].every((filter) => args.includes(filter))) process.exit(9);
const responses = {
  "sts get-caller-identity": { Account: "123456789012" },
  "eks describe-cluster": { cluster: {
    arn: ${JSON.stringify(clusterArn)},
    name: "oce-test",
    endpoint: ${JSON.stringify(endpoint)},
    certificateAuthority: { data: ${JSON.stringify(ca)} },
    resourcesVpcConfig: { vpcId: "vpc-1234", clusterSecurityGroupId: "sg-abcd" },
  } },
  "ec2 describe-network-interfaces": {
    NetworkInterfaces: [{ PrivateIpAddresses: [{ PrivateIpAddress: "10.1.2.2" }] }],
    ...(process.env.FAULT === "ec2-page" ? { NextToken: "pending" } : {}),
  },
};
const response = responses[service + " " + operation];
if (!response) process.exit(10);
process.stdout.write(JSON.stringify(response));`,
    helpers,
  );
  // These cases supply only the local kubeconfig view. In the genuine transport
  // suite, real kubectl supplies both the view and API responses over TLS.
  await writeCommand(
    directory,
    "kubectl",
    `const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("config")) {
  appendFileSync(${JSON.stringify(proxyLog)}, "attempted API read\\n");
  process.exit(11);
}
if (args[1] !== ${JSON.stringify(kubeconfig)} || args[3] !== "oce-test") process.exit(12);
process.stdout.write(JSON.stringify({
  "current-context": "oce-test",
  clusters: [{ cluster: {
    server: ${JSON.stringify(endpoint)},
    "certificate-authority-data": process.env.FAULT === "wrong-ca" ? "different" : ${JSON.stringify(ca)},
  } }],
  users: [{ user: { exec: { command: "aws" } } }],
}));`,
    helpers,
  );
  const stderr = expectInventoryFailure(kubeconfig, {
    PATH: directory,
    FAULT: fault,
    ...(fault === "preferences-managed" ? {} : { KUBECTL_KUBERC: "false" }),
  });
  return { stderr, awsLog, proxyLog };
}

function expectInventoryFailure(kubeconfig: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/diagnose-kubernetes-prerequisites.ts",
      "--inventory-eks",
      clusterArn,
      "--kubeconfig",
      kubeconfig,
      "--context",
      "oce-test",
      ...args,
    ],
    { encoding: "utf8", timeout: 15_000, env },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  return result.stderr;
}

test("EKS inventory refuses mixed-cluster and partial provider observations", async (t) => {
  await t.test("wrong-ca", async (child) => {
    const { stderr, awsLog, proxyLog } = await rejectedInventory(child, "wrong-ca");
    assert.match(stderr, /eks-cluster-identity:.*TLS endpoint or CA/u);
    assert.match(
      stderr,
      /^ +Next: Verify the named EKS cluster and selected kubeconfig endpoint or tunnel TLS server name;/mu,
    );
    assert.equal(await readFile(awsLog, "utf8"), "sts get-caller-identity\neks describe-cluster\n");
    // A mismatched CA must stop collection before any Kubernetes API read.
    await assert.rejects(readFile(proxyLog), { code: "ENOENT" });
  });
  await t.test("ec2-page", async (child) => {
    const { stderr, awsLog } = await rejectedInventory(child, "ec2-page");
    assert.match(stderr, /webhook-addresses:.*inventory is incomplete/u);
    assert.equal(
      await readFile(awsLog, "utf8"),
      "sts get-caller-identity\neks describe-cluster\nec2 describe-network-interfaces\n",
    );
  });
});

test("EKS inventory requires the credential owner's opt-in before provider or API reads", async (t) => {
  const { stderr, awsLog, proxyLog } = await rejectedInventory(t, "preferences-managed");
  assert.match(stderr, /requires explicit KUBECTL_KUBERC=false/u);
  await assert.rejects(readFile(awsLog), { code: "ENOENT" });
  await assert.rejects(readFile(proxyLog), { code: "ENOENT" });
});

const denyAll = {
  apiVersion: "kubectl.config.k8s.io/v1beta1",
  kind: "Preference",
  credentialPluginPolicy: "DenyAll",
};

test("required kuberc rejects invalid policy or a conflicting opt-out before any command runs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-inventory-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, "commands");
  for (const name of ["aws", "kubectl"]) {
    await writeCommand(directory, name, "exit 1", { log: calls });
  }
  const path = join(directory, "kuberc");
  const valid = JSON.stringify(denyAll);
  for (const [contents, gate] of [
    [valid.slice(0, -1), undefined],
    [`{"credentialPluginPolicy":"AllowAll",${valid.slice(1)}`, undefined],
    [
      JSON.stringify({
        ...denyAll,
        defaults: [{ command: "proxy", options: [{ name: "address", default: "0.0.0.0" }] }],
      }),
      undefined,
    ],
    [
      JSON.stringify({
        ...denyAll,
        credentialPluginPolicy: "Allowlist",
        credentialPluginAllowlist: [{ command: "aws" }],
      }),
      undefined,
    ],
    [valid, "false"],
  ] as const) {
    await writeFile(path, contents);
    const stderr = expectInventoryFailure(
      join(directory, "kubeconfig"),
      { PATH: directory, KUBERC: path, KUBECTL_KUBERC: gate },
      "--require-kuberc",
    );
    assert.match(stderr, /kuberc/iu);
    await assert.rejects(readFile(calls), { code: "ENOENT" });
  }
});

test("required kuberc rejects unqualified kubectl releases and platforms before reading the selected context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-inventory-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = join(directory, "kuberc");
  await writeFile(policy, JSON.stringify(denyAll));
  // Only the client version probe should run. Genuine supported clients exercise
  // both plugin policies in the installation prerequisite transport suite.
  const calls = join(directory, "commands");
  await writeCommand(directory, "kubectl", `printf '%s\\n' "$CLIENT_VERSION"`, { log: calls });
  await writeCommand(directory, "aws", "exit 1", { log: calls });
  const client = {
    major: "1",
    minor: "36",
    gitVersion: "v1.36.4",
    gitTreeState: "clean",
    platform: "linux/amd64",
  };
  for (const change of [
    { gitVersion: "v1.36.5" },
    { minor: "35", gitVersion: "v1.35.1" },
    { platform: "linux/arm64" },
    { platform: "darwin/amd64" },
  ]) {
    await rm(calls, { force: true });
    const stderr = expectInventoryFailure(
      join(directory, "kubeconfig"),
      {
        PATH: directory,
        KUBERC: policy,
        CLIENT_VERSION: JSON.stringify({ clientVersion: { ...client, ...change } }),
      },
      "--require-kuberc",
    );
    const [probe, ...laterCalls] = await commandCalls(calls);
    assert.ok(probe?.includes("--kubeconfig /dev/null version --client"));
    assert.deepEqual(laterCalls, [], JSON.stringify(change));
    assert.match(stderr, /stock kubectl/u);
  }
});
