import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// Load the YAML dependency from the matching release checkout.
const require = createRequire(process.cwd() + "/apps/controller/package.json");
const { loadYaml, dumpYaml } = require("@kubernetes/client-node");
const file = process.env.OCC_DEVELOPMENT_STATE_DIRECTORY + "/installation.yaml";
const config = loadYaml(readFileSync(file, "utf8"));
const drivers = config.drivers;
const policy = drivers.sandbox.configuration.policy;
const artifactRules = policy.networkPolicies.filter(
  (rule) => rule.name === "codex-plugin-artifacts",
);
assert.equal(
  artifactRules.length,
  1,
  "Load exactly one approved codex-plugin-artifacts rule before editing the Installation.",
);
// Select the supplied plugin rule explicitly; the Sandbox qualifies its authority at admission.
policy.codexArtifactRuleNames = [artifactRules[0].name];
if (process.argv[2] === "--gateway-only-bootstrap") {
  assert.equal(process.argv.length, 5);
  const proxy = drivers.credential_proxy;
  assert.equal(proxy?.id, "egress-openshell-development");
  assert.equal(proxy.configuration.middlewareName, "oce-authority");
  assert.equal(proxy.configuration.authorityScope, "execution");
  const backend = config.backend.find((entry) => entry.id === "openshell");
  assert.equal(backend?.drivers.credential_proxy, proxy.id);
  delete backend.drivers.credential_proxy;
  delete drivers.credential_proxy;

  const gatewayFile = process.argv[3];
  const gateway = JSON.parse(readFileSync(gatewayFile, "utf8"));
  assert.equal(gateway.server.disableTls, false);
  assert.equal(gateway.server.auth.allowUnauthenticatedUsers, false);
  assert.equal(gateway.server.tls.enableMtls, true);
  const middleware = gateway.gatewayConfig["openshell.supervisor.middleware"];
  assert.equal(middleware.length, 1);
  assert.equal(middleware[0].name, "oce-authority");
  gateway.gatewayConfig["openshell.supervisor.middleware"] = [];
  writeFileSync(gatewayFile, JSON.stringify(gateway), { mode: 0o600 });

  // Keep the launcher's final worker upgrade on the same Gateway-only settings.
  const valuesFile = process.env.OCC_DEVELOPMENT_STATE_DIRECTORY + "/helm-values.json";
  const values = JSON.parse(readFileSync(valuesFile, "utf8"));
  values.installation.secretName = process.argv[4];
  values.egressAuthority.enabled = false;
  writeFileSync(valuesFile, JSON.stringify(values), { mode: 0o600 });
} else {
  assert.equal(process.argv.length, 2);
  assert.ok(!drivers.credential_proxy);
}
// Remove only the generated rule that bypasses inspection for GitHub Git.
const rule = policy.networkPolicies.find((r) => r.name === "source-control");
assert.deepEqual(rule, {
  name: "source-control",
  binaries: [{ path: "/usr/bin/git" }],
  endpoints: [{ host: "github.com", ports: [443], tls: "skip" }],
});
policy.networkPolicies = policy.networkPolicies.filter((r) => r !== rule);

// Model and Linear access stay on the Gateway. The repository binding supplies native Git.
drivers.plugin.configuration.catalogSource = "openai-curated";
// Save the file that Helm will load from the new versioned Secret.
writeFileSync(file, dumpYaml(config), { mode: 0o600 });
