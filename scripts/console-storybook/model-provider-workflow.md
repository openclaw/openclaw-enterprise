# Inspect shared model configuration and authorize a credential

Use these desktop stories:

- **Pages/Settings → Shared model provider**
- **Pages/Create Agent → Authorize shared model destination**
- **Pages/Create Agent → Destination authorization refusal**

In Settings, expand Compute and inspect `runtime.modelProvider`. Switch between
Fields and JSON. Confirm that the URL and protocol agree and that no credential
value appears. The view is read-only; operators change Installation startup
configuration.

In Create Agent, select the simulated model Secret. Enter
`https://models.example.com/v1` in **Authorized base URL**, then create the Agent.
Confirm that the source registration carries `config.authorized_base_url` and
does not carry `config.base_url`. This field authorizes the key's destination;
it does not choose or override the Installation endpoint.

Also check the existing default-source, missing-credential, registration-failure,
and uncertain-registration stories. An empty authorization uses OpenAI's default
destination. Pending registration locks its configuration. Check registration before editing
a refused request; uncertain registration reuses the same request. Switching to account authentication hides source configuration.

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
