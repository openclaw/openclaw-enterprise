# Edit Agent Configuration, plugins, and workspace files

These are the **Configuration**, **Plugins**, and **Workspace files** tabs of the
[Agent detail page](agent-details.md). Configuration and plugin changes apply only
after **Deploy new version**; a workspace file save applies at once.

## Configuration tab

| Field                                  | Meaning                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Model**                              | Primary model configured for the Agent.                                                                          |
| **Execution mode**                     | Embedded runs the harness within the gateway; Dedicated runs it separately.                                      |
| **Backend (experimental)**             | Installation-configured Backend associated with this Agent; model credentials come from Harness authentication.  |
| **Harness authentication**             | Saved authentication binding, such as a ChatGPT service account ID. It is not a credential value or login check. |
| **Created**                            | Creation time of the displayed Configuration or version.                                                         |
| **Harness**                            | Version's harness identifier and integration version. This is not the installed Codex CLI version.               |
| **Compute**                            | Version's Compute Driver identifier and implementation.                                                          |
| **View admitted native configuration** | Expands the version's formatted native JSON. The draft uses **View native Configuration**.                       |

In the draft, **Enable gateway password access** stages the generated-password
reference; authentication mode and proxy settings stay unchanged. The Compute
Driver owns the password; the Console shows only its reference.

**Edit Configuration** edits native JSON. **Save Configuration** requires an object;
**Cancel** discards edits. **Edit current Configuration** opens the current draft's editor,
not a historical copy. Without Configuration `update`, or Secret `operate` on a Secret the
Configuration binds, it reads **Open version draft** and opens the draft read-only. Saving preserves Secret bindings and saved versions;
**Deploy new version** applies saved values, including for Agents sharing this
Configuration on their next deployment.

Unsaved edits, pending saves, and stale or unknown outcomes block deployment,
tab switching, and version navigation. Save checks Configuration association and
generation, and the API refuses later races. Reload stale drafts; after an
unknown outcome, successfully reload saved state before retrying. Invalid JSON
and failed saves retain text for correction.
Backend, execution mode, and Harness authentication are Agent fields, not native
Configuration JSON. See the [Configuration reference](../../reference/configuration.md).

## Plugins tab

In **Create new version** → **Plugins**, edit the Agent's existing selections and
tool policies with **Configure plugins** or **Plugin selections JSON**. With a bound
Service Accounts token Secret, the tab preloads the first catalog page for the
picker. Search and tool lookups show loading indicators. Dedicated Codex browsing
requires exact active Agent `read`/`update` and a catalog-capable Plugin Driver. The
curated catalog needs no Secret. Hosted discovery uses the bound Service Accounts
token Secret server-side and requires caller and Agent ServicePrincipal Secret
`operate`; the browser never receives the token. Other execution modes cannot
browse this catalog. Hosted results use the draft credential, which may differ
from the running version's; neither catalog proves installation or runtime
access. Existing
selections and **Plugin selections JSON** remain editable when browsing is
unavailable.

An open Slack approver search keeps its query and results when you return to the
browser tab and still have Agent access. Moving to another Console control closes
the results; focus the search field to open them again. Switching Agent tabs and
returning keeps a completed query.

Select **Save plugin selections** to update the Agent's desired plugin map, then
**Deploy new version** to apply it. Saving does not alter a saved version
or the reusable Configuration. An empty map removes all Agent-owned plugin
selections on the next deployment. The selected Plugin Driver validates policy
at save and deployment; installation and app access are checked later during
startup. A rejected save leaves the running version unchanged. For policy
limits and errors, see [Agent plugins](../../reference/agent-plugins.md).
Without Agent `update`, the selections and default plugin approvers show as a read-only summary
with no editor, and a note names the grant to ask for. Every Agent save also needs `operate` on each Secret and credential
source that the Agent and its Configuration bind; without it, they are read-only and a note says so.

If you see **Plugin selections changed**, the Console stopped before saving.
If you see **Outcome unknown**, your changes may already be saved. Note any edits
you want to keep, then select **Reload plugin selections**. Reload reads the Agent
without repeating the save. A failed reload cannot resolve an unknown save outcome.

When you see **Plugin selections reloaded**, the saved selections and approvers
have replaced your draft. If they match what you intended, continue to **Deploy
new version**. Otherwise, edit the reloaded settings and save only the changes
you still need.

When viewing a saved version, the **Plugins** tab shows that version's
saved selection. Return to **Create new version** to make another edit.
Native `values.plugins` in **Edit Configuration** controls the runtime's native
plugin allowlist and is separate from these Agent-owned selections.

## Workspace files tab

**Workspace access is unavailable** leaves
the editor and Save disabled. The empty box does not mean the file is empty.
Check gateway access, then use Reload.

These are live files belonging to the Agent, even when you browse an older
version. They are not historical copies or Configuration fields.

| File          | Typical role                                      |
| ------------- | ------------------------------------------------- |
| `AGENTS.md`   | Workspace instructions and operating conventions. |
| `SOUL.md`     | Behavior, tone, and boundaries.                   |
| `IDENTITY.md` | Agent identity and presentation.                  |
| `USER.md`     | Context about the person the Agent assists.       |

Each editor loads independently. Its status reports loading, success, or failure.
**Reload** replaces unsaved edits with current contents. **Save** immediately
creates or replaces that one file; it does not deploy a version. Save is disabled
until appropriate loaded, changed state is available.

Each file allows up to 16 KiB of valid UTF-8 text. Concurrent saves use the last
writer's contents. Reading requires Agent `read`, saving requires `operate`, and
access needs a selected version with a reachable gateway. Without `operate`, the
files are read-only and a note above them names the grant. An uncertain save
requires Reload to confirm contents or file absence before another save. A confirmed
missing file opens an empty editor; read failures leave Save disabled. See
[Workspace Files](../topics/workspace-files.md).
