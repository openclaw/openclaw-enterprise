import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGGING_LEVELS,
  type AgentRevision,
  type ComputeRevisionContext,
  type OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import {
  callKubernetesFixtureMethod,
  credentialFixture,
  digest,
  namespace,
  type NamespaceTarget,
} from "./kubernetes-runtime-credentials-fixture.ts";

export function registerGatewayPasswordProjection(): void {
  test("embedded Gateway uses the separate canonical password source", () => {
    const { driver, namespaceName } = credentialFixture();
    const agentId = "agent-password-projection";
    const suffix = digest(agentId);
    const revision = {
      id: "revision-password-projection",
      namespaceId: namespace.id,
      agentId,
      revision: 1,
      backendId: null,
      executionAdmission: { version: 2, mode: "unprotected" },
      configurationId: "cfg_runtime_password_projection",
      configurationKind: "agent",
      configurationGeneration: 1,
      gatewayManagedMode: true,
      configuration: {
        logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
        diagnostics: { otel: { logs: false } },
        agents: { defaults: { model: "openai/gpt-5" } },
      },
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
      harnessAuth: {
        method: "api_key",
        source: { kind: "secret", namespaceId: namespace.id, id: "secret-model" },
        secretDriverId: "kubernetes-secret",
      },
      compute: { id: driver.id, implementation: driver.implementation },
      servicePrincipalId: "service-principal-password-projection",
      createdAt: namespace.createdAt,
    } satisfies AgentRevision;
    const target: NamespaceTarget = { name: namespaceName, plane: "execution" };
    const authContext: ComputeRevisionContext = {
      secretEnvironment: [],
      harnessAuth: {
        ...revision.harnessAuth,
        backendRef: { namespaceName, name: "occ-secret-model", key: "value", uid: "model-uid" },
      },
    };
    const gatewayEnvironment = (configuration: OpenClawConfigurationDocument) => {
      const configured = {
        ...revision,
        configuration: { ...revision.configuration, ...configuration },
      };
      const snapshot = callKubernetesFixtureMethod(driver, "gatewayConfiguration", [configured]);
      const observedLevel = asRecord(snapshot)?.loggingLevel;
      const loggingLevel = LOGGING_LEVELS.find((level) => level === observedLevel);
      assert.ok(loggingLevel, "Gateway configuration must supply its logging level");
      const auth = callKubernetesFixtureMethod(driver, "harnessAuthForRevision", [
        revision,
        authContext,
        target,
      ]);
      const gateway = callKubernetesFixtureMethod(driver, "deployment", [
        `gateway-${suffix}`,
        { namespaceId: namespace.id, agentId },
        target,
        "openclaw-enterprise/gateway-fixture:local",
        `agent-${suffix}`,
        "gateway",
        {},
        loggingLevel,
        snapshot,
        true,
        revision.servicePrincipalId,
        auth,
      ]);
      const template = asRecord(asRecord(asRecord(gateway)?.spec)?.template);
      const containers = asRecord(template?.spec)?.containers;
      assert.ok(Array.isArray(containers), "Gateway Deployment must have containers");
      const podContainers: readonly unknown[] = containers;
      const gatewayContainer = podContainers[0];
      const environment = asRecord(gatewayContainer)?.env;
      assert.ok(Array.isArray(environment), "Gateway container must have environment entries");
      const entries: readonly unknown[] = environment;
      return Object.fromEntries(
        entries.map((value) => {
          const entry = asRecord(value);
          assert.ok(typeof entry?.name === "string", "Gateway environment entry must have a name");
          return [entry.name, entry] as const;
        }),
      );
    };

    assert.equal(gatewayEnvironment({}).OPENCLAW_GATEWAY_PASSWORD, undefined);
    // On the default env alias, and on an env provider the revision's secrets configure, which
    // OpenClaw also reads from the Gateway's environment (finding 3057).
    const providers = [
      ["default", undefined],
      ["vault", { providers: { vault: { source: "env" } } }],
    ] as const satisfies readonly (readonly [
      string,
      OpenClawConfigurationDocument["secrets"] | undefined,
    ])[];
    for (const [provider, secrets] of providers) {
      const password = gatewayEnvironment({
        gateway: {
          auth: { password: { source: "env", provider, id: "OPENCLAW_GATEWAY_PASSWORD" } },
        },
        ...(secrets === undefined ? {} : { secrets }),
      }).OPENCLAW_GATEWAY_PASSWORD;
      assert.deepEqual(
        asRecord(password?.valueFrom)?.secretKeyRef,
        { name: `gateway-password-${suffix}`, key: "gateway-password" },
        provider,
      );
    }
    assert.throws(
      () =>
        callKubernetesFixtureMethod(driver, "gatewayConfiguration", [
          {
            ...revision,
            configuration: {
              ...revision.configuration,
              gateway: { auth: { password: "static-password" } },
            },
          } satisfies AgentRevision,
        ]),
      /OPENCLAW_GATEWAY_PASSWORD/i,
    );
  });
}
