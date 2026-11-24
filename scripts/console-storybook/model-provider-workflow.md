# Inspect model configuration and save a Credential Source

Open **Pages/Create Agent → Codex with model Credential Source**. The story fills a
dummy OpenAI API key in a masked field and leaves **Credential storage** set to
**Credential Source**. Select **Create Agent**. Confirm that the request log shows
`POST …/credential-sources` before the Agent draft save, with no `POST …/secrets`.
The draft uses the returned Credential Source ID. The response does not contain
the entered key. Deploying this draft is a separate action.

Also inspect these changed states:

- **Credential Source creation denied** shows a simulated permission refusal.
- **Credential Source outcome unknown** shows a simulated TokenService outage and clears the entered key.
- **Credential Source creation pending** shows the submitting state while the request waits.

For guided provisioning with the existing Secret path, select **Namespace Secret**
under **Credential storage** and choose a Secret. **Pages/Settings → Shared model
provider** remains a read-only view of Installation startup configuration; Source
creation does not change that configuration.

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
