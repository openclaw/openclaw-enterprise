# Inspect model configuration and save a Credential Source

Open **Pages/Create Agent → Codex with model Credential Source**. The story fills a
dummy OpenAI API key in a masked field after selecting **Add new credential…** under
**Model credential**. Select **Create Agent**. Confirm that the request log shows
`POST …/credential-sources` before the Agent draft save, with no `POST …/secrets`.
The draft uses the returned Credential Source ID. The response does not contain
the entered key. Deploying this draft is a separate action.

Also inspect these changed states:

- **Credential Source creation denied** shows a simulated permission refusal.
- **Credential Source outcome unknown** shows a simulated TokenService outage and clears the entered key.
- **Credential Source creation pending** shows the submitting state while the request waits.

For Embedded execution, a password Preset, another provider, or an Installation without
a supported model Source preset, use the visible **Model credential Secret** picker.
**Pages/Settings → Shared model provider** remains a read-only view of Installation
startup configuration; Source creation does not change that configuration.

## Discover, create, and reuse a Source

Open **Pages/Credentials → Credentials**. The single **Credentials** tab shows readable
static, OAuth, and protected Proxy Source metadata alongside Namespace Secrets. Confirm that
the page does not show OAuth consent, Proxy configuration, or credential values.
Open **Create Source** with the keyboard. If you Tab to **Cancel** while templates load,
focus should stay on **Cancel** when the form appears. Press Enter to close the dialog.
If you leave focus on the heading, **Source name** should receive focus instead. The
Credentials browser test delays the response so it can check Cancel even when the
preview loads too quickly.

In **Create a Credential Source**, choose an OpenAI or Codex PAT model purpose, or
an available static Bearer Template. Enter a dummy value and select **Create Source**.
Confirm that the Source appears in the inventory and its value is not returned.
A Template Source cannot serve as model authentication or be admitted directly to an Agent.
**Created Source without exact read access** confirms creation without adding the Source to the readable inventory.
**Source created but inventory access denied** confirms creation, clears stale rows, and shows the denied Namespace read operation.

Open **Pages/Create Agent → Reuse an existing Credential Source**. Confirm the saved
Source is selected under **Model credential**, then select **Create Agent**. Check
that the draft uses the selected Source ID and the request log
contains no `POST …/credential-sources`. If the Source list fails, select **Retry Source list**
before choosing a Source. **Reuse a saved ChatGPT OAuth Source** selects a compatible
built-in OAuth Source in the same field without starting another sign-in. Open
**Components/Credentials → Replace an existing
Credential Source**, select **Save authentication source**, and check that the Agent
uses the replacement ID without another Source enrollment. Deployment is separate.
**Select a first managed Source for Codex** shows the Stop requirement and the destination check that occurs at deployment.
Open **Components/Credentials → Codex PAT Source with a previous model provider override**.
The simulated draft has switched from an OpenAI Source to a Codex PAT Source. Expand
**Harness destination** if needed. Confirm that **Harness settings** selects
**Use Installation default**, the previous model provider override cannot be retained, and
**Override model provider** is unavailable. The Credentials guidance identifies the PAT Source's
fixed destination. This story does not deploy the draft.

Inspect these list and failure stories:

- **Pages/Credentials → No readable Credential Sources** shows an empty Source inventory.
- **Credential Sources loading** keeps Namespace Secrets available while the Source read waits.
- **Pages/Create Agent → Existing Source list loading**, **Retry an unavailable Source list**,
  and **No eligible model Credential Source** show pending, retry, and missing-choice states.
- **Pages/Credentials → Credential Source inventory denied** and **Credential Source
  creation denied** show the applicable access failure.
- **Model Source creation when Templates are unavailable** keeps model Source creation
  available after Template discovery fails.
- **Credential Source create outcome unknown** clears the value and blocks another create.
  Close the dialog and select **Refresh** to find the Source saved by the simulated API.
- **Credential Source conflict outcome unknown** simulates a `409 RESOURCE_CONFLICT` response,
  clears the value, and blocks another create. Close the dialog and select **Refresh**. If the Source
  is absent, the guidance directs an operator to check the credential owner before another attempt.
  The preview cannot establish whether the owner holds the value.
- **Pages/Create Agent → Existing Source operate denied after Configuration save** reports
  the retained Configuration and the refused Agent create.
- **Components/Credentials → Credential Source replacement denied** leaves the saved Agent
  bound to its previous Source.
- **Model Source unavailable without an approved destination** preserves the current Source
  and disables replacement for a Configuration that cannot use the approved model preset.
- **Pages/Create Agent → Existing Source destination mismatch** refuses an incompatible
  Advanced settings route before saving Configuration or Agent state.

## Correct an edited model catalog

Open **Pages/Create Agent → Model choices before credential entry**. Use the
story's catalog correction steps before entering credentials:

1. In **Advanced settings**, add `models.providers.codex.models` as `{}` to
   **Configuration JSON**. Close Advanced settings and choose `gpt-6-sol`.
   Confirm the list returns to **Choose a model**, Advanced settings opens, and
   JSON receives focus. The inline guidance says to use an array of model
   objects with an `id` or remove the field. The raw text stays unchanged.
2. Correct the list to `[{"id":"gpt-6-astra","cost":{"input":1}}]` and choose
   `gpt-6-astra`. Change the list to `[null]`, then edit **Model ID** to
   `gpt-6-sol` and press Tab. Confirm the guidance returns without changing the JSON.
   **Choose a model from the list** must keep manual entry visible.
3. Restore the valid list, retry `gpt-6-sol`, and press Tab. Confirm the guidance clears,
   the primary becomes `codex/gpt-6-sol`, and `cost.input` remains `1`.
   Return to the list and choose `gpt-6-luna` to confirm recovery.

Do not create an Agent during this check. Reset the story before checking
credentials. The production form performs this validation; the story adds no
validation or error responses.

Storybook uses production Console components with simulated API responses.
These stories prove field rendering, request construction, and visible results.
They do not prove backend authorization, deployment, persistence, or model execution.
The source API and provider lifecycle tests own those backend checks.
