import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { OpenShellCredentialRefreshDriver as CredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
  type OpenShellProviderDetachResult,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  ConfigurationValidationError,
  HarnessWorkloadRequirements,
  Namespace,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { SandboxGatewayUnauthorizedError } from "../../packages/occ/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import type { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  completeSandboxRevision,
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";

type BaseInstallation = ReturnType<typeof buildSandboxInstallation>;
type StartupInstallation = BaseInstallation & {
  backend: Array<
    BaseInstallation["backend"][number] & { drivers: { credential_refresh?: string } }
  >;
  drivers: {
    credential_gateway: { configuration: { toolBinaries?: string[] } };
    credential_refresh?: { id: string; configuration: { interval?: number } };
  };
};
type RefusalDetail = ConfigurationValidationError["error"]["details"][number];
type StructuralRefusal = RefusalDetail[];
type CredentialClient = Partial<
  Pick<
    OpenShellGatewayClient,
    "getWorkspace" | "getSandbox" | "detachSandboxProvider" | "getSandboxProviderStatus"
  >
>;
type KubernetesFixtureResource = {
  kind: string;
  metadata: { name: string; namespace?: string };
};
type FixtureDependencies = {
  OpenShellCredentialRefreshDriver: typeof CredentialRefreshDriver;
  conformanceKubernetesOptions: (options: {
    gatewayTrustedProxyCidrs: string[];
  }) => KubernetesComputeDriverOptions;
  credentialGatewayOverProviders: () => {
    client: CredentialClient;
    driver: OpenShellCredentialGatewayDriver;
    context: (sourceId: string) => {
      namespace: Pick<Namespace, "id" | "name">;
      signal: AbortSignal;
    };
  };
  kubernetesObjectClient: (
    events: Array<["kubernetes", "patch" | "delete", string, string, string | undefined]>,
  ) => {
    patch: (resource: KubernetesFixtureResource) => Promise<KubernetesFixtureResource>;
    delete: (resource: KubernetesFixtureResource) => Promise<void>;
  };
  openShellDriver: (client: GrpcOpenShellGatewayClient) => OpenShellSandboxDriver;
  rejectsAtStartup: (
    context: TestContext,
    change: (configuration: StartupInstallation) => void,
    expected: RegExp | StructuralRefusal,
    base: () => StartupInstallation,
  ) => Promise<void>;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options: { harnessId: string },
  ) => {
    context: Pick<SandboxNamespaceContext, "namespace">;
    revision: SandboxFixtureRevision;
    requirements: Pick<HarnessWorkloadRequirements, "credentialAttachments" | "loginMode">;
  };
  sandboxInstallation: () => StartupInstallation;
  structuralRefusal: (
    path: string,
    keyword: string,
    code?: RefusalDetail["code"],
  ) => StructuralRefusal;
};

function hasClientFactory(value: object): value is { createClient: () => Promise<unknown> } {
  return "createClient" in value && typeof value.createClient === "function";
}

