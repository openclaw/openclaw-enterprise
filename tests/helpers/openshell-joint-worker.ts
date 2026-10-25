import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentRevision, ProxyPlan } from "../../packages/contracts/src/index.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { harnessEgressEnrollment } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  codexWorkspaceProviderRef,
  codexWorkspaceRoutes,
} from "../../apps/controller/src/drivers/egress-proxy/codex-workspace-provider.ts";
import { jointWorkspaceProfile } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { createOpenShellCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-registration.ts";
import type { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { openShellEgressConfiguration } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { availablePort } from "../helpers/available-port.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import {
  launchCompute,
  launchRequirements,
  sandboxContext,
} from "../helpers/codex-launch-compat.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const repositoryMiddlewareName = "fixture-installation";
const egress = {
  middlewareName: jointWorkspaceProfile,
  repositoryMiddlewareName,
  authorityScope: "execution",
} as const;

type Profile = {
  id: string;
  resource_version: string;
  credentials?: {
    auth_style: string;
    token_grant: { cache_ttl?: object; audience: string };
  }[];
  endpoints?: { host: string; port: number; path: string }[];
};
type Provider = {
  metadata: {
    labels: Record<string, string>;
    name: string;
    id: string;
    workspace: string;
    resource_version: string;
  };
  type: string;
  profile_workspace: string;
  credentials?: object;
};
type Spec = {
  providers: string[];
  provider_attachment_epoch: string;
  restart_policy: string;
  policy: { network_middlewares: Record<string, { require_execution_admission?: boolean }> };
  environment: Record<string, string>;
};
type Request = {
  name: string;
  id: string;
  sandbox: string;
  spec: Spec;
  labels: object;
  annotations: object;
  workspace_scope: { workspace: string };
  profiles: { profile: Profile }[];
  provider: Provider;
};

/** The peer stores the decoded wire requests; only it assigns resource IDs, versions and epoch.
 * This is a Gateway protocol test. No supplier, workload, token grant, or external host runs. */
async function gatewayPeer(t: TestContext, tls: Awaited<ReturnType<typeof harnessTlsFixture>>) {
  const descriptor = new URL(
    "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    import.meta.url,
  ).pathname;
  const proto = loader.loadSync(descriptor, {
    keepCase: true,
    enums: String,
    longs: String,
  });
  const Gateway = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const profiles = new Map<string, Profile>();
  const providers = new Map<string, Provider>();
  let creates = 0;
  let epoch: string = randomUUID();
  let sandboxId: string = randomUUID();
  let box: { metadata: object; spec: Spec } | undefined;
  const serviceUrl = "https://localhost:9443";
  const handlers: Record<string, (q: Request) => object | undefined> = {
    GetGatewayInfo: () => ({
      extensions: [
        {
          configured_name: repositoryMiddlewareName,
          kind: 4,
          protocol_major: 1,
        },
      ],
    }),
    GetWorkspace: ({ name }) => ({
      workspace: { metadata: { name, id: "test-workspace-id" } },
    }),
    GetProviderProfile({ id }) {
      const profile = profiles.get(id);
      return profile && { profile };
    },
    ImportProviderProfiles({ profiles: imports }) {
      const profile = imports[0]?.profile;
      assert.ok(profile);
      assert.equal(profiles.has(profile.id), false);
      profiles.set(profile.id, { ...profile, resource_version: "19" });
      return { imported: true };
    },
    GetProvider({ name }) {
      const provider = providers.get(name);
      return provider && { provider };
    },
    CreateProvider(q) {
      const p = q.provider;
      assert.equal(providers.has(p.metadata.name), false);
      const workspace = q.workspace_scope.workspace;
      const metadata = {
        ...p.metadata,
        id: randomUUID(),
        workspace,
        resource_version: "23",
      };
      const provider = { ...p, metadata };
      assert.equal(p.profile_workspace, workspace);
      assert.deepEqual(
        p.credentials ?? {},
        {},
        "no stored credential, even on the runtime provider",
      );
      providers.set(metadata.name, provider);
      return { provider };
    },
    CreateSandbox(q) {
      creates++;
      assert.equal(creates, 1, "reconciling cannot replay provider or Sandbox creation");
      assert.equal(q.spec.provider_attachment_epoch, undefined, "only Gateway assigns the epoch");
      const metadata = {
        name: q.name,
        id: sandboxId,
        workspace: q.workspace_scope.workspace,
        labels: q.labels,
        annotations: q.annotations,
      };
      box = { metadata, spec: { ...q.spec, provider_attachment_epoch: epoch } };
      return { sandbox: box, service_urls: { "": serviceUrl } };
    },
    GetSandbox: () =>
      box && {
        sandbox: {
          metadata: { ...box.metadata, id: sandboxId },
          spec: { ...box.spec, provider_attachment_epoch: epoch },
          status: { phase: "SANDBOX_PHASE_READY" },
        },
      },
    GetService: ({ sandbox }) => ({
      endpoint: { sandbox, name: "", target_port: 4500, authorization_mode: 2 },
      url: serviceUrl,
    }),
  };
  const server = new grpc.Server();
  type Call = { request: Request; metadata: { get(name: string): string[] } };
  server.addService(
    Gateway.service,
    Object.fromEntries(
      Object.entries(handlers).map(([method, handle]) => [
        method,
        (call: Call, reply: (error: object | null, result?: object) => void) => {
          if (call.metadata.get("authorization")[0] !== "Bearer fixture-only-joint-gateway") {
            reply({ code: grpc.status.UNAUTHENTICATED });
            return;
          }
          const result = handle(call.request);
          reply(result ? null : { code: grpc.status.NOT_FOUND }, result);
        },
      ]),
    ),
  );
  t.after(() => server.forceShutdown());
  const credentials = grpc.ServerCredentials.createSsl(null, [
    { private_key: Buffer.from(tls.key), cert_chain: Buffer.from(tls.cert) },
  ]);
  const port = await new Promise<number>((ok, bad) =>
    server.bindAsync("127.0.0.1:0", credentials, (e: Error | null, p: number) =>
      e ? bad(e) : ok(p),
    ),
  );
  const path = join(tls.directory, "gateway-identity");
  await writeFile(path, "fixture-only-joint-gateway", { mode: 0o600 });
  const client = new OpenShellGateway({
    endpoint: "https://localhost:" + port,
    rootCertificatePath: tls.rootCertificatePath,
    auth: { mode: "bearerTokenFile", path },
  });
  t.after(() => client.close());
  return {
    client,
    profiles,
    providers,
    get sandbox() {
      return box;
    },
    get epoch() {
      return epoch;
    },
    get sandboxId() {
      return sandboxId;
    },
    removeSandbox() {
      box = undefined;
      creates = 0;
      epoch = randomUUID();
      sandboxId = randomUUID();
    },
    replaceEpoch() {
      epoch = randomUUID();
    },
    replaceSandbox() {
      sandboxId = randomUUID();
    },
  };
}

export async function jointWorker(
  t: TestContext,
  database?: {
    registry: ReturnType<typeof validateGitHubRepositoryRegistry>;
    revision: AgentRevision;
    driver: NonNullable<ProxyPlan["driver"]>;
  },
) {
  const tls = await harnessTlsFixture(t);
  const peer = await gatewayPeer(t, tls);
  const { revision: seed }: { revision: AgentRevision } = JSON.parse(
    await readFile(
      new URL("../fixtures/codex-launch-before-workspace.json", import.meta.url),
      "utf8",
    ),
  );
  const { namespaceId, agentId, servicePrincipalId } = database?.revision ?? seed;
  const sandboxId = "sandbox-compat";
  const registry =
    database?.registry ??
    validateGitHubRepositoryRegistry({
      version: 1,
      backendId: "fixture-github",
      providerInstanceId: "fixture-github",
      appId: "12345",
      githubInstallationId: "67890",
      maximumDurationSeconds: 600,
      repositories: [],
      installationAccess: {
        repositoryRef: "installation",
        namespaces: [{ namespaceId, accessMode: "installation", grantGeneration: 7 }],
      },
    });
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId,
    repositoryRef: registry.installationAccess!.repositoryRef,
    profile: "github-installation",
  });
  const repositoryGit = {
    driver: database?.revision.repositoryCredentials?.driver ?? {
      id: "repo",
      implementation: "github",
    },
    bindings: [binding],
    deadlineWallMs: Date.now() + 600_000,
  };
  function version(sequence: number) {
    const revisionId = database ? "rev_" + randomUUID() : seed.id;
    const execution = {
      namespaceId,
      agentId,
      servicePrincipalId,
      revisionId,
      executionId: "binding_" + randomUUID().replaceAll("-", "").slice(0, 24),
      installationId: "fixture-installation",
    };
    const ref = { id: "fixture-model", generation: 1 };
    const plan: ProxyPlan = {
      id: "joint-plan",
      ...(database && { driver: database.driver }),
      sandboxDriverId: sandboxId,
      egressDriverId: sandboxId,
      generation: 1,
      policyReductionVersion: 3,
      repositoryGitAuthorization: "online-request",
      repositoryGit,
      execution,
      routes: codexWorkspaceRoutes({
        binding: ref,
        execution,
        source: {
          installationId: execution.installationId,
          namespaceId,
          provider: codexWorkspaceProviderRef,
          source: ref,
          backend: ref,
        },
        grant: {
          kind: "workspace_inference",
          workspaceId: "fixture-workspace",
          models: ["fixture-model"],
          providerTools: "none",
        },
        grantHash: "a".repeat(64),
        isolationId: execution.executionId,
      }),
    };
    const revision: AgentRevision = {
      ...seed,
      ...(database && {
        ...database.revision,
        harness: seed.harness,
        revision: database.revision.revision + sequence,
      }),
      id: revisionId,
      sandboxDriverId: sandboxId,
      repositoryCredentials: repositoryGit,
      egressPlan: plan,
      executionAdmission: { version: 8, mode: "protected" },
    };
    return { execution, plan, revision };
  }
  const initial = version(1);
  const endpoint = "https://localhost:" + (await availablePort()) + "/token/git";
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(tls.directory, "authority.pub");
  const bundlePath = join(tls.directory, "bundle.json");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(
    bundlePath,
    JSON.stringify({
      keys: [
        {
          ...keys.publicKey.export({ format: "jwk" }),
          kid: "test-only",
          use: "jwt-svid",
        },
      ],
    }),
  );
  const authority = {
    host: "127.0.0.1",
    port: await availablePort(),
    certificatePath: join(tls.directory, "server.pem"),
    privateKeyPath: join(tls.directory, "server.key"),
    issuerPublicKeyPath,
    issuer: "https://gateway.example.test",
    audience: "online-authorizer",
    keyId: "gateway-key",
  };
  let runtime: OpenShellGitRuntime | undefined;
  const capabilities = createOpenShellCapabilities({
    sandbox: {
      id: sandboxId,
      implementation: "openshell",
      configuration: {
        gateway: { workspaceMode: "operator" },
        kubernetes: {
          runtimeClassName: "fixture",
          serviceAccount: { mode: "gatewayConfigured" },
          sandboxDataMount: {
            subPath: "workspace",
            mountPath: "/sandbox/workspace",
            readOnly: false,
          },
        },
        policy: {
          process: { runAsUser: "1000", runAsGroup: "1000" },
          networkPolicies: [
            {
              name: "model",
              binaries: [{ path: "/usr/bin/codex" }],
              endpoints: [{ host: "model.invalid", ports: [443] }],
            },
          ],
        },
      },
    },
    backend: {
      id: "openshell",
      drivers: { sandbox: sandboxId },
      client: peer.client,
    },
    operatorOwnedKubernetesResources: true,
    createSandbox(options, selection) {
      runtime = selection.openShellGit;
      return new OpenShellSandboxDriver(
        options as unknown as ConstructorParameters<typeof OpenShellSandboxDriver>[0],
        selection,
      );
    },
    proxy: {
      id: sandboxId,
      preparedProviders: [],
      configuration: egress,
      exchangeAuthority: authority,
    },
    repository: {
      resolveDelivery: createGitHubRepositoryDeliveryResolver(registry),
      configuration: {
        registrationName: repositoryMiddlewareName,
        tokenEndpoint: endpoint,
        tokenTrust: {
          subjectPrefix: "spiffe://test.invalid/supervisor/",
          bundlePath,
          algorithm: "EdDSA",
        },
        authority,
      },
    },
  });
  t.after(() => capabilities.close());
  assert.ok(runtime);
  const { requirements } = launchRequirements(launchCompute(), seed);
  // Kubernetes is a read-only fixture. Replacing this Ready Pod at the same name
  // changes its UID; only the production Sandbox Driver decides if that is acceptable.
  const pod = {
    uid: randomUUID() as string,
    beforeReply: undefined as (() => Promise<void>) | undefined,
  };
  const { KubernetesObjectApi } = require("@kubernetes/client-node");
  const kubernetes: unknown = Object.assign(Object.create(KubernetesObjectApi.prototype), {
    async read({
      kind,
      metadata,
    }: {
      kind: string;
      metadata: { name: string; namespace: string };
    }) {
      const id = peer.sandboxId;
      assert.equal(kind, "Pod");
      assert.equal(metadata.name, "os-supervisor-" + id);
      const uid = pod.uid;
      await pod.beforeReply?.();
      return {
        metadata: {
          ...metadata,
          uid,
          labels: {
            "openshell.ai/sandbox-id": id,
            "openshell.ai/boundary-pair": id,
            "openshell.ai/boundary-role": "supervisor",
          },
        },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
          containerStatuses: [
            {
              ready: true,
              restartCount: 0,
              state: { running: {} },
              containerID: "containerd://fixture",
            },
          ],
        },
      };
    },
  });
  const provision = ({ revision, plan } = initial) => {
    const ctx = sandboxContext(revision, requirements);
    const configuration = openShellEgressConfiguration(plan, egress);
    const environment = ctx.requirements.environment.filter(
      (x) => x.name !== "OPENAI_API_KEY" && x.name !== "APP_SERVER_PORT",
    );
    environment.push({ name: "APP_SERVER_PORT", value: "4500" });
    const files = ctx.requirements.files?.map((file) =>
      file.name !== "runtime.json"
        ? file
        : {
            ...file,
            content: JSON.stringify({
              ...JSON.parse(file.content),
              providerTools: "none",
              egressEnrollment: harnessEgressEnrollment(plan),
            }),
          },
    );
    return capabilities.sandbox.provisionHarness!({
      ...ctx,
      kubernetes,
      signal: t.signal,
      requirements: {
        ...ctx.requirements,
        environment,
        files,
        loginMode: "codex_pat",
        proxyWiring: { plan, configuration },
      },
    });
  };
  return {
    runtime,
    capabilities,
    tls,
    keys,
    authority,
    endpoint,
    pod,
    provision,
    peer,
    ...initial,
    version,
    binding,
  };
}

export function connectJointMiddleware(
  t: TestContext,
  worker: Awaited<ReturnType<typeof jointWorker>>,
) {
  const proto = new URL(
    "../../apps/controller/src/drivers/egress-proxy/proto/supervisor_middleware.proto",
    import.meta.url,
  );
  const Client = grpc.loadPackageDefinition(
    loader.loadSync(proto.pathname, {
      keepCase: true,
      longs: String,
      enums: Number,
      defaults: false,
      oneofs: true,
    }),
  ).openshell.middleware.v1.SupervisorMiddleware;
  const client = new Client(
    "localhost:" + worker.authority.port,
    grpc.credentials.createSsl(Buffer.from(worker.tls.caBundle)),
  );
  t.after(() => client.close());
  return client;
}
