// Prepare generated configuration; apply with Helm afterward.
// Remove direct GitHub access to prevent bypassing protected Git authorization.
// Select plugin artifacts/catalog without enabling plugins.
// Expects generated inputs; writes are not atomic.

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
assert.equal(process.argv.length, 2);
assert.ok(!drivers.credential_proxy, "Use the default Gateway profile for this quickstart.");
// Remove only the generated rule that bypasses inspection for GitHub Git.
const rule = policy.networkPolicies.find((r) => r.name === "source-control");
assert.deepEqual(rule, {
  name: "source-control",
  binaries: [{ path: "/usr/bin/git" }],
  endpoints: [{ host: "github.com", ports: [443], tls: "skip" }],
});
policy.networkPolicies = policy.networkPolicies.filter((r) => r !== rule);

// Model and Linear access stay on the Gateway. The repository binding supplies native Git.
drivers.plugin.find((entry) => entry.id === "codex-plugin").configuration.catalogSource =
  "openai-curated";
// Save the proposed file for the operator session’s Installation update.
writeFileSync(file, dumpYaml(config), { mode: 0o600 });
