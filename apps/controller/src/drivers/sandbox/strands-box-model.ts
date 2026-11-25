import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  validateDeploymentPolicy,
  type DeploymentPolicy,
  type DeploymentRequestMatch,
  type SandboxHarnessContext,
} from "@openclaw-enterprise/contracts";
import type { StrandsBoxOptions } from "./strands-box.ts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { isDeepStrictEqual } from "node:util";
import {
  PLUGIN_RUNTIME_CODEX_CONFIG,
  PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
  PLUGIN_RUNTIME_MANIFEST,
  PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
  pluginRuntimeSpecForRevision,
  pluginRuntimeConfigMapData,
} from "../compute/plugin-runtime.ts";
import { DEFAULT_MODEL_BASE_URL, savedModelProvider } from "../compute/model-provider.ts";

// Reviewed whole-workload route. Box 0.3.1 formats env:// phantom
// credentials as Authorization: Bearer <key> unless configured otherwise.
export const OPENAI_RESPONSES = {
  host: "api.openai.com",
  port: 443,
  method: "POST",
  path: "/v1/responses",
  key: "OPENAI_API_KEY",
  launcherKey: "OCE_STRANDS_OPENAI_KEY",
} as const;

const MODEL_WORKLOAD_ENVIRONMENT = new Set([
  "CODEX_LOGIN_MODE",
  "LOG_FORMAT",
  "RUST_LOG",
  "OPENCLAW_HARNESS_MODEL",
  "OPENCLAW_PLUGIN_READY_MARKER",
  "APP_SERVER_PORT",
  "HOME",
  "PATH",
  "CODEX_HOME",
  "OPENCLAW_NODE_STATE_DIR",
  "OPENCLAW_NODE_DISPLAY_NAME",
  "OPENCLAW_NODE_CA_PEM",
  "OPENCLAW_WORKSPACE_BOOTSTRAP",
  "OPENCLAW_WORKSPACE_DIR",
]);

export function refuse(): never {
  throw new SandboxRevisionUnsupportedError(
    "SANDBOX_HARNESS_UNSUPPORTED",
    "Strands Box cannot preserve these prepared workload requirements.",
  );
}

export const STOCK_BOX_PROFILE = "oce-strands-box-v0.3.1";

export function validStockConfiguration(options: StrandsBoxOptions): boolean {
  const launcher = options.kubernetes.stockLauncher;
  const grants = launcher?.agentGrants;
  const grant = grants?.[0];
  return (
    typeof launcher?.namespace === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(launcher.namespace) &&
    launcher.namespace !== options.kubernetes.controlPlanePeer?.namespace &&
    (grants === undefined
      ? Object.keys(launcher).length === 1
      : Object.keys(launcher).length === 2 &&
        Array.isArray(grants) &&
        grants.length === 1 &&
        grant?.profile === "openai-responses" &&
        typeof grant.agentId === "string" &&
        grant.agentId.length > 0 &&
        typeof grant.sourceId === "string" &&
        grant.sourceId.length > 0 &&
        Object.keys(grant).length === 3) &&
    options.kubernetes.seccompProfile === `${STOCK_BOX_PROFILE}.json` &&
    isDeepStrictEqual(options.policy, {
      network: { endpoints: [{ host: OPENAI_RESPONSES.host, ports: [OPENAI_RESPONSES.port] }] },
    })
  );
}

export const STOCK_RESPONSES_MATCH = immutableCopy({
  subject: "agent",
  host: OPENAI_RESPONSES.host,
  ports: [{ from: OPENAI_RESPONSES.port, to: OPENAI_RESPONSES.port }],
  requestPolicy: { type: "http", method: OPENAI_RESPONSES.method, path: OPENAI_RESPONSES.path },
} satisfies DeploymentRequestMatch);

// Both grants must authorize every contained process. A binary rule or any
// other route cannot be preserved by this fixed Box policy.
export function supportsStockPolicy(policy: DeploymentPolicy): boolean {
  const allowed = [STOCK_RESPONSES_MATCH];
  const binding = policy.bindings[0];
  const source = binding?.sourceRef;
  if (
    !source?.id ||
    !source.namespaceId ||
    binding?.consumer.kind !== "model" ||
    !["openai", "codex"].includes(binding.consumer.providerId) ||
    policy.bindings.length !== 1 ||
    policy.injectionPolicies.length !== 1 ||
    policy.injectionPolicies[0]!.allowedRequests.length !== 1
  ) {
    return false;
  }
  const identity = {
    bindingRef: "model",
    sourceRef: { kind: "credential_source", id: source.id, namespaceId: source.namespaceId },
    consumer: { kind: "model", providerId: binding.consumer.providerId },
  };
  const projection = { environment: OPENAI_RESPONSES.key, presentation: "bearer" } as const;
  return (
    validateDeploymentPolicy(policy, {
      ceiling: allowed,
      targetMayHoldPlaceholders: true,
      sandbox: {
        wildcards: false,
        portRanges: false,
        supportsAgentSubject: true,
        supportsNetworkPolicy: (network) => isDeepStrictEqual(network, { allowed }),
      },
      authorityForBinding: (requested) =>
        isDeepStrictEqual(requested, identity)
          ? { destinations: [OPENAI_RESPONSES], allowedRequests: allowed, projection }
          : undefined,
      proxy: {
        supportsAgentSubject: true,
        distinguishesExecutable: false,
        distinguishesPort: true,
        rejectsStaleAndMisplacedPlaceholders: true,
        supportsBindingRequest: (requested, match) =>
          isDeepStrictEqual(requested, { ...identity, projection }) &&
          isDeepStrictEqual(match, STOCK_RESPONSES_MATCH),
      },
    }).length === 0
  );
}

