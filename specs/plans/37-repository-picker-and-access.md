# Repository selection and inherited access

Status: Implemented; review and publication pending.

Let an operator find repositories, add them to an Agent, and inspect the resulting
access without working through a long checklist. Keep Read-only and Contributor
as the two normal choices. Each repository inherits the Agent's repository
default unless the operator explicitly customizes it.

## Current boundaries

Source checked at `a67f8ea0`:

- [Console repository fields](../../apps/controller/src/console/agents/repositories.mjs)
  render the complete catalog and apply one profile common to all selections.
- [Repository options](../../packages/contracts/src/repo.ts) expose a stable
  `repositoryRef`, display name, and allowed profiles. They contain no usage,
  popularity, or last-activity ranking.
- [GitHub RepoDriver](../../apps/controller/src/drivers/repo/github/driver.ts)
  returns repositories approved for the Namespace and resolves each binding's
  profile independently. Mixed access is already possible through the API.
- [API schemas](../../packages/contracts/src/api/common.ts), RepoDriver, persisted
  credential state, and runtime material validation cap attached repositories
  at 16. A catalog with hundreds of choices is a separate requirement from
  attaching hundreds to one Agent.

This proposal assumes large catalogs with the existing attachment limit. Raising
that limit requires a separate capacity decision covering sessions, credentials,
material size, cloning, startup time, and cleanup.

## Default interaction

Place the Agent's **Default repository access** above discovery. Contributor
means push code, work with pull requests, and manage issues when approved.
The existing issue toggle belongs in a collapsed customization pane.

Below it, show available repositories or **Find a repository**. Adding a result
moves the choice into a compact selected stack below discovery. The search field
contains the query only; it does not accumulate selected chips.

Each selected card has two lines:

1. Repository identity, **Access** disclosure, and a separately labeled Remove action.
2. **Contributor · Agent default**, **Read-only · Custom**, or
   **Contributor · Issues off · Custom**.

Show the owner with the repository name; do not identify repositories by an
ambiguous short name. A short name may be primary typography, with owner secondary.
Long names wrap on narrow screens.

The Access disclosure expands in place. **Use Agent default** is selected
initially. Turning it off reveals Read-only / Contributor and the supported issue
setting. **Use Agent default** also resets an existing override. A gear alone
is insufficient: retain a visible Access label and chevron.

Adding requires one explicit action, including when only one repository is
available. Search matches and suggestions never grant access by themselves.
Append cards in selection order. Keep that order stable when defaults, queries,
ranking, or access change. Removal offers a short Undo action.

## Adapt to catalog size

Initial thresholds are design hypotheses to validate with the prototype.

| Available catalog | Initial discovery surface                                                                |
| ----------------- | ---------------------------------------------------------------------------------------- |
| 1                 | One compact row with Add. No search field or empty selected panel.                       |
| 2–5               | All available rows with Add. No search ceremony.                                         |
| 6–25              | Search plus up to six initial suggestions; Browse all reveals the rest in bounded pages. |
| 26–100+           | The same search-first surface, with a bounded result list and Browse all.                |

Freeze the mode from the loaded catalog size, not the shrinking unselected count;
adding a repository must not repeatedly change the layout. When every repository
in a small catalog is selected, discovery reduces to “All repositories added.”

Search matches display name and stable reference, case-insensitively. Match exact
names first, then prefixes, then substrings, with a stable alphabetical tie-break.
Keep the query after an addition so an operator can add several related matches.
Mark already-selected matches **Added**, without changing their place mid-action.

“Top” must have an explainable meaning. Start with **Recently used** repositories
from successful saves by this operator in this Namespace, intersected with the
currently authorized catalog. Fill remaining slots alphabetically. On first use,
show **Repositories**, not invented popularity. Recency is an optional convenience,
not a new authorization source; absent history does not block discovery.
Exclude selected repositories from initial suggestions; retain their Added state
when they match an explicit query or appear in Browse all.
Organization-wide popularity and administrator-pinned recommendations are later work.

For hundreds of small option records, filter the existing complete response
locally and render only the visible results. Measure before adding a server search
contract. If discovery later becomes paginated, require explicit completeness,
opaque cursors, Namespace-scoped authorization, and selected-item resolution;
absence from one results page must not remove a selected binding.

## Selected stack and inheritance

Show all cards for up to five selections. Beyond five, initially show five and
**Show all N selected**. Surface the number of custom settings in the stack header.
Always reveal a card with an unresolved access error. At 16, disable additional
Add actions and explain the limit beside discovery; searching, editing, and
removing remain available. Do not place “Select all” beside a large catalog.

