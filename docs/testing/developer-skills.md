# Developer skills

## Overview

Find the developer skill for your task and check how it is maintained.

## Choose a skill

| Task                            | Skill                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Design review                   | [design-review](../../.agents/skills/design-review/SKILL.md)                         |
| RFC or implementation plan      | [spec](../../.agents/skills/spec/SKILL.md)                                           |
| Development and PR readiness    | [local-dev](../../.agents/skills/local-dev/SKILL.md)                                 |
| Console pages and components    | [console-ui](../../.agents/skills/console-ui/SKILL.md)                               |
| Pull request walkthrough video  | [pr-walkthrough](../../.agents/skills/pr-walkthrough/SKILL.md)                       |
| Documentation                   | [technical-writing](../../.agents/skills/technical-writing/SKILL.md)                 |
| Test quality                    | [test-audit](../../.agents/skills/test-audit/SKILL.md)                               |
| Test selection and CI diagnosis | [enterprise-testing](../../.agents/skills/enterprise-testing/SKILL.md)               |
| Acceptance scenarios            | [oceinteg](../../.agents/skills/oceinteg/SKILL.md), only when explicitly invoked     |
| Maintenance recipes             | [oce-cookbook](../../.agents/skills/oce-cookbook/SKILL.md), explicit invocation only |
| Diagrams                        | [mermaid-diagrams](../../.agents/skills/mermaid-diagrams/SKILL.md)                   |
| Behavior-neutral cleanup        | [deslop](../../.agents/skills/deslop/SKILL.md)                                       |
| Requested independent review    | [autoreview](autoreview.md)                                                          |

Default image-version changes require [native image verification](../../.agents/skills/local-dev/references/image-version-verification.md)
before merge and authorized publication from main. Autoreview uses a shared
installation; the other skills are checked into `.agents/skills`.

## Provenance and updates

- `spec` adapts Specy 2.0.0's `references/feature-spec/workflow.md`,
  `template.md`, and `effective-planning.md`, inspected 2026-09-30. Repository policy replaces
  personal tooling and automatic archiving. Update its workflow and templates
  together; the [specification process](../contributing/specifications.md) owns
  document lifecycle.
- `local-dev` adapts Specy 2.0.0's `references/flow-doc/workflow.md`,
  `template.md`, and `scripts/validate_flow_doc.py`, inspected 2026-09-16. It uses repository paths and a bundled standard-library
  validator. Update these resources together; the validator checks structure,
  not source accuracy or Mermaid syntax.
- `technical-writing` adapts Docy's core, developer-docs, concise-instructions,
  and spec references, inspected 2026-09-16. It leaves repository policy in
  `AGENTS.md`. Update its skill and specification reference together.
- `console-ui`, `pr-walkthrough`, `design-review`, `mermaid-diagrams`, and `oce-cookbook` are maintained here. Check their linked
  guidance and validate changed workflows with an example of one supported task.

The three adapted skills below use `openclaw/openclaw` commit
`4490500902033a1673aed8f42299c232d4b5696f`; the source files match audit
snapshot `083b498270124a059db70714b5df93d973391ee0`. The upstream
[MIT license](../../.agents/skills/LICENSE.openclaw) is retained.

| Upstream                                                                                                                                        | Enterprise adaptation                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [test-audit](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/test-audit/SKILL.md)             | Uses Enterprise test and runtime guides; retains authoring gates and deletion evidence.                                                |
| [deslop](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/deslop/SKILL.md)                     | Keeps behavior-neutral cleanup, fail-closed checks, deferred-work TODOs, and integration-test intent comments; omits the Oxlint claim. |
| [openclaw-testing](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/openclaw-testing/SKILL.md) | Renamed `enterprise-testing`; uses Enterprise commands and CI evidence.                                                                |

Compare upstream changes with the pinned sources before updating adaptations;
do not overwrite them by directory sync. Check skill metadata, links, commands,
and examples. See [autoreview provenance](autoreview.md#upstream-provenance)
for its separate upstream and update procedure.
