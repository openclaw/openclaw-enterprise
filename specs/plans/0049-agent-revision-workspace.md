# Agent revision workspace implementation plan

- **ID:** TASK-0049
- **Delivery status:** In progress
- **Owner:** Console contributors
- **Authority:** [Console reference](../../docs/reference/console/versions-and-channel-drafts.md)
- **Source baseline:** `222d2266842db457415e146b70a30abf430480aa`

## Goal and approved design

An operator selects an Agent revision or opens its saved draft, then explores
the selected revision's details inside one workspace. The user approved the
history-rail concept and requested implementation and local k3d deployment.

Use a compact desktop history rail beside a persistent revision heading and
detail tabs. On smaller screens, use one selector above that heading. Mark
the viewed revision separately from the revision selected for service. Show
the draft as **Build next revision**; saving affects future deployments.
Workspace files and Access remain Agent-wide and sit outside revision tabs.
Deployment records and diagnostics remain in Deployment.

The alternative compact selector saves desktop width but hides history; it is
used only at smaller widths. The existing vertical layout separates the picker
from the detail it controls, so it is replaced.

## Architecture and constraints

The supported caller is the existing Console Agent page. Extend
`apps/controller/src/console/agents/detail.mts` and shared `console.css`;
keep the existing API, permission checks, deployment, draft retention, and
unknown-outcome recovery. No Driver contract or persistence change is needed.

Revision navigation keeps the selected tab when the destination supports it;
drafts fall back to Configuration for Logs. Policy denials retains its supported
draft policy editing. Agent-wide
sections return to Configuration when the reader opens Revisions.
Existing revision URLs and Back/Forward behavior remain supported.

## Review focus

- Viewed and selected-for-service revisions must stay distinct after polling.
- Unreadable, failed, or missing revisions retain navigation and recovery.
- Draft writes and unsaved changes retain existing navigation guards.
- Agent-wide Access retains its permission-dependent visibility.
- Mobile navigation exposes one picker and no page-wide horizontal overflow.

## Task 1: Connect revision selection and detail

**Files:** `apps/controller/src/console/agents/detail.mts`,
`apps/controller/src/console/console.css`, existing `tests/browser/` suites.

- [x] Extend the real-controller browser workflow to select revisions, preserve
      the detail tab, open the draft, and distinguish Agent-wide sections.
      Run the focused case before implementation and record the expected failure.
- [x] Build the compact history rail, persistent revision heading, nested tabs,
      separate Agent-wide navigation, and responsive picker. Reuse the existing
      authorization, draft, and deployment owners.
- [x] Adapt existing browser navigation helpers and run the affected suites.
      Expected: supported revision navigation and draft guards pass.

## Task 2: Document and inspect the final UI

**Files:** `scripts/console-storybook/public/scenarios.mjs`, matching workflow
instructions, Console reference, and `docs/flows/platform-console/agent-editing.md`.

- [x] Update stories and workflow instructions for the new hierarchy, including
      empty, read-only, missing-credential, loading, error, and permission states.
- [x] Update the owning reference and flow. Run docs checks and the flow validator.
- [x] Build Storybook from changed source and inspect desktop and mobile.
      Capture screenshots and an interaction video outside the checkout.
- [ ] Run lint, formatting, typecheck, workspace isolation, and proportional
      browser checks. Request independent review and address material findings.

## Task 3: Deploy into local Kubernetes development

- [x] Inspect retained Podman/k3d state and choose the existing suitable local
      environment. Preserve unrelated services, kubeconfig, and contexts.
- [ ] Build a uniquely tagged controller image from the changed checkout, import
      it into the selected cluster, and update only its OCE control-plane release.
- [ ] Confirm controller and worker readiness, Kubernetes Compute selection,
      and the changed Console through the real deployment. Record its loopback URL.

If startup requires interrupting unrelated services, obtain the user's choice
before that interruption. Preserve existing Agent data and credential references.

## Verification and delivery record

Browser fixtures prove real Console/API interactions with in-memory state and
test Drivers. Storybook is simulated UI proof. Deployment checks must separately
establish in-cluster control-plane readiness and Kubernetes Compute selection;
they do not establish a model turn unless that workflow is exercised.

The implementation, current reference, flow, and rebuilt Storybook are complete.
Desktop, mobile, empty, read-only, missing-credential, loading, unavailable, and
long-history previews were inspected. Screenshots and a recorded walkthrough
remain outside the checkout; upload and independent review are pending.

The first affected-browser run passed 542 of 568 cases. Twenty-two failures
needed navigation or selector updates for the new layout; four timing failures
passed unchanged on serial retry. All 26 failures passed retry, alongside two
responsive checks. New selection and delayed failure-badge regressions passed;
the latter first failed with a Historical badge beside a Failed notice.
Typecheck, lint, formatting, workspace isolation, and design-token checks pass.

The retained `oce-observability-full` cluster now has ready API, worker,
PostgreSQL, and Console proxy workloads and selects Kubernetes Compute. The
dedicated alternative VM remains stopped because another VM serves unrelated
workloads. A full controller image build and upgrade are in progress. Its
Console uses reserved loopback port 3302; final deployment verification is pending.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-27: Record the approved design and local deployment scope at source
  `222d2266842db457415e146b70a30abf430480aa`.
