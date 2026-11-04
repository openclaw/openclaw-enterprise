# Document a CI check

Use the `reference/ci` template for test workflow detail pages under `docs/testing/ci/`. Each page explains one
check from the [CI overview](../testing/ci.md#checks-and-gates): what it verifies,
when its result applies, how to run it, and how to interpret the evidence.

## What each section must answer

| Section            | Reader's question                                       | Include                                                                                                                                 |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Overview           | What does this check prove?                             | Purpose, system under test, and whether dependencies are real, simulated, or mixed.                                                     |
| Trigger            | Will my change run it, and does failure block anything? | Events, path filters, labels, skip conditions, and merge/publication consequences. Link exact workflow policy.                          |
| Scenarios          | What action produces which observable result?           | Setup/action, expected outcome, and source link. Include meaningful failure and authorization cases; group similar cases.               |
| Execution          | How do I reproduce this coverage?                       | One recommended command, prerequisites, credentials/environment links, selection rules, and required isolation.                         |
| Results and limits | What counts as a pass, and what remains unproved?       | Job/artifact names, skip semantics, scope, cleanup/recovery, and limits such as simulated model responses.                              |
| Files              | Where is the source of truth?                           | Workflow, exact manifest, test files, important helpers, and implementation entry points. State when tests run without a lane manifest. |

## Copy the template

Replace each instruction with source-backed content. The template is an
authoring outline, not a runnable command or a page to publish unchanged.

Copy the [reference/ci template](../../.agents/skills/technical-writing/assets/reference-ci.md),
including `kind: reference/ci` in YAML frontmatter. Keep its six sections in
order. Shared configuration and lane-execution guides do not describe individual
checks and do not use this template.

## Name the behavior being tested

Use descriptive coverage labels such as **Runtime image metadata** or
**Worker startup deadline**. Names such as “Fixture” or “Helper Timeout” do not
explain what a reader can learn from the result. State the expected behavior
beside the label, and link to the test or manifest that verifies it.

Preserve exact GitHub job names in a separate column or an explicit mapping so
readers can find the run. For example, **Runtime image metadata** maps to the
`Runtime Image Fixture` job. Do not rename workflow identifiers, selectors,
commands, or API fields while editing prose.

Expand unfamiliar abbreviations and replace noun piles with actions. Prefer
“withdraw access; further reads are denied” to “retirement/isolation.” Keep
established product and resource names, such as Agent revision and OpenShell.

## Keep pages useful

Describe scenarios as **given this setup, perform this action, expect this
outcome**. “Tests deployment” is too broad; “Stop the Agent; its Pods terminate,
then starting it creates a new revision and chat succeeds” is verifiable.

For large checks, group related cases and link exact manifests rather than
copying hundreds of test names. Add columns for presets or automatic selection
when they change coverage. Publication-only workflows, preview builds, cache
maintenance, and security scanning belong in their owning contributor or release
guides, not in this template or the Testing & CI navigation.

Keep the CI index to one-line purposes and links. Check pages own triggers,
scenarios, and workflow-specific results; do not repeat those details in the index.
Keep setup and credentials in their existing suite guide. Link shared
[CI configuration](../testing/ci/configuration.md) and
[cleanup](../testing/ci/run-lanes.md#results-and-cleanup) instead of copying them.
Link the page from the overview table and register it once under **Testing & CI → CI → Tests**.
Preserve old anchors with short pointers when moving existing descriptions.

Keep expected behavior separate from an execution report: a passing PR does not
prove a manual or skipped lane ran. Put per-run commit IDs, timestamps, and
results in PR verification evidence rather than the living check page.

Validate source links, selection, and failure consequences against the workflow
and current tests. Run the [documentation checks](documentation.md#preview-and-check),
then inspect the rendered page and navigation. Do not run runtime tests solely
for this documentation change.
