# Review changes with autoreview

For test audits, proof selection, and cleanup before review, see
[Developer skills](developer-skills.md).

When the user or owning workflow requests independent developer review, read the
[vendored skill](../../.agents/skills/autoreview/SKILL.md), then run from the
Enterprise repository root:

```sh
.agents/skills/autoreview/scripts/autoreview --mode local --model codex=gpt-6-astra
```

The helper requires Python 3 and an installed, authenticated reviewer CLI (Codex
by default). Image review and the helper test suite also require Pillow. Pass `--model codex=gpt-6-astra` to select the Enterprise standard;
the unchanged upstream helper has its own default when the option is omitted. It
needs no Enterprise runtime or pnpm dependencies. For a committed branch in a
fork checkout, use `--mode branch --base upstream/main` when `upstream` points
to `openclaw/openclaw-enterprise`. Verify the remote URL and fetch the intended
base first; use the actual target branch for an existing or dependent PR.
Pass `--base` explicitly: the helper's `origin/main` default may refer to the
fork rather than the upstream base. Follow the
[fork PR policy](../../CONTRIBUTING.md#prepare-a-pull-request) without renaming
existing remotes.
Local mode includes untracked files and staged and unstaged changes. The default
threshold is P0; pass `--max-priority P2` when that broader scope is requested.

Use `--dry-run` to verify preparation without contacting a reviewer. If a CLI,
authentication, or isolation prerequisite is missing, resolve the reported error;
do not bypass isolation or interpret an absent report as clean. Keep report paths
outside the repository. Verify findings against the change before applying them.
This workflow reviews developer changes; it does not configure runtime approvals.
See the skill for engines, context inputs, exit codes, and result interpretation.

## Upstream provenance

The complete `.agents/skills/autoreview` directory is copied without modification
from [openclaw/agent-skills, `skills/autoreview`](https://github.com/openclaw/agent-skills/tree/6480f6ab50a2a54dce1cfbd33e93b35a7fcd0b81/skills/autoreview)
at commit `6480f6ab50a2a54dce1cfbd33e93b35a7fcd0b81`.
The selected commit is on the canonical `agent-skills` main branch.
The upstream [MIT license](../../.agents/skills/LICENSE.agent-skills) is retained
beside the copy. Preserve scripts, tests, fixtures, and executable modes together.

## Sync the skill

Make shared changes in the canonical repository first. Fast-forward a clean
`openclaw/agent-skills` checkout from `origin/main`, validate the change there,
and record the selected commit. Do not introduce Enterprise-specific behavior
inside the vendored directory; keep repository guidance on this page.

From the Enterprise root, export the selected committed directory into a temporary
directory, using an absolute path to the canonical checkout:

```sh
(
set -eu
upstream_checkout=/absolute/path/to/agent-skills
upstream_commit=$(git -C "$upstream_checkout" rev-parse HEAD)
sync_dir=$(mktemp -d)
git -C "$upstream_checkout" archive "$upstream_commit" skills/autoreview LICENSE > "$sync_dir/archive.tar"
tar -xf "$sync_dir/archive.tar" -C "$sync_dir"
rsync -a --delete "$sync_dir/skills/autoreview/" .agents/skills/autoreview/
cp "$sync_dir/LICENSE" .agents/skills/LICENSE.agent-skills
diff -r "$sync_dir/skills/autoreview" .agents/skills/autoreview
)
```

`rsync --delete` removes downstream-only files inside the vendored skill. Check
for local changes before running it. Update the provenance commit and link above,
then validate from the Enterprise root:

```sh
(
set -eu
PYTHONDONTWRITEBYTECODE=1 python3 .agents/skills/autoreview/scripts/autoreview_test.py
(
  cd .agents/skills/autoreview
  PYTHONDONTWRITEBYTECODE=1 python3 - <<'PYTEST'
import sys
import types
import unittest
from pathlib import Path

# Load the checked-in namespace even if site-packages contains another tests package.
package = types.ModuleType("tests")
package.__path__ = [str(Path("tests").resolve())]
sys.modules["tests"] = package
modules = [f"tests.{path.stem}" for path in sorted(Path("tests").glob("test_*.py"))]
if not modules:
    raise SystemExit("No autoreview test modules found")
result = unittest.TextTestRunner(verbosity=2).run(
    unittest.defaultTestLoader.loadTestsFromNames(modules)
)
if result.testsRun <= len(result.skipped):
    raise SystemExit("No autoreview tests completed without being skipped")
raise SystemExit(not result.wasSuccessful())
PYTEST
)
pnpm check:workspace
pnpm docs:check-length
pnpm format:check
git diff --check
)
```

Run documentation and formatting checks with their existing installed dependencies;
do not install dependencies as a verification side effect. Review the complete
diff, including deletions and file modes, before committing the sync.
