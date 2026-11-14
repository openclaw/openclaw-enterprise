import assert from "node:assert/strict";
import test from "node:test";
import { administrator, fixture, installation } from "./configuration-occ-fixture.ts";
import type {
  Configuration,
  HarnessExecutionMode,
  OpenClawConfigurationDocument,
  SandboxDriver,
  SandboxFacet,
} from "@openclaw-enterprise/contracts";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  ConfigurationHarnessError,
  DedicatedOpenClawSandboxError,
  DependencyUnavailableError,
  OpenClawController,
  PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS,
  ResourceStateConflictError,
  ScopeViolationError,
  type HarnessResolver,
} from "../../packages/occ/src/index.ts";
import { registerAndSelectDrivers } from "../helpers/development.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import {
  codexRuntimeOffProvider,
  BOTH_RUNTIMES,
  CODEX_MODEL_ONLY,
  CODEX_NEEDS_DEDICATED,
  dedicatedOpenClawSandboxRefusal,
  keepRuntime,
  noRunnableRuntime,
  OPENCLAW_ONLY,
  runtimeIdRequired,
  runtimeIdRequiredNextStep,
  runtimePoliciesConflict,
  selectablePrimaryRuntimeNextStep,
  selectablePrimaryRuntimeRequired,
} from "../helpers/refusal-text.mjs";

// A missing provisioning Sandbox Driver is a permanent conflict (409). An outage is temporary
// (503). The refusal names the Driver and offers a next step the Agent can use.
export function dedicatedSandboxRefusal(error: unknown, codexRuns = false) {
  return (
    error instanceof DedicatedOpenClawSandboxError &&
    error instanceof ResourceStateConflictError &&
    !(error instanceof DependencyUnavailableError) &&
    error.message === dedicatedOpenClawSandboxRefusal(codexRuns)
  );
}

const facets: readonly SandboxFacet[] = ["networking", "filesystem", "process"];

function conformanceSandbox(id: string, facets: readonly SandboxFacet[], provisions = true) {
  return {
    id: `configuration-occ-sandbox-${id}`,
    capability: "sandbox",
    implementation: "configuration-conformance-sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets,
    ...(provisions
      ? {
          async provisionHarness() {
            assert.fail("admission checks never provision");
          },
        }
      : {}),
    async cleanup() {},
  } satisfies SandboxDriver;
}

// Admission refusals for an OpenClaw execution mode the Installation shape cannot run: Agent save
// (embedded with a Sandbox Driver) or deploy (dedicated).
function openclawModeRefusal(error: unknown): error is Error {
  return (
    error instanceof ConfigurationHarnessError || error instanceof DedicatedOpenClawSandboxError
  );
}

type RuntimeId = "openclaw" | "codex";

function modelValues(
  model: string,
  runtime?: RuntimeId,
  plugins?: OpenClawConfigurationDocument,
): OpenClawConfigurationDocument {
  return {
    agents: {
      defaults: {
        model,
        ...(runtime === undefined
          ? {}
          : { models: { [model]: { agentRuntime: { id: runtime } } } }),
      },
    },
    ...(plugins === undefined ? {} : { plugins }),
  };
}

