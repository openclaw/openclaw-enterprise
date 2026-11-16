import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import type { ControllerApp } from "../../apps/controller/src/index.ts";
import {
  ConfigurationResponse,
  ErrorResponse,
  JsonValue,
  type ComputeDriver,
  type Configuration,
  type ConfigurationDriver,
  type ConfigurationReference,
  type NamespaceWire,
  type OpenClawConfigurationDocument,
  type Principal,
} from "../../packages/contracts/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

interface HttpResponse {
  status: number;
  body: unknown;
}

// The shared in-memory fixture represents a missing row with undefined.
export type ConfigurationFixtureDriver = Omit<ConfigurationDriver, "read"> & {
  read(reference: ConfigurationReference): Promise<Configuration | undefined>;
};

interface ConfigurationSizeAdmissionFixtures {
  createConfigurationBackend(): ConfigurationFixtureDriver & {
    storedConfigurations(): Configuration[];
  };
  fixture(options: {
    configurationDriver: ConfigurationFixtureDriver;
    computeDriver: ComputeDriver;
  }): Promise<{
    app: ControllerApp;
    principal: Principal;
    controller: OpenClawController | undefined;
    namespace: NamespaceWire;
    collection: string;
  }>;
  request(
    app: ControllerApp,
    method: "POST" | "PATCH",
    path: string,
    options: { body: unknown },
  ): Promise<HttpResponse>;
  setting(path: string, requirement: string): string;
  literalKey(field: string): string;
}

function configurationData(response: HttpResponse, status: 200 | 201) {
  assert.equal(response.status, status, JSON.stringify(response.body)?.slice(0, 500));
  assert.ok(
    Check({ SafeJsonValue: JsonValue }, ConfigurationResponse, response.body),
    "expected a Configuration response",
  );
  return response.body.data;
}

function assertRefused(response: HttpResponse, message: string): void {
  assert.equal(response.status, 400, JSON.stringify(response.body)?.slice(0, 500));
  assert.ok(Check(ErrorResponse, response.body), "expected an error response");
  assert.equal(response.body.error.code, "INVALID_REQUEST");
  assert.equal(response.body.error.message, message);
}

