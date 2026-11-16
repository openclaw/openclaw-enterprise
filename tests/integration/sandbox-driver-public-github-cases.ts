import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_GITHUB_READ_TRANSPORT_FILE,
  PUBLIC_GITHUB_READ_TRANSPORT_ENV,
  PUBLIC_GITHUB_READ_TRANSPORT_SOURCE,
} from "../../apps/controller/src/drivers/repo/github/public-read/runtime-source.ts";
import {
  PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT,
  PUBLIC_GITHUB_READ_PROTECTED_AGENT_ENTRYPOINT,
  PUBLIC_GITHUB_READ_WITH_NODE_ENTRYPOINT,
  PUBLIC_GITHUB_READ_PROTECTED_WITH_NODE_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellSandboxCreateRequest,
  OpenShellProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { ComputeServiceAccess, ProxyPlan } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { configureQaOrdinaryPublicGithubPolicy } from "../helpers/qa-public-github-git.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { installationDriverConfigurations } from "../../apps/controller/src/composition/installation-config.ts";
import { openShellEgressConfiguration } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";
import {
  namespaceContext,
  dedicatedRevision,
  codexRequirements,
  harnessRuntimeCommand,
  runtimeSandboxFixture,
  harnessService,
} from "./sandbox-driver-startup-orchestration.ts";
import {
  completeSandboxRevision,
  completeWorkspaceRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);

function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result, "expected an OpenShell record");
  return result;
}
function networkRules(spec: OpenShellSandboxCreateRequest["spec"]) {
  return record(record(spec.policy).network_policies);
}
function endpoints(rule: unknown): Record<string, unknown>[] {
  const value = record(rule).endpoints;
  assert.ok(Array.isArray(value));
  return value.map(record);
}

