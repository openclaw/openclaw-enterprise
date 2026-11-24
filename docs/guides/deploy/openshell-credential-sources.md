# Use a static credential source on the local OpenShell profile

Run a dedicated Codex Agent with an OpenAI API key or a Codex personal access
token (PAT). In the cutover candidate, OCC TokenService holds the credential and
the native OpenShell Credential Proxy injects it on approved model requests.
For a release still using Credential Gateway, follow the
[pre-cutover static Source procedure](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/deploy/openshell-credential-sources.md).

## Before you start

Complete [local k3d setup](local-setup.md) with the candidate checkout and
matching images. Keep your model credential in an owner-only file outside the
checkout and choose a model that the corresponding account can use.

## Register the key

In the Console, open **Create Agent** and enroll the OpenAI key or Codex PAT as
a Credential Source for dedicated Codex. Check that the Source is ready.
For API enrollment, follow the [candidate static Source request](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/credential-sources/managed-static.md#register-a-source)
with `config.provider_preset` set to `openai` for an OpenAI key or `codex-pat`
for a Codex PAT. Re-enroll a credential previously recorded as a Namespace
Secret or a Gateway-owned Source.

## Create the Agent and grant the source

For a new local Agent, run [First Agent](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/scripts/first-agent.ts)
from the candidate checkout. The helper
enrolls the Source, creates a dedicated Codex Agent, and applies the required
model network policy.

```bash
OPENAI_API_KEY_FILE=/path/to/openai-key node scripts/first-agent.ts first-agent --harness codex
```

For a Codex PAT, set `CODEX_ACCESS_TOKEN_FILE` instead. For an existing Source,
create a dedicated Codex Agent draft, select the exact Source in Harness
authentication, and grant the caller and Agent `credential_source:operate` on
that Source. Enable and save the matching model network rule for the Codex
executable. See the [candidate Agent and policy procedure](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/credential-sources/managed-static.md#deploy-an-agent-with-the-source)
and [Codex PAT requests](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/credential-sources/managed-static.md#codex-pat).

## Deploy and check the result

The First Agent helper deploys its Agent. For a saved draft, use the Agent API
to deploy. Wait for the deployment to report `succeeded` and
`activeRevisionId` to match the deployed revision. Then
[verify a model response](../operate/model-verification.md). A genuine model
turn with a Codex PAT still needs live qualification.
[Cutover verification](https://github.com/openclaw/openclaw-enterprise/pull/7224)

For native Git on the same Agent, see [OpenShell repository enrollment](../repository-credentials/openshell-enrollment.md).

## Rotate the key

[Update the existing Source and verify the replacement](credential-lifecycle.md#replace-an-occ-tokenservice-managed-model-key).
If delivery fails after TokenService commits the new value, retry delivery to
an active Agent that uses the Source.

## Clean up

Withdraw or remove the Agent binding before deleting a shared Source. Stop and
[delete a disposable Agent](../../reference/agents.md#deletion), then
[delete its unused Source](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/credential-sources/managed-static.md#delete-a-source).

## Troubleshoot

If deployment is refused, check that the Source is ready, the caller and Agent
have access to the exact Source, and the saved network rule matches its preset
and executable. Guided Create Agent with a managed Source returns `409` in
the cutover candidate. Use First Agent or the Agent API for deployment.