export function registerSandboxCapabilityCases(): void {
  test("The pinned runtime admits dedicated OpenClaw without waiving Sandbox containment", async () => {
    const { agent, controller, namespace, saveConfiguration } = await fixture();
    assert.equal(PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS, true);
    // nativeWorkers promises that dedicated OpenClaw can be admitted, so runtime support alone
    // does not report it (finding 1608).
    assert.deepEqual((await controller.getInstallation(administrator)).capabilities, {
      openclaw: { executionModes: ["embedded"] },
    });
    const openclawConfiguration = await saveConfiguration({});
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: openclawConfiguration.id,
      executionMode: "dedicated",
    });
    // Native runtime support does not grant containment: dedicated OpenClaw still fails closed
    // without a provisioning SandboxDriver that declares networking, filesystem, and process containment.
    const deploy = () =>
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedProductionHarness,
      );
    await assert.rejects(deploy(), dedicatedSandboxRefusal);
    // A Sandbox Driver that cannot provision, or lacks any one facet, changes neither answer.
    for (const sandbox of [
      conformanceSandbox("contain-only", facets, false),
      ...facets.map((missing) =>
        conformanceSandbox(
          `no-${missing}`,
          facets.filter((facet) => facet !== missing),
        ),
      ),
    ]) {
      registerAndSelectDrivers(controller, [sandbox]);
      assert.deepEqual(
        (await controller.getInstallation(administrator)).capabilities,
        { openclaw: { executionModes: [] } },
        sandbox.id,
      );
      await assert.rejects(deploy(), dedicatedSandboxRefusal, sandbox.id);
    }
    assert.deepEqual(
      (await controller.listRevisions(administrator, namespace.id, agent.id)).revisions,
      [],
    );
    // A qualifying Sandbox Driver is what makes the Installation report native worker support.
    registerAndSelectDrivers(controller, [conformanceSandbox("full", facets)]);
    assert.deepEqual((await controller.getInstallation(administrator)).capabilities, {
      nativeWorkers: { support: "pinned-runtime" },
      openclaw: { executionModes: ["dedicated"] },
    });
    assert.throws(
      // Exercise the runtime guard for untyped callers supplying a derived support value.
      // @ts-expect-error Controller options only accept the custom-image override.
      () => new OpenClawController(installation, { nativeWorkerSupport: "pinned-runtime" }),
      ScopeViolationError,
    );
  });

  // D832: on an Installation that cannot run dedicated OpenClaw, a dedicated Agent's deploy offered
  // openclaw, which then failed with a 409 that named no next step (finding 3036).
  test("a dedicated Agent's runtime refusals offer only what the Installation runs, and the Dedicated OpenClaw refusal names the next step", async () => {
    const { bindHarnessAuth, controller, namespace, replaceStoredValues, saveConfiguration } =
      await fixture();
    const model = "codex/gpt-5.1";
    const policy = `agents.defaults.models["${model}"]`;
    const configurations = {
      none: await saveConfiguration(modelValues(model)),
      codex: await saveConfiguration(modelValues(model, "codex")),
      openclaw: await saveConfiguration(modelValues(model, "openclaw")),
    };
    const agentFor = async (executionMode: HarnessExecutionMode) => {
      const created = await controller.createAgent(administrator, {
        namespaceId: namespace.id,
        name: `Codex model ${executionMode}`,
        // Configuration save and Agent save accept a model without its runtime: deploy refuses it.
        configurationId: configurations.none.id,
        executionMode,
      });
      await bindHarnessAuth(created);
      return created;
    };
    const dedicated = await agentFor("dedicated");
    const embedded = await agentFor("embedded");
    const deploy = (agentId: string) =>
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId },
        resolveApprovedProductionHarness,
      );
    const use = (agentId: string, runtime: keyof typeof configurations) =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId,
        configurationId: configurations[runtime].id,
      });
    const runtimeRequired = (offer: "codex" | "openclaw or codex") => (error: unknown) =>
      error instanceof ConfigurationHarnessError &&
      error.message === runtimeIdRequired(policy, offer);

    // Without a provisioning Sandbox Driver the dedicated Agent cannot run OpenClaw, so the missing
    // runtime offers codex alone. The embedded Agent of the same Configuration runs neither runtime
    // for this codex/<model> model, so it gets the next step instead (finding 3037).
    await assert.rejects(deploy(dedicated.id), runtimeRequired("codex"));
    await assert.rejects(
      deploy(embedded.id),
      (error) =>
        error instanceof ConfigurationHarnessError &&
        error.message === runtimeIdRequiredNextStep(policy),
    );
    // The offered value deploys.
    await use(dedicated.id, "codex");
    assert.deepEqual((await deploy(dedicated.id)).harness, {
      id: "codex",
      version: "1.0.0",
      mode: "dedicated",
      overrides: {},
      configuration: {},
    });
    // openclaw, which the refusal no longer offers, gets the 409; Codex runs this model, so the
    // refusal names codex as the next step.
    await use(dedicated.id, "openclaw");
    await assert.rejects(deploy(dedicated.id), (error) => dedicatedSandboxRefusal(error, true));
    // Codex on an openai model without the Codex plugin's WebSocket app server. Configuration save
    // refuses it, so deploy meets it only on a Configuration stored before that rule: write the row
    // to the Configuration Driver's storage. The refusal offers no openclaw, which this Agent
    // cannot run (finding 3036).
    const openaiPolicy = 'agents.defaults.models["openai/gpt-5.1"]';
    await replaceStoredValues(configurations.openclaw, modelValues("openai/gpt-5.1", "codex"));
    const offProvider = (remedy?: string) => (error: unknown) =>
      error instanceof ConfigurationHarnessError &&
      error.message === codexRuntimeOffProvider(openaiPolicy, remedy);
    await assert.rejects(deploy(dedicated.id), offProvider(CODEX_MODEL_ONLY));

    // A qualifying Sandbox Driver runs dedicated OpenClaw: both offers stay.
    registerAndSelectDrivers(controller, [
      conformanceSandbox("full", ["networking", "filesystem", "process"]),
    ]);
    await assert.rejects(deploy(dedicated.id), offProvider());
    await use(dedicated.id, "none");
    await assert.rejects(deploy(dedicated.id), runtimeRequired("openclaw or codex"));
  });

  // D833: where the Installation approves Codex only for dedicated execution, an embedded Agent's
  // deploy offered codex, which then failed as needing dedicated execution. On a codex/<model>
  // model the openclaw offer failed too, so neither offer deployed (finding 3037).
  test("an embedded Agent's runtime refusals offer only what it runs, and name the next step where it runs neither", async () => {
    const { bindHarnessAuth, controller, namespace, replaceStoredValues, saveConfiguration } =
      await fixture();
    const websocketCodex = {
      entries: { codex: { enabled: true, config: { appServer: { transport: "websocket" } } } },
    };
    // Codex runs both models: openai only through the Codex plugin's WebSocket app server.
    const prepareModel = async (model: string, plugins?: OpenClawConfigurationDocument) => {
      const values = (runtime?: RuntimeId) => modelValues(model, runtime, plugins);
      return {
        model,
        policy: `agents.defaults.models["${model}"]`,
        values,
        configurations: {
          none: await saveConfiguration(values()),
          openclaw: await saveConfiguration(values("openclaw")),
          codex: await saveConfiguration(values("codex")),
        },
      };
    };
    const cases = {
      openai: await prepareModel("openai/gpt-5.1", websocketCodex),
      codex: await prepareModel("codex/gpt-5.1"),
    };
    const agent = await bindHarnessAuth(
      await controller.createAgent(administrator, {
        namespaceId: namespace.id,
        name: "Embedded Codex model",
        configurationId: cases.openai.configurations.none.id,
        executionMode: "embedded",
      }),
    );
    const deploy = (resolveHarness: HarnessResolver = resolveApprovedProductionHarness) =>
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveHarness,
      );
    // Agent save without the deploy route's resolver keeps a pair deploy refuses, as one stored
    // before that rule.
    const use = (configuration: Readonly<Configuration>) =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: configuration.id,
      });
    const refusedWith = (message: string) => (error: unknown) =>
      error instanceof ConfigurationHarnessError && error.message === message;

    // Embedded OpenClaw runs an openai model, so the missing runtime offers openclaw alone, and that
    // offer deploys. codex, no longer offered, needs dedicated execution.
    await use(cases.openai.configurations.none);
    await assert.rejects(deploy(), refusedWith(runtimeIdRequired(cases.openai.policy, "openclaw")));
    await use(cases.openai.configurations.codex);
    await assert.rejects(deploy(), refusedWith(CODEX_NEEDS_DEDICATED));
    await use(cases.openai.configurations.openclaw);
    assert.deepEqual((await deploy()).harness, {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    });

    // On a codex/<model> model neither runtime deploys an embedded Agent, so the refusal names the
    // next step instead of an offer. Resolvers that approve Codex for embedded execution, or for
    // no execution mode, refuse codex differently, so both offers stay.
    await use(cases.codex.configurations.none);
    await assert.rejects(deploy(), refusedWith(runtimeIdRequiredNextStep(cases.codex.policy)));
    for (const resolveHarness of [
      (harnessId) => ({ id: harnessId, version: "1.0.0" }),
      (harnessId) => (harnessId === "openclaw" ? { id: harnessId, version: "1.0.0" } : undefined),
    ] satisfies HarnessResolver[]) {
      await assert.rejects(
        deploy(resolveHarness),
        refusedWith(runtimeIdRequired(cases.codex.policy, "openclaw or codex")),
      );
    }
    await use(cases.codex.configurations.codex);
    await assert.rejects(deploy(), refusedWith(CODEX_NEEDS_DEDICATED));

    // Configuration save refuses the next two rules, so deploy meets them only on a Configuration
    // stored before them. Write such rows directly to the Configuration Driver's storage.
    const storeValues = async (
      configuration: Readonly<Configuration>,
      values: OpenClawConfigurationDocument,
    ) => {
      await replaceStoredValues(configuration, values);
      await use(configuration);
    };
    for (const name of ["openai", "codex"] as const) {
      const { model, policy, configurations, values } = cases[name];
      // The primary model's runtime is missing while another model is listed beside it.
      const missingRuntime = values();
      const listed = {
        ...missingRuntime,
        agents: { defaults: { model, models: { [model]: {}, [`${model}-mini`]: {} } } },
      };
      await storeValues(configurations.none, listed);
      await assert.rejects(
        deploy(),
        refusedWith(
          name === "codex"
            ? selectablePrimaryRuntimeNextStep(cases.codex.policy)
            : selectablePrimaryRuntimeRequired(cases.openai.policy, "openclaw"),
        ),
      );
      // Two policies select different runtimes for the model.
      const conflicting = {
        ...values("openclaw"),
        models: { providers: { [name]: { agentRuntime: { id: "codex" } } } },
      };
      await storeValues(configurations.none, conflicting);
      const provider = `models.providers.${name}`;
      await assert.rejects(
        deploy(),
        refusedWith(
          runtimePoliciesConflict(
            policy,
            "openclaw",
            provider,
            "codex",
            name === "codex" ? noRunnableRuntime("both") : keepRuntime("openclaw", "codex"),
          ),
        ),
      );
      // Configuration save, which serves any Agent, keeps both offers for the same document.
      await assert.rejects(
        saveConfiguration(conflicting),
        refusedWith(runtimePoliciesConflict(policy, "openclaw", provider, "codex", BOTH_RUNTIMES)),
      );
    }
    // Codex on the openai model without the Codex plugin's WebSocket app server: a codex/<model>
    // model, which this embedded Agent cannot run either, is not offered. Configuration save keeps
    // both steps.
    const offProvider = modelValues(cases.openai.model, "codex");
    await storeValues(cases.openai.configurations.none, offProvider);
    await assert.rejects(
      deploy(),
      refusedWith(codexRuntimeOffProvider(cases.openai.policy, OPENCLAW_ONLY)),
    );
    await assert.rejects(
      saveConfiguration(offProvider),
      refusedWith(codexRuntimeOffProvider(cases.openai.policy)),
    );
  });

  test("The Installation lists exactly the OpenClaw execution modes Agent save and deploy admit", async () => {
    const shapes: {
      name: string;
      modes: readonly HarnessExecutionMode[];
      sandbox?: SandboxDriver & { implementation: string };
      unavailable?: boolean;
      settingRefusals?: Partial<Record<HarnessExecutionMode, string>>;
    }[] = [
      { name: "no Sandbox Driver", modes: ["embedded"] },
      {
        name: "contain-only",
        sandbox: conformanceSandbox("contain-only", facets, false),
        modes: [],
      },
      ...facets.map((missing) => ({
        name: `no-${missing}`,
        sandbox: conformanceSandbox(
          `no-${missing}`,
          facets.filter((facet) => facet !== missing),
        ),
        modes: [],
      })),
      { name: "full", sandbox: conformanceSandbox("full", facets), modes: ["dedicated"] },
      // Installation settings are declared separately from real Configuration transformation.
      ...[undefined, "Ask an operator to enable OpenClaw in the Sandbox settings."].map(
        (reason) => ({
          name: reason === undefined ? "unsupported OpenClaw" : "settings refuse OpenClaw",
          sandbox: {
            ...conformanceSandbox("refuses-openclaw", facets),
            supportsHarnessExecutionMode: Object.freeze({
              openclaw: Object.freeze({
                embedded: Object.freeze({ supported: false }),
                dedicated: Object.freeze({
                  supported: false,
                  ...(reason === undefined ? {} : { reason }),
                }),
              }),
            }),
            configureAgent() {
              assert.fail("static refusal must precede Configuration transformation");
            },
          },
          modes: [],
          ...(reason === undefined ? {} : { settingRefusals: { dedicated: reason } }),
        }),
      ),
      {
        name: "full but unavailable",
        sandbox: conformanceSandbox("unavailable", facets),
        unavailable: true,
        modes: [],
      },
    ];
    for (const shape of shapes) {
      const { agent, controller, namespace, saveConfiguration } = await fixture();
      const openclawConfiguration = await saveConfiguration({});
      if (shape.sandbox !== undefined) {
        registerAndSelectDrivers(controller, [shape.sandbox]);
      }
      if (shape.unavailable) {
        // The registry no longer matches the selection, as after a Driver swap at runtime.
        assert.ok(shape.sandbox);
        shape.sandbox.implementation = "replaced-sandbox";
      }
      const { capabilities } = await controller.getInstallation(administrator);
      assert.ok(capabilities, shape.name);
      // Only an outage says so: an empty list from the Installation's shape needs an
      // administrator, an outage only time (finding 1624).
      assert.deepEqual(
        capabilities.openclaw,
        {
          executionModes: shape.modes,
          ...(shape.settingRefusals ? { settingRefusals: shape.settingRefusals } : {}),
          ...(shape.unavailable ? { sandboxDriverUnavailable: true } : {}),
        },
        shape.name,
      );
      // nativeWorkers promises dedicated admission, so it appears exactly with that mode.
      assert.equal(
        capabilities.nativeWorkers === undefined,
        !shape.modes.includes("dedicated"),
        shape.name,
      );
      for (const executionMode of ["embedded", "dedicated"] as const) {
        const label = `${shape.name}: ${executionMode}`;
        const saveAndDeploy = async () => {
          await controller.updateAgent(administrator, {
            namespaceId: namespace.id,
            agentId: agent.id,
            configurationId: openclawConfiguration.id,
            executionMode,
          });
          return controller.deployAgent(
            administrator,
            { namespaceId: namespace.id, agentId: agent.id },
            resolveApprovedProductionHarness,
          );
        };
        if (shape.modes.includes(executionMode)) {
          const revision = await saveAndDeploy();
          assert.equal(revision.harness.mode, executionMode, label);
          continue;
        }
        await assert.rejects(
          saveAndDeploy(),
          (error: unknown) => {
            if (shape.unavailable) {
              return (
                error instanceof DependencyUnavailableError &&
                error.message === "The selected Sandbox Driver is unavailable."
              );
            }
            if (!openclawModeRefusal(error)) {
              return false;
            }
            // A setting refusal is the message admission itself returns.
            const settingRefusal = shape.settingRefusals?.[executionMode];
            return settingRefusal === undefined || error.message === settingRefusal;
          },
          label,
        );
      }
    }
  });
}