export function registerPublicGithubSandboxCases(): void {
  test("OpenShell startup can opt into bundled Presets through the real Namespace API", async (t) => {
    const configuration = { ...sandboxInstallation(), presets: { includeDefaults: true } };
    const runtime = await loadInstallationFile(t, configuration);
    assert.ok(runtime);
    const fixture = await createConsoleAppFixture(t, {
      defaultPresets: runtime.defaultPresets,
      sandboxDriver: runtime.sandboxDriver,
      backends: runtime.installation.backend,
      driverConfigurations: installationDriverConfigurations(runtime.installation),
    });
    const bootstrapped = await fixture.request("POST", "/installation/bootstrap", {
      body: { name: "OpenShell QA" },
    });
    assert.equal(bootstrapped.status, 201, JSON.stringify(bootstrapped.body));
    const namespace = await fixture.createNamespace("Public Git QA");
    const list = await fixture.request("GET", `/namespaces/${namespace.id}/presets`);
    assert.equal(list.status, 200);
    const codex = list.data.find(({ name }: { name: string }) => name === "Standard Codex");
    assert.equal(codex?.namespaceId, namespace.id);
    const selected = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/presets/${codex.id}`,
    );
    assert.equal(selected.status, 200);
    assert.equal(selected.data.template.agent.executionMode, "dedicated");
    assert.equal(selected.data.template.agent.harnessAuth.method, "api_key");
  });

  function ordinaryPublicGithubConfiguration(): OpenShellSandboxDriverOptions {
    const options = sandboxInstallation().drivers.sandbox.configuration;
    return {
      ...options,
      policy: {
        ...options.policy,
        networkPolicies: [
          {
            name: "source-control",
            endpoints: [{ host: "github.com", ports: [443], tls: "skip" }],
            binaries: [{ path: "/usr/bin/git" }],
          },
          ...options.policy.networkPolicies,
        ],
      },
    };
  }

  test("ordinary public Git QA closes only its launcher GitHub grant through normal Sandbox admission and creation", async (t) => {
    for (const { narrow, modelDefault } of [
      { narrow: false, modelDefault: true },
      { narrow: true, modelDefault: true },
      { narrow: true, modelDefault: false },
    ]) {
      const baseOptions = ordinaryPublicGithubConfiguration();
      const options = modelDefault
        ? baseOptions
        : {
            ...baseOptions,
            policy: {
              ...baseOptions.policy,
              networkPolicies: baseOptions.policy.networkPolicies.slice(0, -1),
            },
          };
      const before = structuredClone(options);
      if (narrow) {
        configureQaOrdinaryPublicGithubPolicy(options);
        const restored = structuredClone(options);
        const restoredRule = restored.policy.networkPolicies[0];
        const beforeRule = before.policy.networkPolicies[0];
        assert.ok(restoredRule && beforeRule);
        const restoredPolicy = {
          ...restored,
          policy: {
            ...restored.policy,
            networkPolicies: restored.policy.networkPolicies.map((rule, index) =>
              index === 0 ? { ...rule, endpoints: beforeRule.endpoints } : rule,
            ),
          },
        };
        assert.deepEqual(restoredPolicy, before, "all other installation attachments stay intact");
      }
      const base = sandboxInstallation();
      const installationInput = {
        ...base,
        drivers: { ...base.drivers, sandbox: { ...base.drivers.sandbox, configuration: options } },
      };
      const loaded = await loadInstallationFile(t, installationInput);
      assert.ok(loaded);
      assert.ok(loaded.sandboxDriver instanceof OpenShellSandboxDriver);
      const gateway = workspaceGatewayClient();
      const specCodec = controllerRequire("@grpc/proto-loader").loadSync(
        fileURLToPath(
          new URL(
            "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
            import.meta.url,
          ),
        ),
        { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
      )["openshell.v1.SandboxSpec"];
      let created: OpenShellSandboxCreateRequest | undefined;
      let stored: ReturnType<typeof storedSandbox> | undefined;
      gateway.createSandbox = async (request) => {
        created = request;
        stored = storedSandbox(request, {
          spec: specCodec.deserialize(specCodec.serialize(request.spec)),
        });
        return stored;
      };
      gateway.getSandbox = async () => stored;
      gateway.getService = async (_workspace, sandbox, service) =>
        harnessService(sandbox, service, stored?.serviceUrls[""]);
      const driver = openShellDriver(gateway, options);
      const context = namespaceContext();
      const revision = {
        ...completeSandboxRevision(dedicatedRevision(driver, context, "000000001717")),
        sandboxPolicy: driver.admitNetworkPolicy([], 1),
      };
      await driver.ensureNamespace(context);
      await driver.provisionHarness({
        ...context,
        revision,
        requirements: codexRequirements(revision),
      });
      assert.ok(created);
      assert.ok(revision.sandboxPolicy);
      const emitted = networkRules(created.spec);
      assert.deepEqual(
        record(emitted["source-control"]).endpoints,
        narrow ? [] : [{ host: "github.com", ports: [443], tls: "NETWORK_TLS_MODE_SKIP" }],
      );
      assert.deepEqual(emitted["model-egress"], revision.sandboxPolicy.defaults["model-egress"]);
      assert.deepEqual(record(emitted["source-control"]).binaries, [{ path: "/usr/bin/git" }]);
      assert.equal(emitted["public-github-read"], undefined, "no opt-in grants no reader route");
      assert.equal(gateway.profiles.has("oce-codex-runtime-public-github-read"), false);
      // Proto3 omits an empty repeated endpoint list. Reconciliation must adopt
      // that same closed rule, while a newly added destination remains a mismatch.
      await driver.provisionHarness({
        ...context,
        revision,
        requirements: codexRequirements(revision),
      });
      if (narrow) {
        assert.ok(stored);
        record(networkRules(stored.spec)["source-control"]).endpoints = [
          { host: "github.com", ports: [443], tls: "NETWORK_TLS_MODE_SKIP" },
        ];
        await assert.rejects(
          driver.provisionHarness({
            ...context,
            revision,
            requirements: codexRequirements(revision),
          }),
          /without exact AgentRevision ownership and content/,
        );
      }
    }
  });

  test("ordinary public Git QA refuses an unexpected launcher GitHub rule before mutating it", () => {
    type Rule = OpenShellSandboxDriverOptions["policy"]["networkPolicies"][number];
    const changes: ((rule: Rule) => Rule)[] = [
      (rule) => ({
        ...rule,
        endpoints: [...rule.endpoints, { host: "example.test", ports: [443] }],
      }),
      (rule) => ({ ...rule, binaries: [...rule.binaries, { path: "/usr/bin/curl" }] }),
      (rule) => ({
        ...rule,
        endpoints: rule.endpoints.map((endpoint) => ({ ...endpoint, tls: "terminate" })),
      }),
    ];
    for (const change of changes) {
      const base = ordinaryPublicGithubConfiguration();
      const options = {
        ...base,
        policy: {
          ...base.policy,
          networkPolicies: base.policy.networkPolicies.map((rule, index) =>
            index === 0 ? change(rule) : rule,
          ),
        },
      };
      const before = structuredClone(options);
      assert.throws(
        () => configureQaOrdinaryPublicGithubPolicy(options),
        /launcher source-control/,
      );
      assert.deepEqual(options, before);
    }
    const base = ordinaryPublicGithubConfiguration();
    const options = {
      ...base,
      policy: {
        ...base.policy,
        networkPolicies: base.policy.networkPolicies.map((rule, index) =>
          index === 1
            ? { ...rule, endpoints: [...rule.endpoints, { host: "*.com", ports: [443] }] }
            : rule,
        ),
      },
    };
    const before = structuredClone(options);
    assert.throws(
      () => configureQaOrdinaryPublicGithubPolicy(options),
      /independent direct GitHub/,
    );
    assert.deepEqual(options, before, "a second direct grant must refuse before mutation");
  });

  async function publicReaderMaterialDelivery(
    t: TestContext,
    protectedReader: boolean,
    workspaceNode: boolean,
  ) {
    const tls = await harnessTlsFixture(t);
    const gateway = workspaceGatewayClient();
    let created: ReturnType<typeof storedSandbox> | undefined;
    gateway.createSandbox = async (request) => {
      created = storedSandbox(request);
      return created;
    };
    gateway.getSandbox = async () => created;
    gateway.getService = async (_workspace, sandbox, service) =>
      harnessService(sandbox, service, "http://codex.example.test:8080/");
    let options: OpenShellSandboxDriverOptions = protectedReader
      ? sandboxInstallation().drivers.sandbox.configuration
      : ordinaryPublicGithubConfiguration();
    if (protectedReader) {
      options = {
        ...options,
        egress: { middlewareName: "service-exchange", authorityScope: "execution" },
      };
    } else {
      configureQaOrdinaryPublicGithubPolicy(options);
    }
    const driver = openShellDriver(gateway, options);
    const { context, revision: identity, requirements } = runtimeSandboxFixture(driver);
    let revision = completeWorkspaceRevision(identity, requirements);
    const descriptor: ComputeServiceAccess = {
      id: "public-github-read",
      driverId: "kubernetes",
      implementation: "kubernetes",
      endpoint: "https://10.96.0.55:8080",
      configuration: {
        policy: { mode: "all" },
        peer: { namespace: "reader", podLabels: { app: "reader" } },
        installationId: "ins_reader",
        authorizationConfigMapName: "reader-authorizations",
        caBundle: tls.caBundle,
      },
    };
    revision = {
      ...revision,
      compute: {
        id: "kubernetes",
        implementation: "kubernetes",
        serviceAccess: [descriptor],
      },
    };
    revision = {
      ...revision,
      sandboxPolicy: protectedReader
        ? driver.admitProtectedNetworkPolicy(1, [descriptor]).snapshot
        : driver.admitNetworkPolicy([], 1, undefined, { serviceAccess: [descriptor] }),
    };
    // Exercise the final prelude with multiple approved long workspace paths,
    // not only the short single-mount fixture used by unrelated tests.
    requirements.workspaceMounts.push(
      ...["knowledge", "artifacts", "repositories", "shared"].map((name) => ({
        claimName: "agent-workspace-31b4e0f2-6c88-4633-8cc4-b5cdd4995402",
        subPath: name + "-31b4e0f2-6c88-4633-8cc4-b5cdd4995402",
        mountPath: "/home/node/" + name + "-31b4e0f2-6c88-4633-8cc4-b5cdd4995402",
        readOnly: name === "knowledge",
      })),
    );
    const manifest = requirements.files[0];
    assert.ok(manifest);
    const runtime = record(JSON.parse(manifest.content));
    if (protectedReader) {
      revision = { ...revision, executionAdmission: { version: 3, mode: "protected" } };
      const plan: ProxyPlan = {
        id: "service-plan",
        generation: 1,
        execution: {
          installationId: "ins_reader",
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          executionId: revision.id,
          servicePrincipalId: "spr_reader",
        },
        sandboxDriverId: driver.id,
        egressDriverId: driver.id,
        routes: [],
      };
      revision = { ...revision, egressPlan: plan };
      assert.ok(options.egress);
      requirements.credentialAttachments = [];
      requirements.proxyWiring = {
        plan,
        configuration: openShellEgressConfiguration(plan, options.egress, revision),
      };
      const { harnessEgressEnrollment } =
        await import("../../apps/controller/src/drivers/compute/egress-enrollment.ts");
      runtime.egressEnrollment = harnessEgressEnrollment(plan);
      runtime.providerTools = "none";
    }
    runtime.publicGithubRead = {
      endpoint: descriptor.endpoint,
      materialPath: "/runtime/public-github-read.json",
    };
    requirements.files = requirements.files.map((file) =>
      file === manifest ? { ...file, content: JSON.stringify(runtime) } : file,
    );
    // The supported 256-repository scope exceeds one OpenShell config value,
    // while remaining below its rendered-file limit.
    const authenticatedRepositories = workspaceNode
      ? Array.from(
          { length: 256 },
          (_, index) => `example/${`repository-${index}`.padEnd(100, "x")}`,
        )
      : [];
    requirements.files = [
      ...requirements.files,
      {
        name: "public-github-read.json",
        environmentVariable: "OCE_PUBLIC_GITHUB_READ_MATERIAL_FILE",
        content: JSON.stringify({
          endpoint: descriptor.endpoint,
          caBundle: tls.caBundle,
          authenticatedRepositories,
        }),
      },
      {
        name: "public-github-read.md",
        environmentVariable: "OCE_PUBLIC_GITHUB_READ_SKILL_FILE",
        content: "Use the authenticated public-reader for public GitHub reads.",
      },
    ];
    requirements.files = [
      ...requirements.files,
      {
        name: PUBLIC_GITHUB_READ_TRANSPORT_FILE,
        environmentVariable: PUBLIC_GITHUB_READ_TRANSPORT_ENV,
        content: PUBLIC_GITHUB_READ_TRANSPORT_SOURCE,
      },
    ];
    requirements.serviceAccessMaterials = [
      { serviceId: "public-github-read", values: { capability: "synthetic-reader-capability" } },
    ];
    let entrypoint = protectedReader
      ? PUBLIC_GITHUB_READ_PROTECTED_AGENT_ENTRYPOINT
      : PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT;
    if (workspaceNode) {
      entrypoint = protectedReader
        ? PUBLIC_GITHUB_READ_PROTECTED_WITH_NODE_ENTRYPOINT
        : PUBLIC_GITHUB_READ_WITH_NODE_ENTRYPOINT;
    }
    requirements.command = harnessRuntimeCommand(entrypoint);
    const provision = () => driver.provisionHarness({ ...context, revision, requirements });
    await driver.ensureNamespace(context);
    await provision();
    assert.ok(created);
    const command = created.spec.command;
    assert.ok(Array.isArray(command));
    assert.ok(command.every((argument): argument is string => typeof argument === "string"));
    const commandBytes = Buffer.byteLength(JSON.stringify(created.spec.command));
    assert.ok(commandBytes <= 65_536, `final public OpenShell command is ${commandBytes} bytes`);
    assert.ok(command.every((argument) => Buffer.byteLength(argument) < 131072));
    t.diagnostic(
      `Public ${protectedReader ? "protected" : "ordinary"} ${workspaceNode ? "workspace" : "standalone"} command: ${commandBytes} bytes`,
    );
    const providerCall = gateway.calls.find((call) => call[0] === "createProvider");
    assert.ok(providerCall && providerCall[0] === "createProvider");
    const providerCreate = providerCall[1];
    const providerConfig = providerCreate.config;
    assert.ok(providerConfig);
    // OpenShell v0.1.6 validates CreateProvider config separately from profile files:
    // each config value is limited to 8 KiB; a rendered provider file allows 64 KiB.
    assert.ok(Object.keys(providerConfig).length <= 64);
    for (const [key, value] of Object.entries(providerConfig)) {
      assert.ok(
        Buffer.byteLength(value, "utf8") <= 8_192,
        `OpenShell provider config ${key} exceeds 8 KiB`,
      );
    }
    assert.deepEqual(providerCreate.credentials, {
      OCE_PUBLIC_GITHUB_READ_CAPABILITY: "synthetic-reader-capability",
    });
    assert.doesNotMatch(JSON.stringify(providerConfig), /synthetic-reader-capability/);
    assert.doesNotMatch(JSON.stringify(created.spec), /synthetic-reader-capability/);
    const profile = gateway.profiles.get("oce-codex-runtime-public-github-read")?.profile;
    assert.ok(profile);
    assert.ok(profile.files);
    assert.deepEqual(
      profile.endpoints,
      [],
      "only the admitted policy endpoint binds the credential",
    );
    assert.deepEqual(profile.credentials, [
      {
        name: "public_github_read_capability",
        envVars: ["OCE_PUBLIC_GITHUB_READ_CAPABILITY"],
        required: true,
        authStyle: "bearer",
        headerName: "authorization",
        stablePlaceholder: true,
      },
    ]);
    assert.equal(profile.files.length, 7);
    const transportFile = profile.files.find(
      ({ path }) => path === PUBLIC_GITHUB_READ_TRANSPORT_FILE,
    );
    assert.ok(transportFile);
    assert.ok(Buffer.byteLength(transportFile.content, "utf8") <= 65_536);
    assert.doesNotMatch(
      transportFile.content.replace(/\{\{config\.[a-z_]+\}\}/g, ""),
      /\{\{|\}\}/,
      "OpenShell rejects unmatched file-template delimiters",
    );
    const deliveredTransport = transportFile.content.replace(
      /\{\{config\.([a-z_]+)\}\}/g,
      (_, key) => {
        const value = providerConfig[key];
        assert.ok(typeof value === "string");
        return value;
      },
    );
    assert.equal(deliveredTransport, PUBLIC_GITHUB_READ_TRANSPORT_SOURCE);
    const expectedFile = requirements.files.find(({ name }) => name === "public-github-read.json");
    assert.ok(expectedFile);
    const expectedMaterial = expectedFile.content;
    if (workspaceNode) {
      assert.ok(Buffer.byteLength(expectedMaterial, "utf8") > 8_192);
    }
    const materialFile = profile.files.find(({ path }) => path === "public-github-read.json");
    assert.ok(materialFile);
    const deliveredMaterial = materialFile.content.replace(
      /\{\{config\.([a-z_]+)\}\}/g,
      (_, key) => {
        const value = providerConfig[key];
        assert.ok(typeof value === "string");
        return value;
      },
    );
    assert.equal(
      deliveredMaterial,
      expectedMaterial,
      "provider templates preserve every runtime material byte",
    );

    if (protectedReader) {
      assert.deepEqual(Object.keys(networkRules(created.spec)).sort(), [
        "public-github-read",
        "workspace-node-enrollment",
      ]);
      assert.deepEqual(created.spec.providers, [providerCreate.name]);
      assert.equal(revision.repositoryCredentials, undefined);
    }
    const serviceRule = networkRules(created.spec)["public-github-read"];
    if (!protectedReader) {
      assert.ok(revision.sandboxPolicy);
      assert.deepEqual(record(networkRules(created.spec)["source-control"]).endpoints, []);
      assert.deepEqual(
        networkRules(created.spec)["model-egress"],
        revision.sandboxPolicy.defaults["model-egress"],
      );
      assert.deepEqual(revision.sandboxPolicy.serviceAccess, revision.compute.serviceAccess);
    }
    assert.deepEqual(endpoints(serviceRule)[0]?.credential_binding, {
      provider: providerCreate.name,
    });
    for (const [name, rule] of Object.entries(networkRules(created.spec))) {
      if (name !== "public-github-read") {
        assert.ok(endpoints(rule).every((endpoint) => endpoint.credential_binding === undefined));
      }
    }
    await provision();
    assert.equal(
      gateway.calls.filter(([operation]) => operation === "updateProviderCredentials").length,
      0,
      "stable preparation must not rotate its provider on every reconcile",
    );
    const serviceMaterial = requirements.serviceAccessMaterials[0];
    assert.ok(serviceMaterial);
    requirements.serviceAccessMaterials = [
      {
        ...serviceMaterial,
        values: { ...serviceMaterial.values, capability: "renewed-reader-capability" },
      },
    ];
    await provision();
    const renewal = gateway.calls.filter((call) => call[0] === "updateProviderCredentials").at(-1);
    assert.ok(renewal && renewal[0] === "updateProviderCredentials");
    assert.deepEqual(renewal.slice(2), [
      { OCE_PUBLIC_GITHUB_READ_CAPABILITY: "renewed-reader-capability" },
    ]);
    const sourceFile = requirements.files.find(
      ({ name }) => name === PUBLIC_GITHUB_READ_TRANSPORT_FILE,
    );
    const files = requirements.files;
    for (const source of [
      undefined,
      PUBLIC_GITHUB_READ_TRANSPORT_SOURCE + "\n",
      "throw new Error('untrusted source executed');",
    ]) {
      requirements.files =
        source === undefined
          ? files.filter((file) => file !== sourceFile)
          : files.map((file) => (file === sourceFile ? { ...file, content: source } : file));
      const before = gateway.calls.length;
      await assert.rejects(provision, /runtime files/);
      assert.equal(
        gateway.calls.length,
        before,
        "invalid source must fail before provider mutation",
      );
    }
    requirements.files = files;
    const writes = gateway.calls.length;
    const renewed = requirements.serviceAccessMaterials;
    assert.ok(renewed);
    requirements.serviceAccessMaterials = [
      {
        ...serviceMaterial,
        values: { capability: "renewed-reader-capability", extra: "must-refuse" },
      },
    ];
    await assert.rejects(provision, /public-reader service material/);
    assert.equal(gateway.calls.length, writes);
    requirements.serviceAccessMaterials = renewed;
    const material = requirements.files[2];
    assert.ok(material);
    requirements.files = requirements.files.map((file) =>
      file !== material
        ? file
        : {
            ...file,
            content: JSON.stringify({
              endpoint: "https://10.96.0.56:8080",
              caBundle: tls.caBundle,
              authenticatedRepositories: [],
            }),
          },
    );
    await assert.rejects(provision, /public-reader runtime files/);
    return profile;
  }

  for (const protectedReader of [false, true]) {
    test(`OpenShell public-reader material stays in endpoint-bound provider credentials across renewal and rejects ambient delivery (${protectedReader ? "protected service only" : "ordinary"})`, async (t) => {
      let sharedProfile: OpenShellProviderProfile | undefined;
      for (const workspaceNode of [false, true]) {
        await t.test(workspaceNode ? "workspace" : "standalone", async (t) => {
          const profile = await publicReaderMaterialDelivery(t, protectedReader, workspaceNode);
          if (sharedProfile) {
            assert.deepEqual(
              profile,
              sharedProfile,
              "Agent material size must not change the shared profile",
            );
          }
          sharedProfile = profile;
        });
      }
    });
  }
}
