# Documentation clarity audit — September 29, 2026

This audit records 14 clarity and organization findings from baseline
`2d251975fba5b05bd83e96f95ee89c2c67635d50`. They were addressed in
[PR #615](https://github.com/openclaw/openclaw-enterprise/pull/615).
The findings and line numbers below describe that baseline; relative links open
the current documentation. The [earlier inventory](../documentation-inventory.md)
retains the preceding audit and proposals.

## Resolution

Source review at `6918a47ba60965e231dcb2ce1ec1d813eea36d06` confirmed these
changes. This is documentation review, not runtime verification.

| Findings     | Published correction                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01–D02      | [Published-image selection](../guides/deploy/published-images.md) replaces the historical example; [prerequisites](../guides/kubernetes-setup.md#before-you-start) name Bash and Node.                                                                                |
| D03          | [Compute choices](../guides/topics/agent-compute.md#choose-an-execution-mode) and [Harness topology](../reference/harness-execution.md#supported-topology) mark dedicated native OpenClaw experimental.                                                               |
| D04, D06     | [Local setup](../guides/quickstart.md) puts optional tasks after first setup; [production deployment](../guides/deploy/production-agents.md) links separate TUI and native-admin procedures.                                                                          |
| D05, D13     | [Production deployment](../guides/deploy/production-agents.md) uses the UI label and spells out control-plane Secrets; [repository setup](../guides/repository-credentials.md) names the exact principal grant.                                                       |
| D07–D08, D12 | [Standalone service operation](../guides/repository-credentials/standalone-service.md) has its own guide; [Integrations](../guides/integrations/README.md) links repository access; [managed setup](../guides/repository-credentials.md) explains discovery failures. |
| D09–D11      | The [home page](../README.md) keeps section entry points; navigation labels the earlier audit **Historical Inventory**; [CLI setup](../guides/cli.md) links separate tasks.                                                                                           |
| D14          | [Model verification](../guides/operate/model-verification.md#what-each-check-establishes) defines the evidence levels, and setup guides link to it.                                                                                                                   |

## Scope and priorities

The review focused on entry points, local and production setup, first-Agent
deployment, CLI usage, compute and Harness choices, repository access, and their
supporting references. Navigation and local links were checked across the site.
This is a focused editorial audit, not a line-by-line review of all pages or a
fresh qualification of every supported integration.

- **P1 — resolve before relying on the affected instructions:** missing tools,
  unclear viable setup paths, or misleading support presentation.
- **P2 — improve task completion:** misplaced workflows, inconsistent labels,
  missing navigation, or unclear ownership.
- **P3 — polish:** repetition and unnecessarily dense language.

Each item includes the smallest useful correction. Priorities describe reader
impact, not product defects.

## Baseline P1: setup and support clarity

### D01. The published-image path centers on an unusable historical pair

**Evidence:** [Production installation: published images](../guides/deploy/production-installation.md#use-published-images),
lines 19–45; [local setup: published images](../guides/quickstart.md#optional-use-matching-published-images),
lines 37–58.

The production guide correctly warns that its concrete image pair predates the
current configuration, but that pair is still the only copyable digest example
in the published-image section. Local setup links there while warning that the
images do not match. A reader choosing published images reaches historical
evidence instead of a usable selection procedure.

**Correction:** lead with how to select a matching current image/chart/source
set, or direct the reader immediately to the source-build path when no qualified
pair is supplied. Move historical digests and their proof to the publication
record. Preserve provenance requirements.

### D02. Production prerequisites omit tools used later in the workflow

**Evidence:** [Kubernetes prerequisites](../guides/kubernetes-setup.md#before-you-start),
lines 10–17; [profile generation](../guides/deploy/production-installation.md#recommended-generate-profile-configuration),
line 136; [transport provisioning](../guides/deploy/production-agents.md#prepare-transport-credentials-and-deploy),
line 368; [TUI attachment](../guides/deploy/production-agents.md#attach-with-the-openclaw-tui),
line 473.

The initial tool list omits Node and Bash. Node is introduced as a profile-rendering
requirement, but the later API-client transport example also invokes Node, even
after manual YAML setup. The TUI procedure requires Bash syntax. Readers learn
these requirements after committing to a setup path.

**Correction:** list tools by branch up front: Node for profile generation and
the Node-based transport example, Bash for TUI verification. State the alternative
when using console credential provisioning or another verification path.

### D03. Dedicated native OpenClaw looks like an ordinary supported choice

**Evidence:** [Compute execution modes](../guides/topics/agent-compute.md#choose-an-execution-mode),
lines 10–15, versus its later Driver table; [Harness supported topology](../reference/harness-execution.md#supported-topology),
lines 13–19, versus [sandbox provisioning](../reference/harness-execution.md#optional-sandbox-provisioning).

The opening choice tables include a dedicated native OpenClaw worker without an
in-row qualification. Later text requires a full-facet provisioning SandboxDriver
and describes stock OpenShell blockers. The limits are present, but a reader
scanning the choice table can mistake a conditional contract for a usable bundled
deployment path.

**Correction:** add a support-status column or qualify the native-worker row
directly. Separate currently usable bundled paths from conditional integrations;
keep the detailed contract in the Harness reference.

## Baseline P2: task flow, ownership, and labels

### D04. Optional work interrupts the local first-success path

**Evidence:** [Local setup](../guides/quickstart.md), lines 13–60 and 103–157.

Workspace caveats and optional published images precede startup. A four-step native
admin workflow then precedes service-key setup and the handoff to the first Agent.
That workflow needs a separate console-managed Agent; the first-Agent helper
creates an Agent with native UI disabled. Readers encounter two creation paths
before finishing either one.

**Correction:** order the main path as prerequisites, startup, authentication,
Namespace readiness, first Agent. Move image selection and native admin access
behind short optional links. Keep cleanup visible.

### D05. Production instructions name a button that the UI does not use

**Evidence:** [Transport provisioning](../guides/deploy/production-agents.md#prepare-transport-credentials-and-deploy),
line 360, says **Deploy new revision**. The
[console reference](../reference/console/create-and-deploy.md#deploy-a-new-revision)
says **Deploy new version**; the label in
[console source](../../apps/controller/src/console/agents/detail.mjs) at line 1137
confirms the latter.

**Correction:** use the exact UI label in instructions. Explain once that a UI
“version” corresponds to an AgentRevision rather than alternating button names.

### D06. The production Agent guide combines too many independent procedures

**Evidence:** [Production Agents](../guides/deploy/production-agents.md): Namespace
RBAC at line 10, runtime setup at 89, IAM grants at 295, native UI at 440, TUI
attachment at 471, cleanup at 567. The length checker reports 2,497 words.

The reader must navigate cluster administration, Agent configuration, browser
administration, and a long Bash/Python Pod-selection function in one sequence.
Optional native UI appears between required deployment and model verification.
Being below the word limit does not make these one reader task.

**Correction:** keep the deployment sequence and completion checks together;
link to the existing native-admin guide and extract TUI attachment into a focused
operator procedure. Preserve exact-revision checks and credential cleanup.

### D07. Repository access mixes managed Agents and standalone service operation

**Evidence:** [Repository access](../guides/repository-credentials.md), lines 1–193
describe normal Agent work; lines 194–445 switch to standalone clients, builds,
manual sessions, container packaging, and closure. The page is 2,485 words.

The standalone disclaimer is useful, but its subsequent steps are sibling
headings rather than a clearly bounded alternative workflow. A reader following
“Give an Agent repository access” must determine which lifecycle they are in.

**Correction:** retain managed Agent setup and use here. Move the independent
service procedure to a named child guide, including its session recovery and
cleanup. Link both paths from the opening paragraph.

### D08. Integration discovery omits repository access

**Evidence:** [Integrations overview](../guides/integrations/README.md), lines 3–21,
offers Compute, Driver selection, ChatGPT, and Slack. The
[Backend reference](../reference/backends.md) also documents the GitHub Backend,
and a full [repository setup guide](../guides/repository-credentials.md) exists.

A reader searching by task has no repository-access row in the overview, despite
repository credentials being prominent on the documentation home.

**Correction:** add “Give an Agent access to GitHub repositories” linked to its
guide. Do not copy the Backend contract into the overview.

### D09. The documentation home accumulates feature-specific side paths

**Evidence:** [Documentation home](../README.md), lines 29–50.

After the section map, separate paragraphs enumerate metrics, repository
credentials, console screenshots, native administration, runtime flows, and a
specific RFC. This gives selected features disproportionate prominence and mixes
operator entry points with contributor evidence.

**Correction:** retain the install choices and section map; place feature links
in their owning Topics, Integrations, Operate, or Contribute indexes. Keep only
the consequence needed to choose a starting path on the home page.

### D10. “Inventory” navigation leads to a historical proposal

**Evidence:** [Earlier inventory](../documentation-inventory.md), opening paragraphs;
`docs/docs.json`, baseline lines 811–813, labels it simply **Inventory**.

The page responsibly marks itself historical, but the navigation does not.
Readers seeking current documentation work first encounter a five-menu proposal
and a superseded coverage count.

**Correction:** use the existing page as an index that clearly distinguishes
dated audits, or label the old record as historical. This audit adds a
dated link without replacing the old proposal.

### D11. The CLI setup guide becomes a broad operations manual

**Evidence:** [CLI setup](../guides/cli.md): after installation and connection it
covers fleet inventory, draft creation, deployment, Secrets, credential sources,
IAM, and local development. Deployment also introduces `jq` without listing it
as a prerequisite.

Readers looking for their first authenticated command must distinguish basic
setup from multiple unrelated tasks. Many procedures already have owning guides.

**Correction:** keep install, connect, first read, credential boundaries, and
connection troubleshooting. Link task guides for the rest; declare `jq` wherever
the retained examples require it.

## Baseline P3: wording and repetition

### D12. Repository discovery rules are compressed beyond usefulness

**Evidence:** [Create a repository Agent](../guides/repository-credentials.md#create-and-deploy-an-agent),
lines 47–48: “Unverified discovery blocks writes; authorized optional outages
permit ordinary drafts.”

“Writes” could mean saving an Agent or pushing Git changes; “authorized optional
outages” does not identify what failed or what the user may still do.

**Correction:** name the failed lookup, the affected console action, and the
condition that allows creation without repository selections. Link the precise
admission contract rather than compressing it into unfamiliar labels.

### D13. Internal shorthand leaks into operator instructions

**Evidence:** [Production transport setup](../guides/deploy/production-agents.md#prepare-transport-credentials-and-deploy),
line 395, uses “CP Secrets”; [repository setup](../guides/repository-credentials.md#create-and-deploy-an-agent),
line 116, calls an IAM binding a “private principal grant.”

Neither phrase tells an operator clearly where the credential lives or which
permission must be granted. The surrounding instructions already name the
Agent service principal and exact Secret.

**Correction:** write “control-plane Kubernetes Secrets” and “grant the Agent's
service principal `operate` on the exact model Secret.” Avoid implying that the
grant requires a separate private mechanism.

### D14. Repeated proof caveats obscure the next action

**Evidence:** [Local setup](../guides/quickstart.md), lines 19–20, 98–101, 155–157;
[first Agent](../guides/first-agent.md), lines 70–85;
[production Agents](../guides/deploy/production-agents.md#verify-workspace-access)
and its following verification sections.

The distinction between admission, active revision, workspace access, and model
execution matters. Repeating variants of “does not prove” throughout the journey
makes readers repeatedly reconstruct which check finishes their current step.

**Correction:** give each step its expected result and next check. Define the
different evidence levels once in the owning verification guide, retaining local
warnings where confusing them would change an operational decision.

## Baseline verification and limits

The baseline checks validated 232 site pages and 3,884 links. The length checker
examined 394 Markdown files: 96 exceeded the 1,500-word review threshold, with no
unapproved violations of the 2,500-word limit. Length alone was not treated as a
finding. Existing generated-reference and AGENTS.md exceptions were respected.

`pnpm docs:check` attempted dependency reconciliation and aborted before checking
docs. The underlying `node scripts/docs-site/word-count.mjs` and
`node scripts/docs-site/build.mjs --check` commands passed without installing
dependencies. No tests, deployments, external-link qualification, or browser
visual audit were run. Support findings concern how existing limits are
presented; they do not certify runtime behavior.

After adding this inventory and its navigation entry, validation passed for 233
pages and 3,913 links. Formatting, workspace boundaries, and the Markdown hard
limit also passed. This inventory stays on one page despite exceeding the
1,500-word review threshold because its 14 findings and their resolution form one review
record; splitting it would separate the findings from their disposition.
