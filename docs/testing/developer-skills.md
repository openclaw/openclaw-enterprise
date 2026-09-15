# Developer skills

Use the repository-local skills for the relevant development task:

| Task                             | Skill                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write or audit tests             | [test-audit](../../.agents/skills/test-audit/SKILL.md) checks observable behavior, credible regressions, distinct coverage, and production seams.              |
| Choose validation or diagnose CI | [enterprise-testing](../../.agents/skills/enterprise-testing/SKILL.md) routes to the existing testing procedures and exact run/job evidence.                   |
| Explain a change with a diagram  | [mermaid-diagrams](../../.agents/skills/mermaid-diagrams/SKILL.md) provides a compact Mermaid template, semantic colors, and honest implementation boundaries. |
| Clean the current diff           | [deslop](../../.agents/skills/deslop/SKILL.md) permits only behavior-neutral cleanup before independent review.                                                |
| Run requested independent review | [autoreview](autoreview.md) owns the reviewer CLI, isolation, and result interpretation.                                                                       |

These skills are checked into `.agents/skills`; no global installation is needed.
Testing setup and real-runtime requirements remain owned by the
[testing guides](README.md). Each skill describes its scope and prerequisites.

## Provenance and updates

`mermaid-diagrams` is maintained in this repository. Update its instructions and
template together; check source accuracy and inspect a rendered example when
possible. Report syntax checks and visual inspection separately.

The three adapted skills originate from `openclaw/openclaw` at commit
`4490500902033a1673aed8f42299c232d4b5696f`. Their source `SKILL.md` files are
identical to the audit snapshot at `083b498270124a059db70714b5df93d973391ee0`.
The upstream [MIT license](../../.agents/skills/LICENSE.openclaw) is retained.

| Upstream source                                                                                                                                 | Intentional Enterprise adaptation                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [test-audit](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/test-audit/SKILL.md)             | Retains the four authoring gates and evidence required before deletion. Uses Node conformance/integration tests and Enterprise database/runtime guides; removes OpenClaw wrappers, remote infrastructure, and PR tooling. Independent review follows the requested workflow. |
| [deslop](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/deslop/SKILL.md)                     | Preserves diff-only, behavior-neutral cleanup before review. Omits the Oxlint claim and explicitly retains fail-closed checks, deferred-work TODOs, and integration-test intent comments.                                                                                    |
| [openclaw-testing](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/openclaw-testing/SKILL.md) | Renamed `enterprise-testing`; replaces commands and specialized routes with Enterprise guides. Retains proportional proof and exact CI diagnosis without importing OpenClaw release, package, or remote infrastructure.                                                      |

Update adaptations by comparing the pinned upstream files with a newly selected
commit, then applying relevant changes against current Enterprise commands and
instructions. Update this table and commit together. Do not overwrite them with
an upstream directory sync. Check skill frontmatter, local links, named commands,
and the [documentation checks](local.md); review example tasks against the test
integrity and runtime boundaries before publishing.

Autoreview has a separate canonical source and must remain an unmodified complete
copy; follow its [provenance and sync procedure](autoreview.md#upstream-provenance).
