# Review changes with autoreview

For test audits, proof selection, and cleanup before review, see
[Developer skills](developer-skills.md).

When the user or owning workflow requests independent developer review, read the
[vendored skill](../../.agents/skills/autoreview/SKILL.md), then run from the
Enterprise repository root:

```sh
.agents/skills/autoreview/scripts/autoreview --mode local
```

The helper requires Python 3 and an installed, authenticated reviewer CLI (Codex
by default). It needs no Enterprise runtime or pnpm dependencies. For a committed
branch, use `--mode branch --base origin/main`; fetch the intended base first.
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
from [openclaw/agent-skills, `skills/autoreview`](https://github.com/openclaw/agent-skills/tree/bd9b7cc2c37e7af0915f9becee8f8107aaab27b5/skills/autoreview)
at commit `bd9b7cc2c37e7af0915f9becee8f8107aaab27b5`.
This matches OpenClaw's vendored directory at commit
`0d3f4501fd8e9349ef6651b9d73ff99a11cda074`.
The upstream [MIT license](../../.agents/skills/LICENSE.agent-skills) is retained
beside the copy. Preserve scripts, tests, fixtures, executable modes, and the
`CLAUDE.md` symlink together.

## Sync the skill

Make shared changes in the canonical repository first. Fast-forward a clean
`openclaw/agent-skills` checkout from `origin/main`, validate the change there,
and record the selected commit. Do not introduce Enterprise-specific behavior
inside the vendored directory; keep repository guidance on this page.

From the Enterprise root, export the selected committed directory into a temporary
directory, using an absolute path to the canonical checkout:

```sh
upstream_checkout=/absolute/path/to/agent-skills
upstream_commit=$(git -C "$upstream_checkout" rev-parse HEAD)
sync_dir=$(mktemp -d)
git -C "$upstream_checkout" archive "$upstream_commit" skills/autoreview LICENSE |
  tar -x -C "$sync_dir"
rsync -a --delete "$sync_dir/skills/autoreview/" .agents/skills/autoreview/
cp "$sync_dir/LICENSE" .agents/skills/LICENSE.agent-skills
diff -r "$sync_dir/skills/autoreview" .agents/skills/autoreview
```

`rsync --delete` removes downstream-only files inside the vendored skill. Check
for local changes before running it. Update the provenance commit and link above,
then validate from the Enterprise root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 .agents/skills/autoreview/scripts/autoreview_test.py
(
  cd .agents/skills/autoreview
  PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 python3 -m unittest \
    tests.test_autoreview_hardening tests.test_codex_inference_route \
    tests.test_codex_sandbox
)
pnpm check:workspace
pnpm docs:check-length
pnpm format:check
git diff --check
```

Run documentation and formatting checks with their existing installed dependencies;
do not install dependencies as a verification side effect. Review the complete
diff, including deletions and file modes, before committing the sync.