type Revision = SandboxHarnessContext["revision"];

export function validateStockRevision(revision: Revision) {
  const {
    harnessAuth: auth,
    sandboxPolicy,
    sandboxDriverId,
    credentialDeployment: policy,
  } = revision;
  if (
    !isDeepStrictEqual(revision.executionAdmission, { version: 8, mode: "standalone" }) ||
    !revision.configurationId ||
    revision.harness.id !== "codex" ||
    revision.harness.mode !== "dedicated" ||
    revision.repositoryCredentials !== undefined ||
    revision.egressPlan !== undefined ||
    revision.networkProxy !== undefined ||
    Object.keys(revision.plugins?.plugins ?? {}).length !== 0 ||
    auth.method !== "credential_source" ||
    auth.sourceType !== "static" ||
    !auth.tokenServiceInstanceId ||
    auth.credentialGatewayId !== undefined ||
    auth.loginMode !== undefined ||
    (revision.credentialSources?.length &&
      !isDeepStrictEqual(revision.credentialSources, [
        {
          sourceId: auth.sourceId,
          sourceType: auth.sourceType,
          tokenServiceInstanceId: auth.tokenServiceInstanceId,
        },
      ])) ||
    !sandboxDriverId ||
    !sandboxPolicy ||
    !Number.isSafeInteger(sandboxPolicy.version) ||
    sandboxPolicy.version < 1 ||
    !isDeepStrictEqual(sandboxPolicy, {
      driverId: sandboxDriverId,
      implementation: "strands-box",
      version: sandboxPolicy.version,
      defaults: {},
      additions: [],
    }) ||
    policy?.proxyDriverId !== sandboxDriverId ||
    policy.driver.id !== sandboxDriverId ||
    policy.driver.implementation !== "strands-box" ||
    !supportsStockPolicy(policy) ||
    policy.bindings[0]!.sourceRef.namespaceId !== revision.namespaceId ||
    policy.bindings[0]!.sourceRef.id !== auth.sourceId
  ) {
    refuse();
  }
  requireResponsesProvider(revision);
  return { sourceId: auth.sourceId, configurationId: revision.configurationId };
}

export function stockModelDelivery(
  { namespace, requirements, revision }: SandboxHarnessContext,
  options: StrandsBoxOptions,
) {
  const launcher = options.kubernetes.stockLauncher;
  if (launcher === undefined) {
    if (
      revision.executionAdmission.mode === "standalone" ||
      revision.credentialDeployment !== undefined
    ) {
      refuse();
    }
    return undefined;
  }
  if (
    !validStockConfiguration(options) ||
    launcher.namespace !== namespace.name ||
    revision.namespaceId !== namespace.id ||
    requirements.loginMode !== "api_key" ||
    requirements.proxyWiring !== undefined ||
    requirements.workloadIdentity !== undefined
  ) {
    refuse();
  }
  const grant = launcher.agentGrants?.[0];
  if (grant) {
    const staged = validateStockRevision(revision);
    if (grant.agentId !== revision.agentId || grant.sourceId !== staged.sourceId) {
      refuse();
    }
    requireResponsesRuntime(revision, requirements);
    requireModelEnvironment(requirements);
    return { staged };
  }
  if (
    revision.credentialDeployment !== undefined ||
    revision.repositoryCredentials !== undefined ||
    revision.sandboxPolicy !== undefined ||
    revision.harness.id !== "codex" ||
    revision.harness.mode !== "dedicated" ||
    revision.harnessAuth.method !== "api_key" ||
    revision.executionAdmission.mode !== "unprotected" ||
    revision.egressPlan !== undefined
  ) {
    refuse();
  }
  requireResponsesProvider(revision);
  requireResponsesRuntime(revision, requirements);
  return { secretKeyRef: preparedModelKey(requirements) };
}

function requireResponsesProvider(revision: Revision): void {
  // Admit the ordinary Compute-generated HTTPS provider. An arbitrary TOML file
  // or another endpoint could direct Codex away from this model route.
  const provider = savedModelProvider(revision.harness.configuration);
  if (
    provider?.baseUrl !== DEFAULT_MODEL_BASE_URL ||
    provider.protocol !== "openai-responses" ||
    provider.supportsStandaloneWebSearch
  ) {
    refuse();
  }
}

