import assert from "node:assert/strict";
import type { OpenShellSandboxResponse } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { Agent, AgentRevision } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

interface SandboxSpec extends Record<string, unknown> {
  providers: string[];
  environment: Record<string, unknown>;
  policy: Record<string, unknown>;
}

function assertSandboxSpec(value: unknown): asserts value is SandboxSpec {
  const spec = asRecord(value);
  assert.ok(spec, "the gateway returned a Sandbox spec");
  const providers = spec.providers;
  assert.ok(Array.isArray(providers), "Sandbox providers must be an array");
  const names: readonly unknown[] = providers;
  assert.ok(
    names.every((name) => typeof name === "string"),
    "Sandbox providers must be names",
  );
  assert.ok(asRecord(spec.environment), "the Sandbox has an environment");
  assert.ok(asRecord(spec.policy), "the Sandbox has a creation policy");
}

export function observedSandbox(
  box: OpenShellSandboxResponse | undefined,
): OpenShellSandboxResponse & { spec: SandboxSpec } {
  assert.ok(box, "the gateway retained the selected Sandbox");
  const spec = box.spec;
  assertSandboxSpec(spec);
  return Object.assign(box, { spec });
}

export function gitMiddleware(
  policy: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const raw = policy.network_middlewares;
  if (raw === undefined) {
    return undefined;
  }
  const middlewares = asRecord(raw);
  assert.ok(middlewares, "the gateway policy has a middleware map");
  const value = middlewares["oce-prepared-git"];
  if (value === undefined) {
    return undefined;
  }
  const middleware = asRecord(value);
  assert.ok(middleware, "the prepared Git middleware is a record");
  return middleware;
}

export function gitBinding(policy: Readonly<Record<string, unknown>>): string | undefined {
  const middleware = gitMiddleware(policy);
  if (!middleware) {
    return undefined;
  }
  const config = asRecord(middleware.config);
  const fields = asRecord(config?.fields);
  const binding = asRecord(fields?.binding_id);
  assert.ok(binding && typeof binding.stringValue === "string", "the middleware has a binding ID");
  return binding.stringValue;
}

export function deletingAgent(revision: AgentRevision): Agent {
  const auth = revision.harnessAuth;
  assert.ok(auth.method === "credential_source");
  return {
    id: revision.agentId,
    namespaceId: revision.namespaceId,
    name: "managed-git-agent",
    desiredRuntimeState: "stopped",
    status: "deleting",
    configurationId: revision.configurationId,
    backendId: revision.backendId,
    harnessAuth: { method: "credential_source", sourceId: auth.sourceId },
    executionMode: revision.harness.mode,
    gatewayManagedMode: revision.gatewayManagedMode,
    servicePrincipalId: revision.servicePrincipalId,
    createdAt: revision.createdAt,
  };
}
