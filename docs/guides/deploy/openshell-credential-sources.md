# Use a static Credential Source on the local OpenShell profile

Use the Kubernetes-only OpenShell profile to run a dedicated Codex Agent with an approved OpenAI API key or Codex service account token. TokenService holds the credential. OpenShell Credential Proxy supplies it only to the approved model requests.

## Before you start

[Start the OpenShell profile](local-kubernetes-development.md#start-the-openshell-fail-closed-profile). Use the API URL and service-key file that Local Setup prints. Have an existing model credential in a private file and a model that account can use.

## Register the key

In the Console, open **Create Agent**. In the authentication picker, choose the **OpenAI** key or **Codex service account token** option and enroll the credential as a Source. Check that the Source is ready before deploying.

For CLI or API use, follow [Register a managed static Source](../../reference/credential-sources/managed-static.md). The built-in key preset covers the approved OpenAI endpoint. For a key or token that was saved only as a Namespace Secret or a Gateway Source, submit it again as a new TokenService Source.

## Create the Agent and grant the source

Create a dedicated Codex Agent that uses the ready Source for Harness authentication. The caller and Agent each need `credential_source:operate` on the exact Source. Use the Agent's **Network** settings to approve the Codex executable and model destinations allowed by the Installation. [Credential Source deployment](../../reference/credential-sources/managed-static.md) explains the exact network and credential checks.

For a new development Agent, First Agent can do the registration and deployment together from a private credential file:

```bash
OPENAI_API_KEY_FILE=/path/to/openai-key node scripts/first-agent.ts first-agent --harness codex
```

For a Codex service account token, set `CODEX_ACCESS_TOKEN_FILE` instead. First Agent saves the permitted model network rules before deployment.

## Deploy and check the result

Deploy the saved Agent and wait for the version to become ready. [Verify a model response](../operate/model-verification.md). For native Git on the same Agent, see [OpenShell Git access](../repository-credentials/openshell-git-push.md).

## Rotate the key

Replace the credential on its existing Source. TokenService commits the update and requests delivery to the Agent. If delivery fails after the update commits, use the existing [credential delivery retry](../../reference/credential-sources.md#update-a-source).

## Clean up

Withdraw or remove the Agent binding before deleting an in-use Source. See [Source lifecycle](../../reference/credential-sources.md#delete-a-source).

## Troubleshoot

Check the Source, exact Agent binding, caller and Agent grants, and the approved model network rule. If the Installation uses a custom model endpoint, check its supported credential and transport options before re-enrolling.