export function createCredentialWithdrawalChecks({
  OpenShellCredentialRefreshDriver,
  conformanceKubernetesOptions,
  credentialGatewayOverProviders,
  kubernetesObjectClient,
  openShellDriver,
  rejectsAtStartup,
  runtimeSandboxFixture,
  sandboxInstallation,
  structuralRefusal,
}: FixtureDependencies) {
  return {
    async pairsCredentialRefreshWithGateway(t: TestContext) {
      const refreshing = () => {
        const configuration = sandboxInstallation();
        const backend = configuration.backend[0];
        assert.ok(backend);
        backend.drivers.credential_refresh = "openshell-refresh";
        configuration.drivers.credential_refresh = { id: "openshell-refresh", configuration: {} };
        configuration.drivers.credential_gateway.configuration.toolBinaries = ["/usr/bin/curl"];
        return configuration;
      };
      const createdDriver = await loadInstallationFile(t, refreshing());
      assert.ok(createdDriver?.installation.backend[0]);
      assert.ok(createdDriver.credentialGatewayDriver);
      assert.ok(createdDriver.credentialRefreshDriver instanceof OpenShellCredentialRefreshDriver);
      assert.deepEqual(createdDriver.installation.backend[0].drivers, {
        sandbox: "openshell-sandbox",
        credential_gateway: "openshell-credentials",
        credential_refresh: "openshell-refresh",
      });
      // The gateway offers refresh types only when its Backend can mint their tokens.
      const signal = AbortSignal.timeout(2_000);
      const offered = await createdDriver.credentialGatewayDriver.listSourceTypes({ signal });
      assert.deepEqual(
        offered
          .filter(({ rotation }) => rotation === "refresh")
          .map(({ type }) => type)
          .sort(),
        ["codex-oauth", "oauth2-client-credentials", "oauth2-refresh-token"],
      );
      // The issuer replaces a refresh token on use, so an update must not re-send the recorded one.
      assert.deepEqual(
        offered.flatMap(({ type, secrets }) =>
          secrets
            .filter(({ issuerRotated }) => issuerRotated === true)
            .map(({ name }) => `${type}.${name}`),
        ),
        ["oauth2-refresh-token.refresh_token"],
      );
      const withoutRefresh = sandboxInstallation();
      withoutRefresh.drivers.credential_gateway.configuration.toolBinaries = ["/usr/bin/curl"];
      const staticOnly = await loadInstallationFile(t, withoutRefresh);
      assert.ok(staticOnly?.credentialGatewayDriver);
      assert.deepEqual(
        (await staticOnly.credentialGatewayDriver.listSourceTypes({ signal })).map(
          ({ type }) => type,
        ),
        ["openai", "codex-pat", "bearer-token"],
      );

      // Refresh state lives on the gateway's provider records, so the roles cannot be split.
      const unpaired =
        /drivers\.credential_refresh must match the selected drivers\.credential_refresh\.id/;
      for (const [change, expected] of [
        [(c) => delete c.drivers.credential_refresh, unpaired],
        [
          (c) => {
            const backend = c.backend[0];
            assert.ok(backend);
            delete backend.drivers.credential_refresh;
          },
          unpaired,
        ],
        [
          (c) => Reflect.deleteProperty(c.drivers, "credential_gateway"),
          /drivers\.credential_refresh requires drivers\.credential_gateway/,
        ],
        [
          (c) => {
            assert.ok(c.drivers.credential_refresh);
            c.drivers.credential_refresh.configuration = { interval: 60 };
          },
          structuralRefusal("", "additionalProperties", "UNKNOWN_FIELD"),
        ],
      ] satisfies Array<
        [(configuration: StartupInstallation) => void, RegExp | StructuralRefusal]
      >) {
        await rejectsAtStartup(t, change, expected, refreshing);
      }
    },
    async confirmsCredentialWithdrawalWithWorkspace() {
      const { client, driver, context } = credentialGatewayOverProviders();
      const sourceId = "cs_00000000-0000-4000-8000-0000000000c1";
      const { namespace, signal } = context(sourceId);
      const fullNamespace: Namespace = {
        ...namespace,
        status: "ready",
        createdAt: "2026-09-23T00:00:00.000Z",
      };
      const workspace = openShellWorkspaceName(fullNamespace);
      const provider = openShellProviderName(sourceId);
      const sandbox = "sb-credential";
      const visibleWorkspace = (name: string) => ({
        name,
        labels: {},
        phase: "WORKSPACE_PHASE_ACTIVE",
      });
      let listed: string[] | undefined;
      let detachAnswer: OpenShellProviderDetachResult | undefined;
      // Answers for the next detaches and Sandbox reads, ahead of `detachAnswer` and `listed`.
      const detachAnswers: (OpenShellProviderDetachResult | undefined)[] = [];
      const sandboxAnswers: (string[] | undefined)[] = [];
      const calls: string[][] = [];
      client.getWorkspace = async (name) => {
        calls.push(["getWorkspace", name]);
        return visibleWorkspace(name);
      };
      client.getSandbox = async (request) => {
        calls.push(["getSandbox", request.name]);
        const providers = sandboxAnswers.length === 0 ? listed : sandboxAnswers.shift();
        return providers === undefined
          ? undefined
          : {
              name: request.name,
              workspace: request.workspace,
              labels: {},
              annotations: {},
              serviceUrls: {},
              spec: { providers },
            };
      };
      client.detachSandboxProvider = async (_workspace, name, detached) => {
        calls.push(["detachSandboxProvider", name, detached]);
        return detachAnswers.length === 0 ? detachAnswer : detachAnswers.shift();
      };
      // The receipts the status reads name: each settles the detach it follows.
      const receipts: (string | undefined)[] = [];
      client.getSandboxProviderStatus = async (
        _workspace,
        _sandbox,
        _provider,
        _signal,
        receiptId,
      ) => {
        receipts.push(receiptId);
        return { state: "PROVIDER_READINESS_STATE_REVOKED" };
      };
      const withdrawalRevision = completeSandboxRevision({
        id: "rev_00000000-0000-4000-8000-000000000003",
        namespaceId: namespace.id,
        agentId: "agt_00000000-0000-4000-8000-000000000003",
        sandboxDriverId: "openshell-sandbox",
        harness: {
          id: "codex",
          version: "1.0.0",
          mode: "dedicated",
          overrides: {},
          configuration: {},
        },
      });
      const withdraw = (recheck: boolean) =>
        driver.withdraw({
          namespace: fullNamespace,
          revision: withdrawalRevision,
          sandbox: {
            resourceName: sandbox,
            namespaceName: namespace.name,
            agentId: withdrawalRevision.agentId,
            revisionId: withdrawalRevision.id,
          },
          sourceId,
          signal,
          ...(recheck ? { recheck: true } : {}),
        });
      const refusal = (code: number) =>
        Object.assign(new Error(`${code} refused`), { code, details: "ws" });
      const unauthorized = (recheck: boolean, transient = false) =>
        assert.rejects(withdraw(recheck), (error) => {
          assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
          assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
          assert.equal(error.transient, transient);
          assert.match(error.message, /credential of Sandbox .* cannot be confirmed withdrawn/);
          return true;
        });

      // A detach receipt revokes without any Workspace read.
      detachAnswer = { receiptId: "receipt-1" };
      assert.deepEqual(await withdraw(false), { sourceId, state: "revoked" });
      assert.deepEqual(calls, [["detachSandboxProvider", sandbox, provider]]);
      // A detach that finds no Sandbox is absent only once the Workspace answers and a second
      // Sandbox read still finds none.
      calls.length = 0;
      detachAnswer = undefined;
      assert.deepEqual(await withdraw(false), { sourceId, state: "absent" });
      assert.deepEqual(calls, [
        ["detachSandboxProvider", sandbox, provider],
        ["getWorkspace", workspace],
        ["getSandbox", sandbox],
      ]);
      // Finding 1692: a Sandbox that second read finds (a role restored between the detach and
      // GetWorkspace) is detached again, not recorded absent; a detach that misses it again is
      // unconfirmed, so the worker retries, and a refusal on the second read carries the code.
      calls.length = 0;
      listed = [provider];
      receipts.length = 0;
      detachAnswers.push(undefined, { receiptId: "receipt-restored" });
      assert.deepEqual(await withdraw(false), { sourceId, state: "revoked" });
      assert.deepEqual(calls, [
        ["detachSandboxProvider", sandbox, provider],
        ["getWorkspace", workspace],
        ["getSandbox", sandbox],
        ["detachSandboxProvider", sandbox, provider],
      ]);
      assert.deepEqual(receipts, ["receipt-restored"]);
      detachAnswers.push(undefined, undefined);
      await assert.rejects(
        withdraw(false),
        /GetSandbox finds Sandbox .* but DetachSandboxProvider did not, so the credential .* cannot be confirmed withdrawn/,
      );
      assert.equal(detachAnswers.length, 0);
      const sandboxRead = client.getSandbox;
      client.getSandbox = async () => {
        throw refusal(16);
      };
      await unauthorized(false, true);
      client.getSandbox = sandboxRead;
      // Outside a recheck only a receipt revokes: a restored Sandbox that does not list the provider
      // is detached all the same.
      calls.length = 0;
      receipts.length = 0;
      listed = ["operator-static"];
      detachAnswers.push(undefined, { receiptId: "receipt-unlisted" });
      assert.deepEqual(await withdraw(false), { sourceId, state: "revoked" });
      assert.deepEqual(calls, [
        ["detachSandboxProvider", sandbox, provider],
        ["getWorkspace", workspace],
        ["getSandbox", sandbox],
        ["detachSandboxProvider", sandbox, provider],
      ]);
      assert.deepEqual(receipts, ["receipt-unlisted"]);
      listed = [provider];
      // A refusal on the receipt's status read carries the code too.
      const statusRead = client.getSandboxProviderStatus;
      client.getSandboxProviderStatus = async () => {
        throw refusal(7);
      };
      detachAnswers.push({ receiptId: "receipt-refused" });
      await unauthorized(false);
      client.getSandboxProviderStatus = statusRead;
      listed = undefined;
      for (const code of [7, 16]) {
        client.getWorkspace = async () => {
          throw refusal(code);
        };
        await unauthorized(false, code === 16);
      }
      client.getWorkspace = async () => undefined;
      await assert.rejects(
        withdraw(false),
        /reports no Workspace .* cannot be confirmed withdrawn/,
      );
      // The refusal on the detach itself carries the same code.
      client.getWorkspace = async (name) => {
        calls.push(["getWorkspace", name]);
        return visibleWorkspace(name);
      };
      client.detachSandboxProvider = async () => {
        throw refusal(7);
      };
      await unauthorized(false);
      // A recheck reads the Sandbox first: a listed provider is detached again, a Sandbox without it
      // is revoked, and a missing one is absent only with the Workspace's confirmation.
      calls.length = 0;
      client.detachSandboxProvider = async (_workspace, name, detached) => {
        calls.push(["detachSandboxProvider", name, detached]);
        return { receiptId: "receipt-2" };
      };
      listed = ["operator-static", provider];
      assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
      listed = ["operator-static"];
      assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
      listed = undefined;
      assert.deepEqual(await withdraw(true), { sourceId, state: "absent" });
      assert.deepEqual(calls, [
        ["getSandbox", sandbox],
        ["detachSandboxProvider", sandbox, provider],
        ["getSandbox", sandbox],
        ["getSandbox", sandbox],
        ["getWorkspace", workspace],
        ["getSandbox", sandbox],
      ]);
      // A recheck whose second read finds the Sandbox without the provider is revoked, no detach;
      // one that lists it is detached again.
      calls.length = 0;
      sandboxAnswers.push(undefined, ["operator-static"]);
      assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
      sandboxAnswers.push(undefined, ["operator-static", provider]);
      assert.deepEqual(await withdraw(true), { sourceId, state: "revoked" });
      assert.deepEqual(calls, [
        ["getSandbox", sandbox],
        ["getWorkspace", workspace],
        ["getSandbox", sandbox],
        ["getSandbox", sandbox],
        ["getWorkspace", workspace],
        ["getSandbox", sandbox],
        ["detachSandboxProvider", sandbox, provider],
      ]);
      client.getWorkspace = async () => {
        throw refusal(16);
      };
      await unauthorized(true, true);
      client.getSandbox = async () => {
        throw refusal(7);
      };
      await unauthorized(true);
    },
    async preservesWithdrawalCancellationBeforeProviderLookup(t: TestContext) {
      const client = new GrpcOpenShellGatewayClient({ endpoint: "http://127.0.0.1:1" });
      const observableClient: object = client;
      assert.ok(hasClientFactory(observableClient));
      const initialize = t.mock.method(observableClient, "createClient", async () => {
        throw new Error("Cancelled withdrawal must not initialize the provider client.");
      });
      const sandbox = openShellDriver(client);
      const {
        context,
        revision: fixtureRevision,
        requirements,
      } = runtimeSandboxFixture(sandbox, {
        harnessId: "openclaw",
      });
      const compute = new KubernetesComputeDriver(
        conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
        { sandboxDriver: sandbox },
      );
      const revision = {
        ...completeWorkspaceRevision(fixtureRevision, requirements),
        compute: { id: compute.id, implementation: compute.implementation },
      };
      const caller = new AbortController();
      const reason = new Error("stop withdrawal during namespace lookup");
      const objects = kubernetesObjectClient([]);
      // Control only Kubernetes IO: retain the real context/signal composition, Sandbox
      // withdrawal, identity wrapper, getService and unary cancellation checks.
      Object.assign(compute, {
        apiClients: Promise.resolve({ objects }),
        executionApiClients: Promise.resolve({ objects }),
        resolveNamespace: async () => ({
          name: { name: context.namespace.name, plane: "execution" },
          external: false,
        }),
        getNamespace: async () => {
          assert.equal(caller.signal.aborted, false);
          caller.abort(reason);
          // A missing namespace still requires provider confirmation of withdrawal.
          return undefined;
        },
      });
      await assert.rejects(
        compute.withdrawHarnessExposure(revision, caller.signal),
        (error) => error === reason,
      );
      // Include the next event-loop turn: no late setup may dispatch a provider read
      // or deletion after the withdrawal has rejected. Cold RPCs require initialization.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(initialize.mock.callCount(), 0);
    },
  };
}
