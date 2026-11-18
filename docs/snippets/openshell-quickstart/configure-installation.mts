// Prepare generated configuration for the subsequent Helm reload.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Load the controller's YAML codec from the matching release checkout.
type YamlCodec = Pick<typeof import("@kubernetes/client-node"), "loadYaml" | "dumpYaml">;
const requireController: (id: "@kubernetes/client-node") => YamlCodec = createRequire(
  join(process.cwd(), "apps/controller/package.json"),
);
const yaml = requireController("@kubernetes/client-node");
const dumpYaml: (value: Record<string, unknown>) => string = yaml.dumpYaml;

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  const entries: readonly unknown[] = value;
  return entries.map(record);
}

const directory = process.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
assert.ok(directory, "Set OCC_DEVELOPMENT_STATE_DIRECTORY to the quickstart state directory.");
const file = join(directory, "installation.yaml");
const config = record(yaml.loadYaml<unknown>(readFileSync(file, "utf8")));
const drivers = record(config.drivers);
const sandbox = record(drivers.sandbox);
const policy = record(record(sandbox.configuration).policy);
const networkPolicies = records(policy.networkPolicies);
const artifactRuleName = "codex-plugin-artifacts";
const artifactRules = networkPolicies.filter((rule) => rule.name === artifactRuleName);
assert.equal(
  artifactRules.length,
  1,
  "Load exactly one approved codex-plugin-artifacts rule before editing the Installation.",
);
assert.equal(process.argv.length, 2);
assert.ok(!drivers.credential_proxy, "Use the default Gateway profile for this quickstart.");

// Remove only the generated rule that bypasses inspection for GitHub Git.
const sourceControl = networkPolicies.find((rule) => rule.name === "source-control");
assert.deepEqual(sourceControl, {
  name: "source-control",
  binaries: [{ path: "/usr/bin/git" }],
  endpoints: [{ host: "github.com", ports: [443], tls: "skip" }],
});
const plugin = records(drivers.plugin).find((entry) => entry.id === "codex-plugin");
assert.ok(plugin, "The generated Installation must define the codex-plugin Driver.");

// The Sandbox qualifies the selected artifact rule at admission. Git uses a repository binding.
policy.codexArtifactRuleNames = [artifactRuleName];
policy.networkPolicies = networkPolicies.filter((rule) => rule !== sourceControl);
writeFileSync(file, dumpYaml(config), { mode: 0o600 });
