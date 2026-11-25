import assert from "node:assert/strict";
import { isPromise } from "node:util/types";
import type { OpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
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

// Controller declarations omit private member types. Inspect only the fields used by
// these scenarios and reconcile the original entry on the worker that prepared it.
export function observeGitRuntime(git: OpenShellGitRuntime) {
  const state = asRecord(git);
  assert.ok(state?.entries instanceof Map, "the Git runtime tracks its revision entries");
  const entries: ReadonlyMap<string, unknown> = state.entries;
  const reconcile = state.reconcile;
  assert.ok(typeof reconcile === "function", "the Git runtime can reconcile entries");
  return {
    replaceWithdrawal(replacement: OpenShellGitRouteStore["withdraw"]) {
      const routes = asRecord(state.routes);
      assert.ok(routes && typeof routes.withdraw === "function", "the route store can withdraw");
      const withdraw = routes.withdraw;
      routes.withdraw = replacement;
      return () => {
        routes.withdraw = withdraw;
      };
    },
    hasEntry: (revisionId: string) => entries.has(revisionId),
    async boundEntry(revision: Readonly<AgentRevision>) {
      const pending = entries.get(revision.id);
      assert.ok(isPromise(pending), "the worker prepared the revision");
      const entry = asRecord(await pending);
      const expected = revision.repositoryCredentials?.bindings[0];
      const authorization = asRecord(entry?.authorization);
      assert.ok(entry && authorization && expected, "the revision has a Git binding");
      assert.deepEqual(authorization.binding, expected);
      const bindingId = entry.bindingId;
      const provider = asRecord(entry.binding)?.provider;
      assert.ok(typeof bindingId === "string" && bindingId, "the Git entry has a binding ID");
      assert.ok(typeof provider === "string" && provider, "the Git entry has a Provider");
      const delivery = asRecord(authorization.delivery);
      assert.ok(delivery, "the Git entry has a delivery scope");
      let contentsPermission: "read" | "write" | undefined;
      if (delivery.scope === "github-repository" || delivery.permissions !== undefined) {
        const contents = asRecord(delivery.permissions)?.contents;
        assert.ok(contents === "read" || contents === "write", "invalid Git contents permission");
        contentsPermission = contents;
      }
      return {
        bindingId,
        provider,
        contentsPermission,
        async reconcile(attempt?: "retry") {
          if (attempt === "retry") {
            assert.ok(
              Number.isFinite(entry.nextObserveAt),
              "the failed observation scheduled a retry",
            );
            entry.nextObserveAt = 0;
          }
          const result: unknown = Reflect.apply(reconcile, git, [entry]);
          assert.ok(isPromise(result), "the worker returned its reconciliation");
          await result;
        },
      };
    },
  };
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
