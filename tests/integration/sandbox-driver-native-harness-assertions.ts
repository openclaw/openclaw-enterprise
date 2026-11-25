import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellSandboxCreateRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  type HarnessWorkloadRequirements,
  type SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord, type WorkspaceNodeSetupEnvelope } from "../../packages/utils/src/index.ts";
import { type SandboxFixtureRevision } from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Dependencies = {
  t: TestContext;
  sandboxPolicy: OpenShellSandboxDriverOptions["policy"];
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options: { nodeSetupUrl: (target: SandboxFixtureRevision) => string },
  ) => {
    context: SandboxNamespaceContext;
    revision: SandboxFixtureRevision;
    requirements: HarnessWorkloadRequirements;
    runtimeManifest: string;
    codexConfig: string;
    nodeSetup: WorkspaceNodeSetupEnvelope;
  };
};

function record(value: unknown): Record<string, unknown> {
  const parsed = asRecord(value);
  assert.ok(parsed);
  return parsed;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value) && value.every((item: unknown) => typeof item === "string"));
  return value;
}

function fields(value: unknown): Record<string, unknown> {
  return record(record(value).fields);
}

function structFields(value: unknown): Record<string, unknown> {
  return fields(record(value).structValue);
}

export function verifyNativeOpenClawCreateRequest({
  request,
  expectedCommand,
  labels,
  nodeSetup,
  gatewayClient,
}: {
  request: OpenShellSandboxCreateRequest;
  expectedCommand: HarnessWorkloadRequirements["command"];
  labels: HarnessWorkloadRequirements["labels"];
  nodeSetup: ReturnType<Dependencies["runtimeSandboxFixture"]>["nodeSetup"];
  gatewayClient: Pick<ReturnType<typeof workspaceGatewayClient>, "providers" | "profiles">;
}): string {
  const template = record(request.spec.template);
  const kubernetes = structFields(fields(template.driver_config).kubernetes);
  const command = stringArray(request.spec.command);
  const environment = record(request.spec.environment);
  const policy = record(request.spec.policy);
  const filesystem = record(policy.filesystem);
  assert.equal(template.runtime_class_name, undefined);
  assert.equal(kubernetes.pod, undefined);
  assert.deepEqual(request.serviceExposures, []);
  assert.deepEqual(command.slice(0, RUNTIME_WRAPPER_COMMAND.length), RUNTIME_WRAPPER_COMMAND);
  const wrapper = command[RUNTIME_WRAPPER_COMMAND.length];
  assert.notEqual(wrapper, expectedCommand.at(-2));
  assert.match(string(wrapper), /OpenShell workspace link conflicts/);
  assert.deepEqual(request.labels, labels);
  assert.equal(environment.TMPDIR, "/tmp");
  assert.equal(filesystem.include_workdir, false);
  assert.deepEqual(filesystem.read_only, ["/app"]);
  const writablePaths = stringArray(filesystem.read_write);
  assert.ok(writablePaths.includes("/var/tmp/openclaw"));
  assert.ok(writablePaths.includes("/tmp"));
  assert.equal(stringArray(filesystem.read_only).includes("/bin"), false);
  // The real Gateway receives this mode with the Sandbox request; a weaker
  // Landlock setting could let a ready Harness run without filesystem policy.
  assert.equal(record(policy.landlock).compatibility, "hard_requirement");
  assert.equal(environment.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(environment.OPENCLAW_NODE_CA_PEM, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
  assert.match(
    string(environment.OPENCLAW_NODE_STATE_DIR),
    /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}\/state$/u,
  );
  const runtimeProvider = stringArray(request.spec.providers).find((name) =>
    name.startsWith("oce-runtime-"),
  );
  assert.ok(runtimeProvider, "the native node must receive its enrollment provider");
  assert.deepEqual(gatewayClient.providers.get(runtimeProvider)?.config, {
    node_setup_json: JSON.stringify(nodeSetup),
    node_ca_pem: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
  });
  assert.deepEqual(gatewayClient.profiles.get("oce-openclaw-runtime")?.profile?.files, [
    {
      path: "node-setup.json",
      content: "{{config.node_setup_json}}",
      environmentVariable: "OPENCLAW_NODE_SETUP_ENVELOPE",
    },
    {
      path: "node-ca.pem",
      content: "{{config.node_ca_pem}}",
      environmentVariable: "OPENCLAW_NODE_CA_PATH",
    },
  ]);
  assert.deepEqual(record(record(policy.network_policies)["workspace-node-enrollment"]).endpoints, [
    {
      host: "gateway.example.test",
      ports: [443],
      tls: "NETWORK_TLS_MODE_SKIP",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    },
  ]);
  return runtimeProvider;
}
