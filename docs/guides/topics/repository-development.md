# Develop in an Agent workspace

Prepare the repository's tools and development dependencies before asking an
Agent to change code. A successful Git push proves repository access; it does
not prove that the Agent can build or test the project.

This guide uses a trusted OpenClaw Enterprise checkout in a dedicated Codex
Agent's Linux AMD64 workspace. Other repositories own their tool versions and
validation commands. Follow their contribution instructions instead.

## Before you start

- Use the [protected OpenShell setup](../deploy/kubernetes-setup.md) with a ready
  model CredentialSource, paired Credential Gateway and Sandbox, and an
  [authorized repository binding](../repository-credentials/openshell-git-push.md).
  Confirm an actual model response and ordinary Git/gh access first.
- This workflow selects [public network egress mode](../../reference/configuration/network-egress.md)
  for package downloads, with compatible Gateway/supervisor images that report
  the applied mode. Stock OpenShell 0.1.6 cannot provide it. Select the qualified images through the setup
  guide; changing an Installation setting requires a successor Agent revision.
  Public mode permits workspace data to reach public services. Managed credential
  destinations retain their authorization rules; public mode is not general UDP,
  IPv6 or raw-IP access.
- Keep long-lived credentials in the configured credential services. Use normal
  HTTPS Git and `gh` commands with the provisioned authentication; do not run
  `gh auth login`, copy a personal token into the workspace, or replace managed
  Git authentication. Repository permissions and branch rules still apply.
- Use the configured writable workspace, including the remote workspace path for
  dedicated Codex. Do not assume it is `/home/node/workspace`. Allow space for
  dependencies, tools, caches and build output. Never reuse the packaged
  application's dependency directory as the checkout's development graph.

If the model refuses its required permission profile, follow
[Agent troubleshooting](agent-troubleshoot.md#codex-refuses-the-required-permission-profile)
before proceeding. Successful login alone does not establish that permission.

## Prepare pinned tools

Read the checkout's [contribution instructions](../../../CONTRIBUTING.md),
[`package.json`](../../../package.json) and [`.bun-version`](../../../.bun-version).
This checkout requires Node.js 24.22.1 or newer (26.x requires 26.12.1 or newer),
pnpm 11.15.1 with its complete package-manager integrity pin, and Bun 1.4.4.
The runtime includes Git and gh; Bun and the development dependency graph need
separate preparation. Stop if the checkout's pins differ from this example.

Run the following in the Agent's Bash shell. Set `OCE_WORKSPACE` to its approved
writable workspace and `OCE_REPO` to the trusted checkout within it. Keep the
new tools directory outside the checkout. Use a private `0700` temporary
directory under `/tmp`: protected credential fixtures reject shared writable
ancestors, and short paths also avoid Unix-socket length limits.

```bash
set -euo pipefail
: "${OCE_WORKSPACE:?set the approved workspace path}"
: "${OCE_REPO:?set the trusted checkout path}"
cd "$OCE_REPO"
git rev-parse HEAD
git status --short
node --version
corepack --version
git --version
gh --version
df -h "$OCE_WORKSPACE"
OCE_TOOLS=$(mktemp -d "$OCE_WORKSPACE/oce-devtools.XXXXXXXX")
mkdir -p "$OCE_TOOLS/bin" "$OCE_TOOLS/bun" "$OCE_TOOLS/cache/corepack" \
  "$OCE_TOOLS/cache/npm" "$OCE_TOOLS/cache/pnpm"
export COREPACK_HOME="$OCE_TOOLS/cache/corepack"
export npm_config_cache="$OCE_TOOLS/cache/npm"
TMPDIR=$(mktemp -d /tmp/oce-dev.XXXXXXXX)
chmod 700 "$TMPDIR"
export TMPDIR
export PATH="$OCE_TOOLS/bin:$PATH"
corepack enable --install-directory "$OCE_TOOLS/bin"
test "$(pnpm --version)" = 11.15.1
```

Corepack selects the checkout's pinned pnpm. Preserve signature verification and
registry TLS; do not replace the pin with `latest` or disable certificate checks.
The following installs the original Bun platform package with lifecycle scripts
disabled, then verifies its lock entry before executing the binary. This example
is for **Linux AMD64 with glibc**, as supplied by this runtime:

```bash
test "$(node -p 'process.platform + "/" + process.arch')" = linux/x64
test "$(cat .bun-version)" = 1.4.4
npm install --prefix "$OCE_TOOLS/bun" --ignore-scripts --no-audit --no-fund \
  --save-exact --registry=https://registry.npmjs.org @oven/bun-linux-x64@1.4.4
node --input-type=module - "$OCE_TOOLS/bun/package-lock.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const entry = lock.packages['node_modules/@oven/bun-linux-x64'];
assert.equal(entry.version, '1.4.4');
assert.equal(entry.integrity,
  'sha512-CHbbkmHVM28T1GFq+6GL4Ao4ujwwYwj1CxFFwEFzLanPfNsId9AhbIP0Q4reWuWBkGimUkoQygrK7Rgjtj3vog==');
assert.equal(entry.resolved,
  'https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.4.tgz');
JS
ln -s "$OCE_TOOLS/bun/node_modules/@oven/bun-linux-x64/bin/bun" "$OCE_TOOLS/bin/bun"
test "$(bun --version)" = 1.4.4
bun --revision
```

On another architecture, provision its matching pinned tool package rather than
running this AMD64 example. A registry URL does not grant network access; stop
and inspect the Agent's network policy if a download is denied.

## Install and check the development graph

Continue in the same shell and checkout. The runtime sets `NODE_ENV=production`,
so explicitly include development dependencies:

```bash
NODE_ENV=development pnpm install --frozen-lockfile --prod=false \
  --store-dir "$OCE_TOOLS/cache/pnpm"
NODE_ENV=development pnpm check:workspace
NODE_ENV=development pnpm format:check
NODE_ENV=development pnpm lint
NODE_ENV=development pnpm typecheck
git status --short
```

Require each command to exit successfully. Preserve the frozen lockfile,
[dependency release waiting period](../../../CONTRIBUTING.md#dependency-release-waiting-period)
and dependency-build policy. Do not add `--ignore-scripts` to this repository
install: permitted dependency builds and managed Git-hook preparation are part
of setup. Investigate an unmanaged-hook conflict instead of overwriting it.
Do not reconcile dependencies while another job uses the checkout.

Run only the verification required for the change, following the
[testing prerequisites](../../testing/README.md#requirements-and-credentials).
Helm, Go, browser, PostgreSQL, Docker and Kubernetes checks need their own tools
or infrastructure. Documentation changes need formatting and the separately
prepared [docs package checks](../../contributing/documentation.md), not runtime
tests. A skipped case is not a pass, and these setup commands do not qualify the
full test suite inside the Sandbox.

Keep logs and exit statuses, then remove only the private temporary directory
you created after all checks finish. Tests using local UDP listeners can also
be incompatible with Sandbox network enforcement; public TCP downloads do not establish UDP fixture support.
Report that limitation and run those checks in the supported contributor test
environment. Do not weaken the Sandbox or label an incomplete suite successful.

## Review and publish the work

Review the diff and unexpected manifest or lockfile changes. Report the exact
source revision, checks that passed, failures and missing prerequisites. Then
use normal `git commit`, `git push` and `gh pr create` within the task's
authorization. Verify the remote commit and PR. If publication has an uncertain
outcome, inspect it before retrying. The repository's review and merge policy
continues to apply.
