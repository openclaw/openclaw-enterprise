import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// Load the YAML dependency from the matching release checkout.
const require = createRequire(process.cwd() + "/apps/controller/package.json");
const { loadYaml, dumpYaml } = require("@kubernetes/client-node");
const file = process.env.OCC_DEVELOPMENT_STATE_DIRECTORY + "/installation.yaml";
const config = loadYaml(readFileSync(file, "utf8"));
const drivers = config.drivers;
assert.ok(!drivers.credential_proxy);
const policy = drivers.sandbox.configuration.policy;

// Remove only the generated rule that bypasses inspection for GitHub Git.
const rule = policy.networkPolicies.find((r) => r.name === "source-control");
assert.deepEqual(rule, {
  name: "source-control",
  binaries: [{ path: "/usr/bin/git" }],
  endpoints: [{ host: "github.com", ports: [443], tls: "skip" }],
});
policy.networkPolicies = policy.networkPolicies.filter((r) => r !== rule);

// Keep the model binaries and add native Git as a credential-aware tool.
const gateway = drivers.credential_gateway.configuration;
gateway.toolBinaries = [...new Set([...(gateway.toolBinaries ?? []), "/usr/bin/git"])];
drivers.plugin.configuration.catalogSource = "openai-curated";
// Save the file that Helm will load from the new versioned Secret.
writeFileSync(file, dumpYaml(config), { mode: 0o600 });