“Agent default” is an editing relationship, not a new permission tier.

| Action                                      | Required result                                                      |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Add a repository                            | Inherit the current Agent repository default.                        |
| Change the default                          | Update inherited cards; leave custom cards unchanged.                |
| Customize to the same effective permissions | Remain Custom; future default changes do not affect it.              |
| Return to Agent default                     | Discard the override and show the current default.                   |
| Remove and Undo                             | Restore the previous mode and override.                              |
| Save and reopen                             | Preserve default, inheritance mode, overrides, and effective access. |

Changing the default updates a short summary such as “3 inherited · 1 custom.”
If a custom repository is more permissive than a newly lowered default, keep its
visible Custom label and summarize that exception beside the default. Do not
describe Read-only as an Agent-wide ceiling when Contributor overrides exist.
These controls concern repository permissions; model, Secret, and channel access
remain separately owned.

Namespace policy bounds every repository independently. If a newly selected
repository cannot use the default, retain its card with **Choose approved access**
and open its Access pane. Explain the approved choices. Do not silently lower,
raise, remove, or convert it to a custom profile. Block save until resolved.
Do the same when a default change makes an inherited binding invalid.

Discovery failure, a revoked repository, and no search matches have different
states. Keep in-progress selections visible during refresh or failure and mark
them unverified; they cannot authorize a save. A removed or restricted choice
requires explicit repair. Preserve the current fail-closed discovery behavior
and its narrow fresh-Agent exception described in the
[current access reference](../../docs/reference/repository-credentials/access-levels.md).

## Persistence and ownership

Per-repository effective profiles already exist. Persistent inheritance does not.
Do not infer it by comparing a saved profile with the current default.

Extend the Agent's desired repository-access contract to retain the default and
whether each binding inherits or overrides it. The API uses `repositoryAccess: { defaultProfile, repositories }`;
each entry has `repositoryRef` and an optional explicit `profile`. This intent must round-trip through create,
edit, supported Presets, and stored desired state. It must not live only in browser
storage or in a GitHub-specific core field.

One authoritative resolution path produces explicit profiles for admission.
OCC validates the intent through RepoDriver, and admitted revisions retain
concrete bindings. Editing a draft default must not change a running revision's
authority until the existing deployment/admission path accepts a new revision.
Provider token permissions continue to derive from approved concrete profiles.

Existing Agents have explicit profiles but no inheritance history. Preserve those
profiles as custom bindings on first edit; offer an explicit adoption of the Agent
default. Do not reinterpret an omitted API profile as UI inheritance: the current
Driver default is `git-write`, and existing API behavior must remain compatible.

## Interaction quality

- Search supports keyboard navigation, Enter to add, Escape to dismiss results,
  and normal Tab navigation. A stale search response cannot replace a newer one
  if server search is introduced.
- Announce additions, removals, result counts, and validation errors. Keep focus
  in discovery after adding; move focus predictably after removing a focused card.
- Use an accessible expanded state for Access. Custom summaries and Remove remain
  available without hover. Support 320px layouts and touch-sized targets.
- A short insertion transition may connect a result to its card. Respect reduced
  motion. Selection must remain clear with animation disabled.

## Delivery and design review

1. Compare **Adaptive inline** discovery with a **Search-first** alternative using
   catalogs of 1, 5, 25, and 140 items. Exercise zero, one, five, and sixteen
   selections, duplicate names, long names, and mobile widths.
2. Settle inheritance persistence and compatibility in the Agent contract.
   Implement the picker, cards, and per-repository validation through the existing
   Console and RepoDriver paths.
3. Verify real Console/API save and reopen, default changes with overrides,
   policy conflicts, revocation, retry, keyboard use, the attachment limit, and
   unchanged admitted revisions. Verify no write occurs while selection is invalid.
4. Update [create and deploy](../../docs/reference/console/create-and-deploy.md),
   [access levels](../../docs/reference/repository-credentials/access-levels.md), and
   [Console flow](../../docs/flows/platform-console.md) when implemented.

Success means one available repository can be added without search, a known
repository in a large catalog can be added without browsing the whole catalog,
and an operator can identify every access exception from collapsed cards.
Measure task completion and errors during design review before fixing thresholds.

Additional Actions, workflow-file, and independent code/PR scopes remain separate
permission work. The expandable card can accommodate them when enforcement exists.
