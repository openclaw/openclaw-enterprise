import type { SandboxHarnessContext } from "@openclaw-enterprise/contracts";
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
import { savedModelProvider } from "../compute/model-provider.ts";

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
  return (
    typeof launcher?.namespace === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(launcher.namespace) &&
    launcher.namespace !== options.kubernetes.controlPlanePeer?.namespace &&
    Object.keys(launcher).length === 1 &&
    options.kubernetes.seccompProfile === `${STOCK_BOX_PROFILE}.json` &&
    isDeepStrictEqual(options.policy, {
      network: { endpoints: [{ host: OPENAI_RESPONSES.host, ports: [OPENAI_RESPONSES.port] }] },
    })
  );
}

export function stockModelKey(
  { namespace, requirements, revision }: SandboxHarnessContext,
  options: StrandsBoxOptions,
): { name: string; key: string } | undefined {
  if (options.kubernetes.stockLauncher === undefined) {
    return undefined;
  }
  if (
    !validStockConfiguration(options) ||
    options.kubernetes.stockLauncher.namespace !== namespace.name ||
    revision.namespaceId !== namespace.id ||
    revision.credentialDeployment !== undefined ||
    revision.repositoryCredentials !== undefined ||
    revision.sandboxPolicy !== undefined ||
    requirements.loginMode !== "api_key" ||
    revision.harness.id !== "codex" ||
    revision.harness.mode !== "dedicated" ||
    revision.harnessAuth.method !== "api_key" ||
    revision.executionAdmission.mode !== "unprotected" ||
    revision.egressPlan !== undefined ||
    requirements.proxyWiring !== undefined ||
    requirements.workloadIdentity !== undefined
  ) {
    refuse();
  }

  requireResponsesRuntime(revision, requirements);
  return preparedModelKey(requirements);
}

function requireResponsesRuntime(
  revision: SandboxHarnessContext["revision"],
  requirements: SandboxHarnessContext["requirements"],
): void {
  // Admit the ordinary Compute-generated HTTPS provider. An arbitrary TOML file
  // or another endpoint could direct Codex away from this model route.
  const provider = savedModelProvider(revision.harness.configuration);
  if (
    provider?.baseUrl !== "https://api.openai.com/v1" ||
    provider.protocol !== "openai-responses" ||
    provider.supportsStandaloneWebSearch
  ) {
    refuse();
  }
  const runtime = pluginRuntimeSpecForRevision(revision, undefined, provider.baseUrl);
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
  const aliasesModelKey = (other: { name: string; key: string }) =>
    other.name === reference.name && other.key === reference.key;

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
  return { name: reference.name, key: reference.key };
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
