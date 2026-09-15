---
name: mermaid-diagrams
description: Create or refine readable Mermaid diagrams for changes, architecture, lifecycles, and dependencies in Markdown documents and PR descriptions.
---

# Mermaid diagrams

Use a diagram when relationships, phases, or boundaries are easier to understand
visually. Keep the surrounding explanation short. A simple edit or single fact
usually needs only prose.

## Establish the meaning

- Check the relevant implementation or design before drawing. State whether the
  diagram describes current behavior, a proposal, or a before/after comparison.
- Show the important relationships and major boundaries, not every function.
  Name subgraphs for the phases or boundaries they explain.
- Use solid arrows for implemented connections and dashed arrows for pending or
  unconnected integration. Label arrows with short verbs or conditions. Express
  asynchronous behavior in words rather than repurposing dashed arrows.
- Make blockers, missing connections, and out-of-scope work explicit. A proposed
  connection stays dashed even when its components already exist.
- Match claims to the evidence: implemented source does not by itself prove a
  working deployment. If that distinction matters, include it in the diagram or
  its caption. Do not infer a completed path from neighboring components.

## Draw compactly

Use a native Markdown `mermaid` code block. Prefer `flowchart TB`; choose another
diagram type when it better explains the relationship, such as sequence order.
Keep any alternate notation's meaning clear in the caption.

For flowcharts, start from the
[flowchart template](references/flowchart-template.md). Its sample behavior is
illustrative; replace its nodes and connections with the actual subject.

- Enable `htmlLabels: true` in Mermaid's YAML frontmatter.
- Give nodes short bold headings with `<b>...</b>` and separate supporting lines
  with `<br/>`. Aim for roughly 15–25 characters per line and 2–3 lines per node
  where practical. Preserve precise names when shortening would obscure meaning.
- Avoid long single-line labels, fixed-width HTML containers, complex inline CSS,
  and excessive text. Split an overfull diagram into focused views.
- Use muted, desaturated fills with dark labels and thin borders; start with
  1px strokes. Keep phase outlines neutral so they do not compete with the nodes.
  Define reusable `classDef` styles and reinforce color with words and line styles.
- Start with 14–16px text and balanced spacing. Set `subGraphTitleMargin`
  separately from node `padding` so phase headings have room above their nodes.
  Tune `nodeSpacing` and `rankSpacing` rather than adding empty label lines.
- Align parallel phases when practical. An extra hyphen on an existing solid
  arrow (`--->`) can span another layout rank without adding a relationship.
  Keep its meaning and endpoints unchanged; avoid inventing edges to force layout.

| Color                     | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| Blue                      | APIs, configuration, persisted state                       |
| Purple                    | Operator inputs, secrets, external dependencies            |
| Teal                      | Processing, protected operations, implemented capabilities |
| Amber                     | Gates, blockers, conditions requiring attention            |
| Gray with a dashed border | Pending or out-of-scope integration                        |

## Verify and report

Check that every edge reflects the relevant evidence and that labels distinguish
implemented behavior from pending work. Keep confidential details out of diagrams
destined for a public document or PR, just as in the surrounding text.

When available, render at the intended document width and inspect label contrast,
phase-title clearance, node padding, large empty areas, and confusing crossings.
Compare before/after views at the same viewport; a narrower SVG may be enlarged
by its viewer. Prefer the destination's renderer; local rendering can differ
from the published result. Adjust labels or layout when needed.

Report validation precisely: reviewing source text, passing a Mermaid syntax
check, and visually inspecting a rendered diagram are separate checks. If
rendering is unavailable, say so; do not describe the diagram as visually
verified. Diagram checks do not establish runtime behavior.
