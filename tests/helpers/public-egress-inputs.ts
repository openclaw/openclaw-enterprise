import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { OpenShellBackendConfiguration } from "@openclaw-enterprise/contracts";

import {
  validateConnectedDatabaseUrl,
  validatePublicEgressObserver,
} from "./egress-connected-inputs.mjs";

const execute = promisify(execFile);
const imageNames = [
  "agent",
  "controller",
  "gateway",
  "openShellGateway",
  "sandbox",
  "supervisor",
] as const;

export type PublicTcp = { url: string; expectedBodySha256: string };

type Inputs = {
  version: 1;
  apiOrigin: string;
  installationId: string;
  namespaceId: string;
  modelSourceId: string;
  model: string;
  repositoryRef: string;
  repository: string;
  repositoryPermissions: Readonly<Record<string, boolean>> & { pull: boolean };
  expectedGitHubAppId: string;
  expectedGitHubInstallationId: string;
  custodySecretNames: string[];
  publicTcp: PublicTcp;
  kubeconfigPath: string;
  kubernetesContext: string;
  clusterUID: string;
  controllerNamespace: string;
  controllerSelector: string;
  openShellGatewayNamespace: string;
  openShellGatewaySelector: string;
  openShellBackend: OpenShellBackendConfiguration;
  images: Record<(typeof imageNames)[number], string>;
  oceCommit: string;
  evidenceDirectory: string;
  pauseForAcceptance?: boolean;
};

export async function readPublicEgressInputs(signal: AbortSignal) {
  const { OCC_TEST_PUBLIC_EGRESS_INPUTS: path, OCC_TEST_PUBLIC_EGRESS_SERVICE_KEY: serviceKey } =
    process.env;
  // The operator key belongs to the runner. Child processes receive no copy.
  delete process.env.OCC_TEST_PUBLIC_EGRESS_SERVICE_KEY;
  assert.ok(serviceKey && !/\s/u.test(serviceKey), "provide the scoped controller key separately");
  assert.ok(path && isAbsolute(path), "provide the absolute public egress input path");
  const input: Inputs = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
  assert.equal(input.version, 1);
  const publicTcp = new URL(input.publicTcp.url);
  assert.equal(publicTcp.protocol, "https:");
  assert.ok(
    publicTcp.port && !["80", "443"].includes(publicTcp.port),
    "provide a controlled public TCP endpoint on a nonstandard port",
  );
  assert.equal(publicTcp.username + publicTcp.password, "");
  const hostname = publicTcp.hostname.replace(/\.$/u, "");
  assert.ok(
    hostname.includes(".") && isIP(hostname) === 0 && !hostname.endsWith(".localhost"),
    "the controlled endpoint requires a public DNS hostname",
  );
  assert.match(input.publicTcp.expectedBodySha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    Array.isArray(input.custodySecretNames) &&
      input.custodySecretNames.length > 0 &&
      input.custodySecretNames.every((name) => typeof name === "string" && name.length > 0),
    "identify the worker/model custody Secrets to exclude from workloads",
  );
  assert.ok(
    input.repositoryPermissions &&
      typeof input.repositoryPermissions.pull === "boolean" &&
      Object.values(input.repositoryPermissions).every(
        (permission) => typeof permission === "boolean",
      ),
  );
  assert.match(input.expectedGitHubAppId, /^[0-9]+$/u);
  assert.match(input.expectedGitHubInstallationId, /^[0-9]+$/u);
  assert.ok(
    input.pauseForAcceptance === undefined || typeof input.pauseForAcceptance === "boolean",
  );
  const origin = new URL(input.apiOrigin);
  assert.equal(origin.hostname, "127.0.0.1");
  assert.ok(["http:", "https:"].includes(origin.protocol) && Number(origin.port) > 1024);
  assert.equal(origin.origin, input.apiOrigin);
  assert.ok(isAbsolute(input.evidenceDirectory) && isAbsolute(input.kubeconfigPath));
  assert.match(input.namespaceId, /^ns_[A-Za-z0-9_-]+$/u);
  assert.match(input.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { signal });
  assert.equal(stdout.trim(), input.oceCommit);
  assert.deepEqual(Object.keys(input.images).sort(), [...imageNames].sort());
  for (const image of Object.values(input.images)) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/u);
  }
  for (const namespace of [input.controllerNamespace, input.openShellGatewayNamespace]) {
    assert.match(namespace, /^[a-z0-9-]+$/u);
  }
  for (const selector of [input.controllerSelector, input.openShellGatewaySelector]) {
    assert.ok(typeof selector === "string" && selector.length > 0 && !/[\r\n]/u.test(selector));
  }
  for (const id of [
    input.installationId,
    input.modelSourceId,
    input.repositoryRef,
    input.model,
    input.clusterUID,
  ]) {
    assert.ok(typeof id === "string" && id.length > 0);
  }
  const supplierEndpoint = validatePublicEgressObserver(input.openShellBackend);
  const databaseUrl = validateConnectedDatabaseUrl(process.env.OCC_TEST_DATABASE_URL);
  return { input, serviceKey, supplierEndpoint, databaseUrl };
}

export type PublicEgressInputs = Awaited<ReturnType<typeof readPublicEgressInputs>>;
