import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { writeCommand } from "../helpers/fake-commands.ts";

const clusterArn = "arn:aws:eks:us-west-2:123456789012:cluster/oce-test";
const endpoint = "https://eks.example.test";
const ca = Buffer.from("fixture authority").toString("base64");

async function inventory(t: TestContext, fault: "wrong-ca" | "ec2-page" | "preferences-managed") {
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
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: directory,
        FAULT: fault,
        ...(fault === "preferences-managed" ? {} : { KUBECTL_KUBERC: "false" }),
      },
    },
  );
  assert.ifError(result.error);
  return { ...result, awsLog, proxyLog };
}

test("EKS inventory refuses mixed-cluster and partial provider observations", async (t) => {
  await t.test("wrong-ca", async (child) => {
    const { status, stdout, stderr, awsLog, proxyLog } = await inventory(child, "wrong-ca");
    assert.equal(status, 2, stderr);
    assert.equal(stdout, "");
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
    const { status, stdout, stderr, awsLog } = await inventory(child, "ec2-page");
    assert.equal(status, 2, stderr);
    assert.equal(stdout, "");
    assert.match(stderr, /webhook-addresses:.*inventory is incomplete/u);
    assert.equal(
      await readFile(awsLog, "utf8"),
      "sts get-caller-identity\neks describe-cluster\nec2 describe-network-interfaces\n",
    );
  });
});

test("EKS inventory requires the credential owner's opt-in before provider or API reads", async (t) => {
  const { status, stdout, stderr, awsLog, proxyLog } = await inventory(t, "preferences-managed");
  assert.equal(status, 2, stderr);
  assert.equal(stdout, "");
  assert.match(stderr, /requires explicit KUBECTL_KUBERC=false/u);
  await assert.rejects(readFile(awsLog), { code: "ENOENT" });
  await assert.rejects(readFile(proxyLog), { code: "ENOENT" });
});
