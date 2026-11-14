import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import pg from "pg";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mts";

const scenarioDatabaseKeys = {
  openclaw: "OCC_TEST_PLUGIN_DRIVER_OPENCLAW_DATABASE_URL",
  codex_linear: "OCC_TEST_PLUGIN_DRIVER_CODEX_LINEAR_DATABASE_URL",
  codex_failure: "OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_DATABASE_URL",
} as const;

export type PluginProofScenario = keyof typeof scenarioDatabaseKeys;

export type PluginProofInputOptions = {
  scenario: PluginProofScenario;
  pluginDriverId: "occ-plugin" | "codex-plugin";
  databaseUrl?: string | undefined;
};

export const realPluginProofSelected = process.env.OCC_TEST_PLUGIN_DRIVER_REAL === "1";

export function pluginProofSkipReason(scenario: PluginProofScenario): false | string {
  const key = `OCC_TEST_PLUGIN_DRIVER_${scenario.toUpperCase()}_REAL`;
  if (realPluginProofSelected || process.env[key] === "1") {
    return false;
  }
  return `Set ${key}=1 or OCC_TEST_PLUGIN_DRIVER_REAL=1 with disposable k3d/PostgreSQL, immutable real runtime images, model credentials, injected CODEX_ACCESS_TOKEN for Codex proofs, curated plugin proof prompts.`;
}

export function requiredPluginProofEnv(name: string, description = name): string {
  const value = process.env[name];
  assert.ok(value && value.trim().length > 0, `${description} (${name}) is required.`);
  return value;
}

export function optionalPluginProofModel(): string {
  return (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel).replace(
    /^(?:openai|codex)\//,
    "",
  );
}

function readDatabaseEndpoint(key: string) {
  const url = requiredPluginProofEnv(key);
  let client: pg.Client;
  try {
    client = new pg.Client({ connectionString: url });
  } catch {
    assert.fail(`${key} must be a valid PostgreSQL connection URL.`);
  }
  const { host, port, database } = client;
  assert.ok(database, `${key} must name a database.`);
  return { host, port, database };
}

async function requireSeparateDatabases(scenario: PluginProofScenario, databaseUrl?: string) {
  assert.ok(Object.hasOwn(scenarioDatabaseKeys, scenario), "unknown real plugin-driver scenario.");
  const databases = Object.entries(scenarioDatabaseKeys).map(([name, key]) => ({
    name,
    ...readDatabaseEndpoint(key),
  }));
  assert.ok(
    databaseUrl === process.env[scenarioDatabaseKeys[scenario]],
    `${scenario} must use its scenario-specific database URL.`,
  );

  const hasLocalhost = databases.some(({ host }) => host.toLowerCase() === "localhost");
  const hasLoopbackLiteral = databases.some(({ host }) => host === "127.0.0.1" || host === "::1");
  let localhostAddress: string | undefined;
  if (hasLocalhost && hasLoopbackLiteral) {
    // A dual-stack host can run separate servers on the same port. An alias
    // with a single loopback address identifies the same endpoint as that address.
    const addresses = await lookup("localhost", { all: true }).catch(() => []);
    const first = addresses[0];
    if (addresses.length === 1 && (first?.address === "127.0.0.1" || first?.address === "::1")) {
      localhostAddress = first.address;
    }
  }

  const seen = new Map<string, string>();
  for (const { name, host, port, database } of databases) {
    const endpoint = host.toLowerCase() === "localhost" ? (localhostAddress ?? "localhost") : host;
    const identity = JSON.stringify([endpoint, port, database]);
    const first = seen.get(identity);
    assert.ok(
      first === undefined,
      `real plugin-driver scenarios ${first} and ${name} must use separate dedicated databases.`,
    );
    seen.set(identity, name);
  }
}

export async function selectPluginProofInputs({
  scenario,
  pluginDriverId,
  databaseUrl,
}: PluginProofInputOptions) {
  const kubeconfigPath = requiredPluginProofEnv("OCC_TEST_KUBERNETES_KUBECONFIG");
  const kubernetesContext = requiredPluginProofEnv("OCC_TEST_KUBERNETES_CONTEXT");
  const gatewayImage = requiredPluginProofEnv("OCC_TEST_KUBERNETES_GATEWAY_IMAGE");
  const codexImage =
    pluginDriverId === "codex-plugin"
      ? (process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
        requiredPluginProofEnv("OCC_TEST_KUBERNETES_AGENT_IMAGE", "Codex runtime image"))
      : (process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ??
        process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE ??
        gatewayImage);

  if (realPluginProofSelected) {
    await requireSeparateDatabases(scenario, databaseUrl);
  }
  return {
    kubeconfigPath,
    kubernetesContext,
    gatewayImage,
    codexImage,
    databaseUrl: databaseUrl ?? requiredPluginProofEnv("OCC_TEST_DATABASE_URL"),
  };
}
