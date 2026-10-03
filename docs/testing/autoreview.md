# Review changes with autoreview

For test audits, proof selection, and cleanup before review, see
[Developer skills](developer-skills.md).

When the user or owning workflow requests independent developer review, follow
the [shared skill setup](../../.agents/skills/autoreview/SKILL.md) once and read
the complete installed skill. Run from the Enterprise repository root:

```sh
python3 "$HOME/.agents/skills/autoreview/scripts/autoreview" --mode local --model codex=gpt-6-astra
```

Use your selected installation path if it differs from the default. On Windows,
use Python or the installed `scripts/autoreview.ps1` launcher.
The helper requires Python 3.10 or newer and an installed, authenticated reviewer
CLI (Codex by default). Image review also requires Pillow. Pass
`--model codex=gpt-6-astra` to select the Enterprise standard; the shared helper
owns its default when the option is omitted. It needs no Enterprise runtime or
pnpm dependencies. For a committed branch, use `--mode branch --base origin/main`;
fetch the intended base first. Local mode includes untracked files and staged and
unstaged changes. The default threshold is P0; pass `--max-priority P2` when that
broader scope is requested.

Use `--dry-run` to verify preparation without contacting a reviewer. If a CLI,
authentication, or isolation prerequisite is missing, resolve the reported error;
do not bypass isolation or interpret an absent report as clean. Keep report paths
outside the repository. Verify findings against the change before applying them.
This workflow reviews developer changes; it does not configure runtime approvals.
See the installed skill for engines, context inputs, exit codes, and results.

## Upstream provenance

[openclaw/agent-skills](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview)
owns the implementation, instructions, and tests. Enterprise keeps only a Markdown
entrypoint. Repository-specific reviewer choices and validation stay on this page.
The upstream [MIT license](../../.agents/skills/LICENSE.agent-skills) is retained.

## Sync the skill

Contribute shared changes to `openclaw/agent-skills` and validate them there first.
After active reviews finish, update the shared checkout once: symlinked installs
serve that version to every repository. Copy-mode installs need a reinstall with
`python3 scripts/install-skills --mode copy --force autoreview` from the updated
source checkout. Review runs do not download or update code automatically.

Do not restore repository-local helper or test copies. If the entrypoint itself
changes upstream, copy `skills/autoreview/references/repository-entrypoint.md`
to `.agents/skills/autoreview/SKILL.md`. Run the relevant documentation and
formatting checks with existing dependencies and inspect `git diff --check`.
