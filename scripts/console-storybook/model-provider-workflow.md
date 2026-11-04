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

Storybook uses production Console components with simulated API responses.
These stories prove field rendering, request construction, and visible results.
They do not prove backend authorization, deployment, persistence, or model execution.
The source API and provider lifecycle tests own those backend checks.
