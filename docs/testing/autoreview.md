# Review changes with autoreview

## Overview

Use autoreview to get an independent review of local changes or a committed branch.

## Run a review

When independent review is requested, follow the [shared skill setup](../../.agents/skills/autoreview/SKILL.md)
and read the installed skill. From the repository root:

```sh
python3 "$HOME/.agents/skills/autoreview/scripts/autoreview" --mode local --model codex=gpt-6-astra
```

The helper requires Python 3.10+ and an authenticated reviewer CLI; image
review also requires Pillow. Local mode includes untracked, staged, and unstaged
changes. Use `--dry-run` to check preparation and `--max-priority P2` when that
scope is requested; the default threshold is P0.

For a committed branch, use `--mode branch --base upstream/main` only after
verifying and fetching the intended upstream. For an existing or dependent PR,
select its actual target branch. Pass `--base` explicitly: the default
`origin/main` can point to a fork. Verify findings before applying them, keep
reports outside the repository, and do not bypass isolation or treat an absent
report as clean. See the installed skill for options and results.

## Upstream provenance

[openclaw/agent-skills](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview)
owns the implementation, instructions, and tests. Enterprise keeps a Markdown
entrypoint and the upstream [MIT license](../../.agents/skills/LICENSE.agent-skills).

## Sync the skill

Contribute and validate shared changes upstream first. After active reviews
finish, update the shared checkout. Copy-mode installations need reinstalling:
`python3 scripts/install-skills --mode copy --force autoreview`. Review runs do
not update code. If the entrypoint changes, copy upstream's
`skills/autoreview/references/repository-entrypoint.md` to
`.agents/skills/autoreview/SKILL.md`. Do not restore local helper or test copies.
