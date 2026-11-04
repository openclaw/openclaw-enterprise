// Select the documented CLI path for a new installation. Require one block per
// step so an edited or duplicated instruction cannot silently skip coverage.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];

function step(file, command) {
  return execFileSync(
    process.execPath,
    ["scripts/ci/k3d-quickstart/guide-bash.mjs", file, command],
    {
      encoding: "utf8",
    },
  );
}

const local = "docs/guides/deploy/local-setup.md";
const agent = "docs/guides/deploy/deploy-first-agent.md";
const before = [
  step(local, './bin/occ dev up --sandbox-network-policy-file "$RUN_DIR/artifacts.yaml"'),
  step(local, 'node "$RUN_DIR/configure-installation.mjs"'),
  step(local, 'secret="oce-openshell-codex-$(date +%s)"'),
  step(local, "PLATFORM=local-k3d"),
  step(agent, "source_type=codex-pat"),
  // The guide uses an example path. The workflow stages the service-account token here.
  'credential_file="${CODEX_TOKEN_FILE:?}"',
  step(agent, 'name="openshell-codex-$(date +%s)"'),
  step(agent, '--rawfile token "$credential_file"'),
  step(agent, 'agent=$(jq -er .data.id "$RUN_DIR/agent")'),
  step(agent, 'cfg=$(jq -er .data.id "$RUN_DIR/configuration")'),
  step(agent, "# Provision transport once, before the first revision."),
  step(agent, "deploy_and_wait"),
  step(agent, "workspace_check -f BOOTSTRAP.md"),
];
const after = [step(agent, "workspace_check ! -e BOOTSTRAP.md"), step(agent, "save_session")];
for (const [file, blocks] of [
  ["setup-before-browser.sh", before],
  ["setup-after-browser.sh", after],
]) {
  writeFileSync(join(root, file), blocks.join("\n"), { mode: 0o600, flag: "wx" });
}