function requireResponsesRuntime(
  revision: Revision,
  requirements: SandboxHarnessContext["requirements"],
): void {
  const runtime = pluginRuntimeSpecForRevision(revision, undefined, DEFAULT_MODEL_BASE_URL);
  if (runtime?.kind !== "codex" || Object.keys(runtime.selections).length) {
    refuse();
  }
  const data = pluginRuntimeConfigMapData(runtime);
  const files = new Map([
    [PLUGIN_RUNTIME_MANIFEST, PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT],
    [PLUGIN_RUNTIME_CODEX_CONFIG, PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT],
  ]);
  if (requirements.files.length !== files.size) {
    refuse();
  }
  for (const file of requirements.files) {
    if (
      files.get(file.name) !== file.environmentVariable ||
      data[file.name] !== file.content ||
      !files.delete(file.name)
    ) {
      refuse();
    }
  }
}

function preparedModelKey(requirements: SandboxHarnessContext["requirements"]) {
  // transportVerifier checks namespace, Agent and revision ownership. Require
  // the model key from that exact Secret and refuse a second projection of it.
  const model = requirements.environment.find(({ name }) => name === OPENAI_RESPONSES.key);
  const transport = requirements.environment.find(({ name }) => name === "APP_SERVER_TOKEN");
  if (
    !model ||
    !("valueFrom" in model) ||
    "value" in model ||
    !transport ||
    !("valueFrom" in transport)
  ) {
    refuse();
  }
  const reference = model.valueFrom.secretKeyRef;
  if (
    !reference.name ||
    reference.name !== transport.valueFrom.secretKeyRef.name ||
    reference.key !== OPENAI_RESPONSES.key ||
    Object.keys(reference).length !== 2
  ) {
    refuse();
  }
  requireModelEnvironment(requirements, model);
  return { name: reference.name, key: reference.key };
}

function requireModelEnvironment(
  requirements: SandboxHarnessContext["requirements"],
  model?: SandboxHarnessContext["requirements"]["environment"][number],
) {
  const reference = model && "valueFrom" in model ? model.valueFrom.secretKeyRef : undefined;
  const aliasesModelKey = (other: { name: string; key: string }) =>
    other.name === reference?.name && other.key === reference.key;

  for (const item of requirements.environment) {
    if (item === model) {
      continue;
    }
    if ("valueFrom" in item) {
      if (
        (item.name !== "APP_SERVER_TOKEN" && item.name !== "OPENCLAW_NODE_SETUP_CODE") ||
        aliasesModelKey(item.valueFrom.secretKeyRef)
      ) {
        refuse();
      }
    } else if (!MODEL_WORKLOAD_ENVIRONMENT.has(item.name)) {
      refuse();
    }
  }
  if (requirements.workspaceSetup && aliasesModelKey(requirements.workspaceSetup.secretKeyRef)) {
    refuse();
  }
}

function endpointPermit(index: number, host: string, port: number, requestScope: string): string {
  const endpoint = `context.input.host == ${JSON.stringify(host)} && context.input.port == ${port}`;
  return `// Installation-approved destination, including its HTTP authorization.
@id("connect_${index}_${port}")
permit (principal, action == Box::Action::"net:connect", resource)
when { ${endpoint} };
@id("request_${index}_${port}")
permit (principal, action == Box::Action::"http:request", resource)
when { ${endpoint}${requestScope} };`;
}

export function responsesRoute() {
  const { host, port, method, path, key } = OPENAI_RESPONSES;
  // Box destinations match path prefixes. Require an exact intercepted
  // request in policy and never union this permit with receiver endpoints.
  const scope = ` && context.input.intercepted && context.input.method == ${JSON.stringify(method)} && context.input.path == ${JSON.stringify(path)}`;
  return {
    policy: endpointPermit(0, host, port, scope),
    egress: `
[egress.model]
destinations = ["${host}:${port}${path}"]
secret.ref = "env://${key}"
secret.inject = "phantom"
`,
  };
}

export function receiverEndpointPermits(network: StrandsBoxOptions["policy"]["network"]): string[] {
  return network.endpoints.flatMap(({ host, ports }, index) =>
    ports.map((port) => endpointPermit(index, host, port, "")),
  );
}

export const STOCK_RESPONSES_POLICY = workspacePolicy(
  [responsesRoute().policy],
  "/home/node/workspace",
);

export function workspacePolicy(permits: readonly string[], workspace: string): string {
  const shellWorkspace = workspace.replace(/^\/home\/node(?=\/)/u, "~");
  return [
    ...permits,
    '@id("workspace_shell")\npermit (principal, action == Box::Action::"shell:exec", resource);',
    `@id("workspace_files")\npermit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write", Box::Action::"fs:delete"], resource)\nwhen { context.input.path == ${JSON.stringify(shellWorkspace)} || context.input.path like ${JSON.stringify(`${shellWorkspace}/*`)} };`,
    '@id("dev_null")\npermit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)\nwhen { context.input.path == "/dev/null" };',
  ].join("\n");
}
