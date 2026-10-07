# Developer skills

Use the repository-local skills for the relevant development task:

| Task                                | Skill                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assess a design or refactor         | [design-review](../../.agents/skills/design-review/SKILL.md) traces callers, interfaces, state ownership, and evidence to recommend scoped improvements.                                                                                                                                                  |
| Draft an RFC or implementation plan | [spec](../../.agents/skills/spec/SKILL.md) routes `rfc` and `plan` requests through the repository's document ownership, numbering, and lifecycle rules.                                                                                                                                                  |
| Develop a repository change         | [local-dev](../../.agents/skills/local-dev/SKILL.md) requires proportional verification and flow docs for non-trivial runtime changes.                                                                                                                                                                    |
| Write or review technical docs      | [technical-writing](../../.agents/skills/technical-writing/SKILL.md) covers source-backed prose, runnable instructions, page selection, and specification clarity.                                                                                                                                        |
| Write or audit tests                | [test-audit](../../.agents/skills/test-audit/SKILL.md) checks observable behavior, credible regressions, distinct coverage, and production seams.                                                                                                                                                         |
| Choose validation or diagnose CI    | [enterprise-testing](../../.agents/skills/enterprise-testing/SKILL.md) routes to the existing testing procedures and exact run/job evidence.                                                                                                                                                              |
| Run optional end-to-end acceptance  | [oceinteg](../../.agents/skills/oceinteg/SKILL.md) runs named acceptance scenarios on EKS/Helm, local k3d/Helm, or Compose OCC with k3d only when the user explicitly invokes `oceinteg <scenario>` or `$oceinteg <scenario>`; never invoke it automatically for development or general testing requests. |
| Explain a change with a diagram     | [mermaid-diagrams](../../.agents/skills/mermaid-diagrams/SKILL.md) provides a compact Mermaid template, semantic colors, and honest implementation boundaries.                                                                                                                                            |
| Clean the current diff              | [deslop](../../.agents/skills/deslop/SKILL.md) permits only behavior-neutral cleanup before independent review.                                                                                                                                                                                           |
| Run requested independent review    | [autoreview](autoreview.md) owns the reviewer CLI, isolation, and result interpretation.                                                                                                                                                                                                                  |

For PR handoff, use local-dev's
[readiness checklist](../../.agents/skills/local-dev/references/pr-readiness.md).
Default image-version changes require its
[native image verification workflow](../../.agents/skills/local-dev/references/image-version-verification.md)
before merge, followed by authorized publication from main.

These skills are checked into `.agents/skills`; no global installation is needed.
Testing setup and real-runtime requirements remain owned by the
[testing guides](README.md). Each skill describes its scope and prerequisites.

## Provenance and updates

`spec` is maintained in this repository. Its plan workflow adapts Specy 2.0.0's
`references/feature-spec/workflow.md`, `template.md`, and `effective-planning.md`,
inspected on 2026-09-30. It retains source-backed contracts, concrete work,
conditional phases, outcome-to-proof mapping, and Manual Notes preservation.
The RFC workflow uses the repository's RFC process and template. The
[specification process](../contributing/specifications.md) owns paths, numbering,
status, and lifecycle. This adaptation replaces automatic archiving, personal
memory/session tools, mandatory external simplification tooling, and fixed line
targets with repository policy. No global Specy installation is needed. Update
the workflows and templates together; check skill metadata, links, and the
document-only checks when changing them.

`design-review` is maintained in this repository. The
[design philosophy](../contributing/design-philosophy.md) owns its rationale;
[Readable code](../contributing/readable-code.md) owns the examples. Keep the skill
focused on the review procedure. When changing it, check those references and
try a bounded review task against real source and callers.

`technical-writing` adapts Docy's `references/core/main.md` (document lifecycle
and universal technical writing), `references/ref/developer-docs.md`,
`references/ref/concise-instructions.md`, and `references/ref/spec.md`, inspected
on 2026-09-16. It retains writing, source-evidence, example, review, and design
clarity rules while leaving repository policy in `AGENTS.md`. It omits the Docy
CLI, personal paths, unrelated coding rules, and framework-specific material.
Update its skill and specification reference together; verify local links,
frontmatter, documentation checks, and alignment with repository instructions.
No global Docy installation is required.

`local-dev` is maintained here. Its flow workflow, template, and standalone
Python validator adapt Specy 2.0.0 (`SKILL.md`, `references/flow-doc/workflow.md`,
`references/flow-doc/template.md`, and `scripts/validate_flow_doc.py`), inspected
on 2026-09-16. The adaptation replaces personal memory/session/diagram tooling
with repository paths, host-provided provenance, local diagram guidance, and a
bundled standard-library validator. No global Specy installation is required.
Update those resources together; exercise the validator against a completed
flow and malformed input, and verify links and the trivial-change exemption.
The validator checks structure, not source accuracy or Mermaid syntax.

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
| [deslop](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/deslop/SKILL.md)                     | Preserves diff-only, behavior-neutral cleanup before review; links the readable-code guide for relevant examples. Omits the Oxlint claim and explicitly retains fail-closed checks, deferred-work TODOs, and integration-test intent comments.                               |
| [openclaw-testing](https://github.com/openclaw/openclaw/blob/4490500902033a1673aed8f42299c232d4b5696f/.agents/skills/openclaw-testing/SKILL.md) | Renamed `enterprise-testing`; replaces commands and specialized routes with Enterprise guides. Retains proportional proof and exact CI diagnosis without importing OpenClaw release, package, or remote infrastructure.                                                      |

Update adaptations by comparing the pinned upstream files with a newly selected
commit, then applying relevant changes against current Enterprise commands and
instructions. Update this table and commit together. Do not overwrite them with
an upstream directory sync. Check skill frontmatter, local links, named commands,
and the [documentation checks](local.md); review example tasks against the test
integrity and runtime boundaries before publishing.

Autoreview has a separate canonical source and must remain an unmodified complete
copy; follow its [provenance and sync procedure](autoreview.md#upstream-provenance).