export function registerConfigurationSizeAdmissionCases({
  createConfigurationBackend,
  fixture,
  request,
  setting,
  literalKey,
}: ConfigurationSizeAdmissionFixtures): void {
  test("Configuration save refuses a document too large to store before its content rules", async () => {
    // Finding 1317: the Kubernetes Driver's 1 MiB ConfigMap cap ran after OCC's content rules, so
    // the rules walked any document up to the 6.2 MiB request limit. OCC now asks the Driver
    // first, and HTTP names the limit instead of calling the document invalid, so the user knows
    // to shrink it. The real Kubernetes Driver checks the values here; the simple substrate stands
    // in for its ConfigMap storage.
    const kubernetes = new KubernetesConfigurationDriver({ authentication: { mode: "inCluster" } });
    const backend = createConfigurationBackend();
    const configurationDriver = {
      ...backend,
      validate: (configuration) => kubernetes.validate(configuration),
      validateSize: (values) => kubernetes.validateSize(values),
      // Agent provisioning requires exact create and inspect before it reads the plan; the size
      // refusal comes first, so neither runs.
      createExact: (configuration) => backend.create(configuration),
      inspectExact: async () => undefined,
    } satisfies ConfigurationFixtureDriver;
    const { namespace, collection, ...context } = await fixture({
      configurationDriver,
      computeDriver: createReadyComputeDriver("compute-oversized", {
        agentProvisioning: { executionModes: ["dedicated"] },
        validateAgentProvisioning() {},
        async provisionAgentRuntimeCredentials() {
          return { transportConfigured: true };
        },
        async getAgentRuntimeCredentialStatus() {
          return { transportConfigured: false };
        },
      }),
    });
    assert.ok(context.controller);
    const controller = context.controller;
    const contentRefusal = setting(
      "models.providers.openai.models",
      "must be an array of model entries",
    );
    // A document that breaks a content rule, padded to `bytes` of JSON.
    const document = (bytes: number): OpenClawConfigurationDocument => {
      const values = {
        models: { providers: { openai: { models: "gpt-5" } } },
        plugins: { entries: { knowledge: { config: { note: "" } } } },
      };
      values.plugins.entries.knowledge.config.note = "x".repeat(
        bytes - JSON.stringify(values).length,
      );
      return values;
    };
    const sizeRefusal =
      "Configuration values are too large: stored as JSON they must be smaller than 1 MiB. Remove or shorten settings, then save again.";
    const limit = 1_048_576;
    const under = document(limit - 1);
    const over = document(limit);
    const save = (method: "POST" | "PATCH", path: string, values: OpenClawConfigurationDocument) =>
      request(context.app, method, path, {
        body: method === "POST" ? { kind: "agent", values } : { values },
      });

    // Just under the cap the content rule refuses it by name; at the cap the size refusal wins.
    assertRefused(await save("POST", collection, under), contentRefusal);
    assertRefused(await save("POST", collection, over), sizeRefusal);
    await assert.rejects(
      controller.createConfiguration(context.principal.id, {
        namespaceId: namespace.id,
        kind: "agent",
        values: over,
      }),
      { name: "ConfigurationSizeError", message: sizeRefusal },
    );
    // So is the Configuration Agent provisioning creates.
    await controller.transact((state) =>
      state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    );
    const harnessSecret = await controller.createSecret(context.principal.id, {
      namespaceId: namespace.id,
      name: "oversized-agent-key",
      value: "synthetic-configuration-key",
    });
    // Called directly: the provision route's request body limit refuses a 1 MiB document first.
    await assert.rejects(
      controller.provisionAgent(context.principal.id, {
        namespaceId: namespace.id,
        requestId: "oversized-agent",
        name: "Oversized",
        executionMode: "dedicated",
        configuration: { kind: "agent", values: over },
        harnessAuth: { method: "api_key", source: harnessSecret.ref },
      }),
      { name: "ConfigurationSizeError", message: sizeRefusal },
    );

    // An update is checked in the same order.
    const created = await save("POST", collection, {});
    const item = `${collection}/${configurationData(created, 201).id}`;
    assertRefused(await save("PATCH", item, under), contentRefusal);
    assertRefused(await save("PATCH", item, over), sizeRefusal);
    assert.deepEqual(
      configurationDriver.storedConfigurations().map(({ values }) => values),
      [{}],
    );
  });

  test("Configuration save checks a large agents roster in step with its size", async () => {
    // Finding 1321: a valid Configuration of 60,000 agents.entries without their own settings
    // (710 KB, under the 1 MiB cap) held the controller's event loop for 7-8 s at save, so every
    // tenant's requests waited. The Kubernetes Configuration Driver's credential rules and the
    // Kubernetes Compute model rules built each setting's name for every entry, set or not, and
    // listed the roster once per setting. They now skip a setting an entry does not hold.
    const kubernetes = new KubernetesConfigurationDriver({ authentication: { mode: "inCluster" } });
    const compute = createTestKubernetesComputeDriver("compute-large-roster");
    // Each rule the save runs, with the arguments it ran with, so it can be timed again.
    const checks: (() => void | Promise<void>)[] = [];
    const recorded =
      <Args extends unknown[], Result extends void | Promise<void>>(
        rule: (...args: Args) => Result,
      ) =>
      (...args: Args): Result => {
        checks.push(() => rule(...args));
        return rule(...args);
      };
    const configurationDriver = {
      ...createConfigurationBackend(),
      validate: recorded(kubernetes.validate.bind(kubernetes)),
      validateSize: (values) => kubernetes.validateSize(values),
    } satisfies ConfigurationFixtureDriver;
    const { collection, ...context } = await fixture({
      configurationDriver,
      computeDriver: createReadyComputeDriver("compute-large-roster", {
        implementation: "integration-compute-substrate",
        validateHarnessAuth: compute.validateHarnessAuth.bind(compute),
        validateGatewaySettings: compute.validateGatewaySettings.bind(compute),
        validateConfiguration: recorded(compute.validateConfiguration.bind(compute)),
      }),
    });
    const codex = {
      model: "codex/gpt-5",
      models: { "codex/gpt-5": { agentRuntime: { id: "codex" } } },
    };
    const created = await request(context.app, "POST", collection, {
      body: { kind: "agent", values: { agents: { defaults: codex } } },
    });
    const item = `${collection}/${configurationData(created, 201).id}`;
    const values = {
      agents: {
        defaults: codex,
        ownership: "explicit",
        entries: Object.fromEntries<OpenClawConfigurationDocument>(
          Array.from({ length: 60_000 }, (_, index) => [`a${index}`, {}] as const),
        ),
      },
    };
    assert.ok(JSON.stringify(values).length > 700_000);
    checks.length = 0;
    const saved = await request(context.app, "PATCH", item, {
      body: { values },
    });
    const document = asRecord(configurationData(saved, 200).values);
    const agents = asRecord(document?.agents);
    const entries = asRecord(agents?.entries);
    assert.ok(entries, "saved Configuration must include the Agent roster");
    assert.equal(Object.keys(entries).length, 60_000);
    assert.equal(checks.length, 2);
    // The bound is relative to a structured clone of the same document, so a slow or busy runner
    // does not fail it. The two are timed in turn, each at its best of five. At two CPUs the
    // save's two rules take about 2.5 clones; they took about 13 before.
    const timings = { checking: Infinity, cloning: Infinity };
    for (let round = 0; round < 5; round += 1) {
      const checkingStarted = performance.now();
      const results = checks.map((check) => check());
      timings.checking = Math.min(timings.checking, performance.now() - checkingStarted);
      // Current validation does its work before returning. Also surface any rejected validation.
      await Promise.all(results);
      const cloningStarted = performance.now();
      structuredClone(values);
      timings.cloning = Math.min(timings.cloning, performance.now() - cloningStarted);
    }
    const { checking, cloning } = timings;
    assert.ok(
      checking < 6 * cloning,
      `the rules took ${checking.toFixed(0)} ms, a clone ${cloning.toFixed(0)} ms`,
    );
    // A setting an entry does hold is still checked, and named.
    values.agents.entries.a59999 = { sandbox: { ssh: { identityData: "synthetic-literal-key" } } };
    const refused = await request(context.app, "PATCH", item, {
      body: { values },
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body).slice(0, 500));
    assert.ok(Check(ErrorResponse, refused.body), "expected an error response");
    assert.equal(
      refused.body.error.message,
      literalKey("/agents/entries/a59999/sandbox/ssh/identityData"),
    );
  });
}
