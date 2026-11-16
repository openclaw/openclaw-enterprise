import assert from "node:assert/strict";
import test from "node:test";

import {
  SshComputeDriver,
  type SshComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import {
  AgentResponse,
  AgentRevisionListResponse,
  AgentRevisionReadResponse,
  AgentRevisionResponse,
  ConfigurationResponse,
  ErrorResponse,
  SecretResponse,
  type AgentWire,
  type ComputeDriver,
  type ErrorCode,
  type OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import {
  ConfigurationHarnessError,
  DependencyUnavailableError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { plaintextGatewayComputeDrivers } from "../helpers/plaintext-gateway-compute.ts";
import {
  KUBERNETES_ALLOW_USERS_REFUSAL,
  sshGatewayPasswordRefusal,
  unreadableSecretRefProblem as formatSecretRefProblem,
} from "../helpers/refusal-text.mjs";
import { INVALID_ALLOW_USERS_SAMPLE } from "../helpers/trusted-proxy-shapes.mjs";
import {
  bindHarnessKey,
  bootstrapInstallation,
  checkedInjectedBody,
  createAgent,
  createConfiguration,
  createInjectedControllerFixture,
  createNamespace,
  createProvisioningCapableComputeDriver,
  injectedRequest,
  readyNamespaceFixture,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type InjectedReply = Awaited<ReturnType<FixtureRequest>>;
type FixtureOptions = Parameters<typeof createInjectedControllerFixture>[0];

function checkApiError(reply: InjectedReply, status: number, code: ErrorCode) {
  const { error } = checkedInjectedBody(reply, status, ErrorResponse);
  assert.equal(error.code, code, JSON.stringify(reply.body));
  return error;
}

function unreadableSecretRefProblem(kind: "defaultAlias" | "allowlist", input: string): string {
  const text: unknown = formatSecretRefProblem(kind, input);
  assert(typeof text === "string", "the refusal fixture must return text");
  return text;
}

async function createAdmissionController(options: FixtureOptions) {
  const fixture = await createInjectedControllerFixture(options, {
    wrapPlatformState: (state) => state,
    invokeApplication(factory, { backendSummaries, ...options }) {
      assert.equal(backendSummaries, undefined);
      return factory(options);
    },
  });
  const request: FixtureRequest = (method, pathname, requestOptions) =>
    injectedRequest(fixture.app, method, pathname, requestOptions);
  return { fixture, request };
}

async function readRevisions(controller: { request: FixtureRequest }, agentPath: string) {
  const result = await controller.request("GET", `${agentPath}/revisions`);
  return checkedInjectedBody(result, 200, AgentRevisionListResponse).data;
}

async function plaintextGatewayAdmissionFixture(
  nativeCompute: Required<Pick<ComputeDriver, "validateGatewaySettings">>,
  bootstrapLabel: string,
  namespaceSlug: string,
) {
  // The API/state fixture owns lifecycle and credentials; the actual selected
  // Driver owns admission. No worker or remote backend is dispatched here.
  const computeDriver = createProvisioningCapableComputeDriver();
  computeDriver.validateGatewaySettings = (configuration) =>
    nativeCompute.validateGatewaySettings(configuration);
  const configurationDriver = createTestConfigurationDriver({ id: "configuration-integration" });
  const controller = await createAdmissionController({ computeDriver, configurationDriver });
  return {
    ...(await readyNamespaceFixture(controller, namespaceSlug, bootstrapLabel)),
    configurationDriver,
  };
}

export function registerGatewayAdmissionCases(): void {
  test("deployment refuses a Codex approval policy the Gateway refuses across Compute Drivers", async (t) => {
    for (const [kind, nativeCompute] of plaintextGatewayComputeDrivers()) {
      await t.test(kind, async () => {
        const { fixture, controller, namespace, configurationDriver } =
          await plaintextGatewayAdmissionFixture(
            nativeCompute,
            `Codex approval ${kind}`,
            `codex-approval-${kind}`,
          );
        const setting = "plugins.entries.codex.config.appServer.approvalPolicy";
        // The pinned Gateway refuses untrusted at configuration load, with a doctor hint that
        // cannot edit Compute's read-only configuration (finding 987), and any value outside its
        // enum; preparation refused those only after a dedicated deployment stopped the running
        // revision (finding 1113). Configuration save refuses them now, so each is a row an older
        // release saved, written past OCC.
        for (const [name, approvalPolicy, message] of [
          [
            "untrusted",
            "untrusted",
            `Configuration setting ${setting} must not be "untrusted", which the OpenClaw runtime retired: use "on-request".`,
          ],
          [
            "always",
            "always",
            `Configuration setting ${setting} must be "never", "on-request" or "on-failure".`,
          ],
          ["on-failure", "on-failure"],
          ["omitted", undefined],
        ] as const) {
          const agent = await createAgent(controller, namespace.id, `codex-approval-${name}`);
          const reference = {
            namespaceId: namespace.id,
            id: agent.configurationId,
          };
          const stored = configurationDriver.stored(reference);
          assert(stored, "Agent must have a saved Configuration");
          const values = {
            ...stored.values,
            plugins: {
              entries: {
                codex: {
                  config: { appServer: approvalPolicy === undefined ? {} : { approvalPolicy } },
                },
              },
            },
          };
          await configurationDriver.update({ ...stored, values });
          assert.deepEqual((await configurationDriver.read(reference)).values, values);
          await bindHarnessKey(fixture, namespace.id, agent);
          const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
          const result = await controller.request("POST", `${path}/deploy`);
          if (message === undefined) {
            checkedInjectedBody(result, 202, AgentRevisionResponse);
          } else {
            const error = checkApiError(result, 409, "RESOURCE_CONFLICT");
            assert.equal(error.message, message);
            // No revision is admitted, so the worker never stops the running one.
            assert.deepEqual(await readRevisions(controller, path), []);
          }
        }
      });
    }
  });

  test("deployment refuses native listener TLS before admitting a revision across Compute Drivers", async (t) => {
    for (const [kind, nativeCompute] of plaintextGatewayComputeDrivers()) {
      await t.test(kind, async () => {
        const { fixture, controller, namespace } = await plaintextGatewayAdmissionFixture(
          nativeCompute,
          `Native HTTP ${kind}`,
          `native-http-${kind}`,
        );
        for (const [name, tls, expectedStatus] of [
          ["enabled", { enabled: true, certPath: "/owned/cert.pem" }, 409],
          ["disabled", { enabled: false }, 202],
          ["omitted", undefined, 202],
        ] as const) {
          const agent = await createAgent(controller, namespace.id, `native-http-${name}`, {
            gateway: tls === undefined ? {} : { tls },
          });
          await bindHarnessKey(fixture, namespace.id, agent);
          const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
          const result = await controller.request("POST", `${path}/deploy`);
          if (expectedStatus === 409) {
            const error = checkApiError(result, 409, "RESOURCE_CONFLICT");
            assert.match(error.message, /gateway\.tls\.enabled must be omitted or false/);
            assert.doesNotMatch(JSON.stringify(result.body), /owned\/cert/);
            assert.deepEqual(await readRevisions(controller, path), []);
          } else {
            checkedInjectedBody(result, expectedStatus, AgentRevisionResponse);
          }
        }
      });
    }
  });

  test("deploy reports Configuration content a Compute Driver names as unsupported", async () => {
    // D321: a refused Codex Gateway setting surfaced as "resource already exists".
    const computeDriver = createProvisioningCapableComputeDriver();
    let refusal: Error | undefined;
    computeDriver.validateHarnessAuth = () => {
      if (refusal !== undefined) {
        throw refusal;
      }
    };
    const { controller, fixture, namespace } = await readyNamespaceFixture(
      await createAdmissionController({ computeDriver }),
      "unsupported-configuration",
      "Unsupported Configuration content",
    );
    const agent = await createAgent(controller, namespace.id, "unsupported-configuration-agent");
    await bindHarnessKey(fixture, namespace.id, agent);
    const deploy = () =>
      controller.request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);

    refusal = new ConfigurationHarnessError(
      "Configuration setting cron must be an object: a dedicated Codex Gateway cannot apply it otherwise.",
    );
    const named = await deploy();
    assert.equal(checkApiError(named, 400, "INVALID_REQUEST").message, refusal.message);

    // Other driver refusals can carry internal detail and get fixed text, not "already exists".
    refusal = new Error("internal driver detail");
    const generic = await deploy();
    assert.equal(
      checkApiError(generic, 409, "RESOURCE_CONFLICT").message,
      "The selected Compute Driver cannot deliver this Harness authentication binding to the configured model and topology.",
    );
    assert.doesNotMatch(JSON.stringify(generic.body), /internal driver detail/);

    // A gateway setting Kubernetes Compute refuses would fail every preparation attempt as an
    // unavailable dependency; admission names it without its value, as provisioning does.
    refusal = undefined;
    const kubernetes = createTestKubernetesComputeDriver("compute-deploy-gateway-settings");
    computeDriver.validateGatewaySettings = (configuration) =>
      kubernetes.validateGatewaySettings(configuration);
    for (const [name, gateway, message] of [
      [
        "gateway-token-agent",
        { auth: { mode: "token" } },
        "Configuration setting gateway.auth.mode must be trusted-proxy: Kubernetes Compute supports only native trusted-proxy gateway authentication.",
      ],
      [
        "gateway-proxies-agent",
        { trustedProxies: ["10.99.0.0/16"] },
        "Configuration setting gateway.trustedProxies must be omitted or match the Installation's network.gatewayTrustedProxyCidrs.",
      ],
    ] as const) {
      const refusedAgent = await createAgent(controller, namespace.id, name, { gateway });
      await bindHarnessKey(fixture, namespace.id, refusedAgent);
      const path = `/namespaces/${namespace.id}/agents/${refusedAgent.id}`;
      const refused = await controller.request("POST", `${path}/deploy`);
      assert.equal(checkApiError(refused, 409, "RESOURCE_CONFLICT").message, message);
      assert.doesNotMatch(JSON.stringify(refused.body), /10\.99\./);
      assert.deepEqual(await readRevisions(controller, path), []);
    }
    // An allowlist without the machine identity failed only in preparation, after a dedicated
    // deployment stopped its predecessor (finding 3032). Admission names the setting and its
    // requirement, never the submitted identity, before any revision.
    const [allowUsers] = INVALID_ALLOW_USERS_SAMPLE;
    const deniedIdentity = allowUsers?.[0];
    assert(deniedIdentity, "the sample must name an identity to check for redaction");
    const allowUsersAgent = await createAgent(
      controller,
      namespace.id,
      "gateway-allow-users-agent",
      {
        gateway: { auth: { mode: "trusted-proxy", trustedProxy: { allowUsers } } },
      },
    );
    await bindHarnessKey(fixture, namespace.id, allowUsersAgent);
    const allowUsersPath = `/namespaces/${namespace.id}/agents/${allowUsersAgent.id}`;
    const refusedAllowUsers = await controller.request("POST", `${allowUsersPath}/deploy`);
    assert.equal(
      checkApiError(refusedAllowUsers, 409, "RESOURCE_CONFLICT").message,
      KUBERNETES_ALLOW_USERS_REFUSAL,
    );
    assert.doesNotMatch(
      JSON.stringify(refusedAllowUsers.body),
      new RegExp(RegExp.escape(deniedIdentity)),
    );
    assert.deepEqual(await readRevisions(controller, allowUsersPath), []);

    // Deploy authorization comes first: a caller who cannot deploy learns nothing of the setting.
    const deniedAgent = await createAgent(controller, namespace.id, "gateway-denied-agent", {
      gateway: { auth: { mode: "token" } },
    });
    await bindHarnessKey(fixture, namespace.id, deniedAgent);
    const { principal: viewer } = await fixture.createAuthPrincipal("gateway-deploy-viewer");
    fixture.state.identities.push(viewer);
    fixture.state.roles.push({
      id: "role-gateway-deploy-viewer",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
      ],
    });
    fixture.state.bindings.push({
      id: "binding-gateway-deploy-viewer",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: viewer.id,
      roleId: "role-gateway-deploy-viewer",
    });
    const denied = await injectedRequest(
      fixture.createApp(viewer),
      "POST",
      `/namespaces/${namespace.id}/agents/${deniedAgent.id}/deploy`,
    );
    checkApiError(denied, 403, "FORBIDDEN");
    assert.doesNotMatch(JSON.stringify(denied.body), /gateway\.auth|trusted-proxy/);

    // An unavailable hook dependency answers 503; any other hook refusal stays with preparation.
    const hookAgent = await createAgent(controller, namespace.id, "gateway-hook-agent");
    await bindHarnessKey(fixture, namespace.id, hookAgent);
    const hookAgentPath = `/namespaces/${namespace.id}/agents/${hookAgent.id}`;
    const deployHookAgent = () => controller.request("POST", `${hookAgentPath}/deploy`);
    computeDriver.validateGatewaySettings = () => {
      throw new DependencyUnavailableError("The gateway setting check is unavailable.");
    };
    const unavailable = await deployHookAgent();
    checkApiError(unavailable, 503, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(await readRevisions(controller, hookAgentPath), []);
    computeDriver.validateGatewaySettings = () => {
      throw new Error("internal gateway detail");
    };
    const deferred = await deployHookAgent();
    checkedInjectedBody(deferred, 202, AgentRevisionResponse);
  });
}

async function createSshAdmissionFixture(
  hosts: SshComputeDriverOptions["hosts"],
  namespaceName: string,
  { recordOperations }: Pick<FixtureOptions, "recordOperations"> = {},
) {
  const computeDriver = new SshComputeDriver({
    ssh: { identityFile: "/tmp/ssh-test-key", knownHostsFile: "/tmp/ssh-test-hosts" },
    hosts,
    runtime: {
      nodePath: "/usr/bin/node",
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/var/lib/ssh-runtime-test",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
  const controller = await createAdmissionController({ computeDriver, recordOperations });
  await bootstrapInstallation(controller);
  const namespace = await createNamespace(controller, namespaceName);
  // Set Namespace readiness directly so these tests can exercise API admission.
  const { platformState } = controller.fixture;
  assert(platformState, "bootstrap must create State");
  const ready = await platformState.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  assert.equal(ready?.status, "ready");
  return { controller, namespace, platformState };
}

export function registerSshAdmissionCases(): void {
  test("SSH Compute refuses managed mode at save and deploy and validates runtime authentication and deployment authorization", async () => {
    const { controller, namespace, platformState } = await createSshAdmissionFixture(
      { runtime: { address: "127.0.0.1", user: "root" } },
      "runtime",
      { recordOperations: true },
    );
    const configuration = await createConfiguration(
      controller,
      namespace.id,
      createHarnessConfiguration("openclaw", "gpt-5.1"),
    );
    // Neither an actor source grant nor an Agent source grant is needed: OCC owns no source.
    for (const resourceKind of ["secret", "service_account"] as const) {
      for (const action of ["read", "operate"] as const) {
        controller.fixture.state.restrictions.push({
          id: `deny-runtime-${resourceKind}-${action}`,
          namespaceId: namespace.id,
          resourceKind,
          action,
          effect: "deny",
        });
      }
    }
    const collection = `/namespaces/${namespace.id}/agents`;
    for (const extra of [
      { source: { kind: "secret" } },
      { serviceAccountId: "sa_not_allowed" },
      { value: "never-a-credential" },
      { environmentVariable: "OPENAI_API_KEY" },
    ]) {
      const invalid = await controller.request("POST", collection, {
        body: {
          name: "invalid-runtime",
          configurationId: configuration.id,
          harnessAuth: { method: "runtime", ...extra },
        },
      });
      checkApiError(invalid, 400, "INVALID_REQUEST");
    }
    const createdResponse = await controller.request("POST", collection, {
      body: {
        name: "Runtime Agent",
        configurationId: configuration.id,
        harnessAuth: { method: "runtime" },
      },
    });
    const { data: created } = checkedInjectedBody(createdResponse, 201, AgentResponse);
    assert.deepEqual(created.harnessAuth, { method: "runtime" });
    // SSH Compute cannot enforce managed mode, so a new Agent defaults to off (finding 2676).
    assert.equal(created.gatewayManagedMode, false);
    const path = `${collection}/${created.id}`;
    const unsupported =
      "Agent setting gatewayManagedMode is not supported by the selected Compute Driver.";
    // Asking for managed mode fails at save and in the create preflight, not at the next deploy.
    for (const [method, target, body] of [
      [
        "POST",
        collection,
        { name: "Managed SSH Agent", configurationId: configuration.id, gatewayManagedMode: true },
      ],
      [
        "POST",
        `${collection}/validate`,
        {
          configuration: { kind: "agent", values: configuration.values },
          gatewayManagedMode: true,
        },
      ],
      ["PATCH", path, { gatewayManagedMode: true }],
    ] as const) {
      const refused = await controller.request(method, target, { body });
      assert.equal(checkApiError(refused, 400, "INVALID_REQUEST").message, unsupported);
    }
    // An Agent saved before managed mode existed was migrated to on; deploy still refuses it
    // until an Installation administrator turns it off.
    const persisted = await platformState.transact((unit) =>
      unit.agents.updateConfiguration(
        namespace.id,
        created.id,
        configuration.id,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    assert.equal(persisted?.gatewayManagedMode, true);
    const rejected = await controller.request("POST", `${path}/deploy`);
    assert.equal(checkApiError(rejected, 400, "INVALID_REQUEST").message, unsupported);
    assert.deepEqual(await readRevisions(controller, path), []);
    const updated = await controller.request("PATCH", path, {
      body: { gatewayManagedMode: false },
    });
    assert.equal(checkedInjectedBody(updated, 200, AgentResponse).data.gatewayManagedMode, false);
    const deployedResponse = await controller.request("POST", `${path}/deploy`);
    const { data: deployed } = checkedInjectedBody(deployedResponse, 202, AgentRevisionResponse);
    assert.deepEqual(deployed.harnessAuth, { method: "runtime" });
    const admitted = await platformState.read((view) =>
      view.revisions.findRevision(namespace.id, created.id, deployed.id),
    );
    assert.deepEqual(admitted?.harnessAuth, { method: "runtime" });
    const detached = await controller.request("PATCH", path, {
      body: { configurationId: configuration.id, harnessAuth: null },
    });
    assert.equal(checkedInjectedBody(detached, 200, AgentResponse).data.harnessAuth, null);
    const detail = await controller.request("GET", `${path}/revisions/${deployed.id}`);
    const { data: revision } = checkedInjectedBody(detail, 200, AgentRevisionReadResponse);
    assert(
      "harnessAuth" in revision,
      "the admitted revision must remain readable after draft edits",
    );
    assert.deepEqual(revision.harnessAuth, { method: "runtime" });

    // Restore the draft binding so the final request reaches the deploy authorization gate.
    const rebound = await controller.request("PATCH", path, {
      body: { configurationId: configuration.id, harnessAuth: { method: "runtime" } },
    });
    assert.deepEqual(checkedInjectedBody(rebound, 200, AgentResponse).data.harnessAuth, {
      method: "runtime",
    });
    controller.fixture.state.restrictions.push({
      id: "deny-runtime-deploy",
      namespaceId: namespace.id,
      resourceKind: "agent",
      resourceId: created.id,
      action: "deploy",
      effect: "deny",
    });
    checkApiError(await controller.request("POST", `${path}/deploy`), 403, "FORBIDDEN");
  });

  test("SSH Compute names a Harness authentication method other than runtime at Agent save", async () => {
    const { controller, namespace } = await createSshAdmissionFixture(
      { "auth-method": { address: "127.0.0.1", user: "root" } },
      "auth-method",
    );
    const configuration = await createConfiguration(
      controller,
      namespace.id,
      createHarnessConfiguration("openclaw", "gpt-5.1"),
    );
    const secretResponse = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
      body: { name: "model", value: "synthetic-model" },
    });
    const { data: secret } = checkedInjectedBody(secretResponse, 201, SecretResponse);
    const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "API key Agent",
        configurationId: configuration.id,
        harnessAuth: { method: "api_key", source: secret.ref },
      },
    });
    assert.equal(
      checkApiError(created, 400, "INVALID_REQUEST").message,
      "Agent setting harnessAuth.method must be runtime for embedded OpenClaw on SSH Compute: change harnessAuth.",
    );
  });

  test("SSH Compute refuses at deploy gateway authentication and Secret bindings it cannot deliver", async () => {
    // Finding 2351: only preparation refused these, so deploy admitted a revision every
    // preparation attempt failed. Deploy now names the setting, without its value.
    const { controller, namespace } = await createSshAdmissionFixture(
      { "gateway-auth": { address: "127.0.0.1", user: "root" } },
      "gateway-auth",
    );
    const values = createHarnessConfiguration("openclaw", "gpt-5.1");
    const collection = `/namespaces/${namespace.id}/agents`;
    const createAgentFor = async (name: string, configurationId: string) => {
      const created = await controller.request("POST", collection, {
        body: {
          name,
          configurationId,
          harnessAuth: { method: "runtime" },
          gatewayManagedMode: false,
        },
      });
      return checkedInjectedBody(created, 201, AgentResponse).data;
    };
    const deploy = (agent: Pick<AgentWire, "id">) =>
      controller.request("POST", `${collection}/${agent.id}/deploy`);
    const setting = (path: string, requirement: string) =>
      `Configuration setting ${path} ${requirement}.`;
    const gatewayCases: ReadonlyArray<
      readonly [
        name: string,
        gateway?: OpenClawConfigurationDocument | undefined,
        message?: string | undefined,
        secrets?: OpenClawConfigurationDocument,
      ]
    > = [
      [
        "token-mode",
        { auth: { mode: "token" } },
        setting(
          "gateway.auth.mode",
          "must be trusted-proxy or password: SSH Compute supports only native trusted-proxy or password gateway authentication",
        ),
      ],
      [
        "token-field",
        { auth: { token: "synthetic-gateway-token" } },
        setting("gateway.auth.token", "is not a supported native gateway authentication field"),
      ],
      ["auth-not-object", { auth: "password" }, setting("gateway.auth", "must be an object")],
      [
        "other-password-variable",
        {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "SYNTHETIC_GATEWAY_PASSWORD" },
          },
        },
        sshGatewayPasswordRefusal.reference(),
      ],
      // The refusal offers the reference on the default env alias.
      [
        "other-password-variable-custom-alias",
        {
          auth: {
            mode: "password",
            password: { source: "env", provider: "custom", id: "SYNTHETIC_GATEWAY_PASSWORD" },
          },
        },
        sshGatewayPasswordRefusal.reference("custom"),
        { defaults: { env: "custom" } },
      ],
      ["password", { auth: { mode: "password" } }],
      [
        "password-expression",
        { auth: { mode: "password", password: "${OPENCLAW_GATEWAY_PASSWORD}" } },
      ],
      ["omitted", undefined],
      // The unit's EnvironmentFile sets OPENCLAW_GATEWAY_PASSWORD, which every env provider reads,
      // so a SecretRef to it on a custom default alias or a configured env provider deploys (finding
      // 3065); SSH required provider default exactly before.
      [
        "custom-alias-reference",
        {
          auth: {
            mode: "password",
            password: { source: "env", provider: "custom", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
        },
        undefined,
        { defaults: { env: "custom" } },
      ],
      [
        "env-provider-reference",
        {
          auth: {
            mode: "password",
            password: { source: "env", provider: "vault", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
        },
        undefined,
        { providers: { vault: { source: "env", allowlist: ["OPENCLAW_GATEWAY_PASSWORD"] } } },
      ],
      // Password mode renders an unset password and the expression on provider default, which a
      // custom default alias leaves unconfigured: the Gateway would exit at every start, so deploy
      // refuses and offers the reference on the alias.
      ...[undefined, "${OPENCLAW_GATEWAY_PASSWORD}"].map(
        (password) =>
          [
            `${password === undefined ? "unset" : "expression"}-custom-alias`,
            { auth: { mode: "password", ...(password === undefined ? {} : { password }) } },
            sshGatewayPasswordRefusal.rendered(
              "custom",
              unreadableSecretRefProblem("defaultAlias", "custom"),
            ),
            { defaults: { env: "custom" } },
          ] as const,
      ),
      // When OpenClaw cannot read the reference on the default alias either (an allowlist there
      // omits the variable), the refusal states the requirement and offers no reference that the
      // same rule would refuse.
      [
        "unset-alias-allowlist",
        { auth: { mode: "password" } },
        sshGatewayPasswordRefusal.unoffered(unreadableSecretRefProblem("defaultAlias", "vault")),
        {
          defaults: { env: "vault" },
          providers: { vault: { source: "env", allowlist: ["OTHER_SECRET"] } },
        },
      ],
      [
        "unset-default-allowlist",
        { auth: { mode: "password" } },
        sshGatewayPasswordRefusal.unoffered(
          unreadableSecretRefProblem("allowlist", "OPENCLAW_GATEWAY_PASSWORD"),
        ),
        { providers: { default: { source: "env", allowlist: ["OTHER_SECRET"] } } },
      ],
    ];
    for (const [name, gateway, message, secrets] of gatewayCases) {
      const configuration = await createConfiguration(controller, namespace.id, {
        ...values,
        ...(gateway === undefined ? {} : { gateway: { ...values.gateway, ...gateway } }),
        ...(secrets === undefined ? {} : { secrets }),
      });
      const agent = await createAgentFor(`gateway-${name}`, configuration.id);
      const deployed = await deploy(agent);
      if (message === undefined) {
        checkedInjectedBody(deployed, 202, AgentRevisionResponse);
      } else {
        assert.equal(checkApiError(deployed, 409, "RESOURCE_CONFLICT").message, message);
        assert.doesNotMatch(JSON.stringify(deployed.body), /synthetic-gateway|SYNTHETIC/);
        assert.deepEqual(await readRevisions(controller, `${collection}/${agent.id}`), []);
      }
    }

    // Agent save passes no bindings (a Configuration may stage them later); deploy refuses them.
    const secretResponse = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
      body: { name: "tool", value: "synthetic-tool-key" },
    });
    const { data: secret } = checkedInjectedBody(secretResponse, 201, SecretResponse);
    const bound = await controller.request("POST", `/namespaces/${namespace.id}/configurations`, {
      body: {
        kind: "agent",
        values,
        secretBindings: { TOOL_API_KEY: { source: secret.ref, delivery: { type: "env" } } },
      },
    });
    const { data: boundConfiguration } = checkedInjectedBody(bound, 201, ConfigurationResponse);
    const agent = await createAgentFor("secret-bindings", boundConfiguration.id);
    // Grant the Agent the bound Secret, so only the Compute Driver's refusal remains.
    const { state } = controller.fixture;
    state.identities.push({
      kind: "service_principal",
      id: agent.servicePrincipalId,
      namespaceId: namespace.id,
    });
    state.roles.push({
      id: "ssh-tool-key",
      namespaceId: namespace.id,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    state.bindings.push({
      id: "ssh-tool-key",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: "ssh-tool-key",
      resourceKind: "secret",
      resourceId: secret.id,
    });
    const deployed = await deploy(agent);
    assert.equal(
      checkApiError(deployed, 400, "INVALID_REQUEST").message,
      "Configuration secretBindings must be empty on SSH Compute: provision credentials in the operator-owned <agentDir>/env file.",
    );
    assert.deepEqual(await readRevisions(controller, `${collection}/${agent.id}`), []);
  });

  test("SSH Compute refuses at Agent save and deploy a roster or workspace whose main Agent cannot read initial workspace files", async () => {
    // Findings 2285 and 2289: only the host refused these, at deployment, which retried until it
    // failed. The host accepts only a path derived from each Agent's id, which a Configuration
    // cannot name, so any explicit workspace is refused.
    const { controller, namespace, platformState } = await createSshAdmissionFixture(
      { "workspace-roster": { address: "127.0.0.1", user: "root" } },
      "workspace-roster",
    );
    const values = createHarnessConfiguration("openclaw", "gpt-5.1");
    const withAgents = (agents: OpenClawConfigurationDocument) => ({
      ...values,
      agents: { ...values.agents, ...agents },
    });
    const collection = `/namespaces/${namespace.id}/agents`;
    const files = { "USER.md": "ssh-workspace-roster" };
    const create = (name: string, configurationId: string, initialWorkspaceFiles?: typeof files) =>
      controller.request("POST", collection, {
        body: {
          name,
          configurationId,
          harnessAuth: { method: "runtime" },
          gatewayManagedMode: false,
          ...(initialWorkspaceFiles === undefined ? {} : { initialWorkspaceFiles }),
        },
      });
    const roster =
      "Configuration setting agents.entries must hold only main, or be omitted, for initial workspace files: only the main Agent reads them.";
    const workspace = (setting: string) =>
      `Configuration setting ${setting} must be unset for initial workspace files on SSH Compute: the host chooses the workspace under the Agent's own directory.`;
    // Kubernetes Compute accepts this managed path; the SSH host never does.
    const managed = "/home/node/.openclaw/workspace";
    // Keep the model selection, or save treats the Configuration as a draft and checks nothing.
    const defaults = { ...values.agents.defaults, workspace: managed };
    // (Configuration save itself refuses a null main entry.)
    for (const [agents, message] of [
      [{ entries: {} }, roster],
      [{ ownership: "explicit", entries: { main: {}, helper: {} } }, roster],
      [{ defaults }, workspace("agents.defaults.workspace")],
      // The main entry's workspace wins over the defaults, so the refusal names it.
      [
        { defaults, entries: { Main: { workspace: managed } } },
        workspace("agents.entries.Main.workspace"),
      ],
    ] as const) {
      const configuration = await createConfiguration(controller, namespace.id, withAgents(agents));
      const refused = await create("Unreadable setup", configuration.id, files);
      assert.equal(checkApiError(refused, 400, "INVALID_REQUEST").message, message);
      // Without initial workspace files the same Configuration saves.
      const plain = await create(`Plain ${configuration.id}`, configuration.id);
      assert.equal(plain.status, 201, JSON.stringify(plain.body));
    }
    // A main entry in any letter case saves; a roster changed after save refuses the deploy.
    const configuration = await createConfiguration(
      controller,
      namespace.id,
      withAgents({ entries: { Main: {} } }),
    );
    const createdResponse = await create("Pending setup", configuration.id, files);
    const { data: created } = checkedInjectedBody(createdResponse, 201, AgentResponse);
    const changed = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      { body: { values: withAgents({ entries: {} }) } },
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const path = `${collection}/${created.id}`;
    const deployed = await controller.request("POST", `${path}/deploy`);
    assert.equal(checkApiError(deployed, 400, "INVALID_REQUEST").message, roster);
    // A workspace added after save refuses the deploy too.
    const moved = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      { body: { values: withAgents({ entries: { Main: { workspace: managed } } }) } },
    );
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const redeployed = await controller.request("POST", `${path}/deploy`);
    assert.equal(
      checkApiError(redeployed, 400, "INVALID_REQUEST").message,
      workspace("agents.entries.Main.workspace"),
    );
    assert.deepEqual(await readRevisions(controller, path), []);

    // Finding 2286: after the setup completed, every later deployment still delivers it, and the
    // host refuses the same roster again at preparation, where the refusal was retried until the
    // deployment failed. Deployment refuses it with the same message instead.
    const restored = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      { body: { values: withAgents({ entries: { Main: {} } }) } },
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const first = await controller.request("POST", `${path}/deploy`);
    const { data: firstRevision } = checkedInjectedBody(first, 202, AgentRevisionResponse);
    // What the worker records when the first revision activates: the revision becomes active,
    // then the setup completes.
    const [revision] = await readRevisions(controller, path);
    assert.equal(revision?.id, firstRevision.id);
    await platformState.transact(async (unit) => {
      const active = await unit.agents.compareAndSetActiveRevision(
        namespace.id,
        created.id,
        undefined,
        firstRevision.id,
      );
      assert.equal(active?.activeRevisionId, firstRevision.id);
      const setup = await unit.workspaceSetups.find(namespace.id, created.id);
      assert(setup, "Agent save must persist its workspace setup");
      const completed = await unit.workspaceSetups.complete(namespace.id, created.id, setup.id);
      assert(completed, "the active Agent's workspace setup must complete");
    });
    const emptied = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      { body: { values: withAgents({ entries: {} }) } },
    );
    assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
    const completed = await controller.request("POST", `${path}/deploy`);
    assert.equal(checkApiError(completed, 400, "INVALID_REQUEST").message, roster);
    assert.deepEqual(
      (await readRevisions(controller, path)).map(({ id }) => id),
      [firstRevision.id],
    );

    // Finding 2296: an update naming another Configuration checks a completed setup too, so it
    // no longer saves a pair the next deploy refuses. An update that keeps the Configuration and
    // execution mode is not checked, so an Agent already broken by a Configuration write can
    // still be edited.
    const broken = await createConfiguration(controller, namespace.id, withAgents({ entries: {} }));
    const switched = await controller.request("PATCH", path, {
      body: { configurationId: broken.id },
    });
    assert.equal(checkApiError(switched, 400, "INVALID_REQUEST").message, roster);
    // Restating the stored execution mode is no change either.
    for (const body of [
      { configurationId: configuration.id },
      { configurationId: configuration.id, executionMode: created.executionMode },
    ]) {
      const kept = await controller.request("PATCH", path, { body });
      const { data: saved } = checkedInjectedBody(kept, 200, AgentResponse);
      assert.equal(saved.configurationId, configuration.id);
      assert.equal(saved.executionMode, created.executionMode);
    }
  });
}
