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

async function inventory(
  t: TestContext,
  fault?: "wrong-ca" | "ec2-page" | "api-page" | "preferences-managed",
) {
  const directory = await mkdtemp(join(tmpdir(), "oce-address-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "reads");
  const kubeconfig = join(directory, "kubeconfig");
  const helpers = { interpreter: process.execPath };
  await writeCommand(
    directory,
    "aws",
    `const [service, operation, ...args] = process.argv.slice(2);
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
    NetworkInterfaces: [
      { PrivateIpAddresses: [{ PrivateIpAddress: "10.1.2.2" }] },
      { PrivateIpAddresses: [{ PrivateIpAddress: "10.1.1.2" }, { PrivateIpAddress: "10.1.2.2" }] },
    ],
    ...(process.env.FAULT === "ec2-page" ? { NextToken: "pending" } : {}),
  },
};
const response = responses[service + " " + operation];
if (!response) process.exit(10);
process.stdout.write(JSON.stringify(response));`,
    helpers,
  );
  await writeCommand(
    directory,
    "kubectl",
    `const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[1] !== ${JSON.stringify(kubeconfig)} || args[3] !== "oce-test") process.exit(11);
const cluster = {
  server: ${JSON.stringify(endpoint)},
  "certificate-authority-data": process.env.FAULT === "wrong-ca" ? "different" : ${JSON.stringify(ca)},
};
let result;
if (args.includes("config") && args.includes("--flatten")) {
  result = [cluster];
} else if (args.includes("config")) {
  result = { clusters: [{ cluster }], users: [{ user: { exec: { command: "aws" } } }] };
} else {
  const caPath = args.find((arg) => arg.startsWith("--certificate-authority="))?.split("=")[1];
  if (!args.includes("--server=https://eks.example.test/") ||
      !args.includes("--tls-server-name=eks.example.test") ||
      !caPath || readFileSync(caPath, "utf8") !== "fixture authority") process.exit(12);
  if (args.includes("service") && args.includes("kubernetes")) {
    appendFileSync(${JSON.stringify(log)}, "service\\n");
    result = { metadata: { uid: "service-uid", name: "kubernetes", namespace: "default" },
      spec: { clusterIP: "172.20.0.1" } };
  } else if (args.includes("endpointslices.discovery.k8s.io")) {
    appendFileSync(${JSON.stringify(log)}, "slices\\n");
    result = {
      metadata: process.env.FAULT === "api-page" ? { continue: "pending" } : {},
      items: [
        { addressType: "IPv6", endpoints: [{ addresses: ["fd00::1"] }] },
        { addressType: "IPv4", endpoints: [{ addresses: ["10.0.2.2", "10.0.1.2", "10.0.2.2"] }] },
      ],
    };
  }
}
if (!result) process.exit(13);
process.stdout.write(JSON.stringify(result));`,
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
  return { ...result, log };
}

test("EKS inventory returns distinct API and webhook addresses from the bound target", async (t) => {
  const { status, stdout, stderr, log } = await inventory(t);
  assert.equal(status, 0, stderr);
  const { checkedAt, ...observed } = JSON.parse(stdout);
  assert.ok(Number.isFinite(Date.parse(checkedAt)));
  assert.deepEqual(observed, {
    context: "oce-test",
    apiCidrs: ["10.0.1.2/32", "10.0.2.2/32", "172.20.0.1/32"],
    eks: { clusterArn, webhookCidrs: ["10.1.1.2/32", "10.1.2.2/32"] },
  });
  assert.equal(await readFile(log, "utf8"), "service\nslices\n");
});

test("EKS inventory refuses mixed-cluster and partial address observations", async (t) => {
  for (const [fault, expected] of [
    ["wrong-ca", /eks-cluster-identity:.*TLS endpoint or CA/],
    ["ec2-page", /webhook-addresses:.*inventory is incomplete/],
    ["api-page", /API EndpointSlice inventory is incomplete/],
  ] as const) {
    await t.test(fault, async (child) => {
      const { status, stdout, stderr, log } = await inventory(child, fault);
      assert.equal(status, 2, stderr);
      assert.equal(stdout, "");
      assert.match(stderr, expected);
      if (fault === "wrong-ca") {
        assert.match(
          stderr,
          /^ +Next: Verify the named EKS cluster and selected kubeconfig endpoint or tunnel TLS server name;/m,
        );
        // A mismatched CA must stop collection before any Kubernetes API read.
        await assert.rejects(readFile(log), { code: "ENOENT" });
      }
    });
  }
});

test("EKS inventory requires the credential owner's opt-in before Kubernetes reads", async (t) => {
  const { status, stdout, stderr, log } = await inventory(t, "preferences-managed");
  assert.equal(status, 2, stderr);
  assert.equal(stdout, "");
  assert.match(stderr, /requires explicit KUBECTL_KUBERC=false/);
  await assert.rejects(readFile(log), { code: "ENOENT" });
});
