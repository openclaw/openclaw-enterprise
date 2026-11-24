import assert from "node:assert/strict";
import type { verifyDedicatedCodexStartup } from "./sandbox-driver-native-harness-assertions.ts";

type DedicatedCodexStartup = Awaited<ReturnType<typeof verifyDedicatedCodexStartup>>;
type DedicatedCodexProviderFiles = Pick<
  DedicatedCodexStartup,
  "gatewayClient" | "runtimeManifest" | "codexConfig" | "nodeSetup"
> & { runtimeProvider: string };

export function verifyDedicatedCodexProviderFiles({
  gatewayClient,
  runtimeProvider,
  runtimeManifest,
  codexConfig,
  nodeSetup,
}: DedicatedCodexProviderFiles): void {
  const provider = gatewayClient.providers.get(runtimeProvider);
  assert.ok(provider);
  assert.deepEqual(provider.config, {
    runtime_json: runtimeManifest,
    config_toml: codexConfig,
    node_ca_pem: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
    node_setup_json: JSON.stringify({
      url: nodeSetup.url,
      bootstrapToken: nodeSetup.bootstrapToken,
      expiresAtMs: nodeSetup.expiresAtMs,
      tlsFingerprint: nodeSetup.tlsFingerprint,
    }),
  });
  const providerCreate = gatewayClient.calls.find(([operation]) => operation === "createProvider");
  assert.ok(providerCreate?.[0] === "createProvider");
  assert.deepEqual(providerCreate[1].credentials, {});
  assert.deepEqual(providerCreate[1].credentialExpirationTimes, {});
  const runtimeProfile = gatewayClient.profiles.get("oce-codex-runtime")?.profile;
  assert.ok(runtimeProfile);
  assert.ok(runtimeProfile.annotations);
  // One annotation identifies the owner and the managed content.
  assert.deepEqual(Object.keys(runtimeProfile.annotations), ["openclaw.dev/managed-by"]);
  const managedBy = runtimeProfile.annotations["openclaw.dev/managed-by"];
  assert.ok(managedBy);
  assert.match(managedBy, /^openclaw-enterprise:[a-f0-9]{64}$/);
  assert.deepEqual(runtimeProfile.files, [
    {
      path: "runtime.json",
      content: "{{config.runtime_json}}",
      environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    },
    {
      path: "config.toml",
      content: "{{config.config_toml}}",
      environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
    },
    {
      path: "node-setup.json",
      content: "{{config.node_setup_json}}",
      environmentVariable: "OPENCLAW_NODE_SETUP_ENVELOPE",
    },
    {
      path: "node-ca.pem",
      content: "{{config.node_ca_pem}}",
      environmentVariable: "OPENCLAW_NODE_CA_PATH",
    },
  ]);
}
