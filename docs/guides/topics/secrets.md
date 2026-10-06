# Secrets

A Secret stores a credential for one OpenClaw Namespace. OpenClaw Control Plane
(OCC) returns its ID and metadata, never its value. An Agent can use a Secret
for model authentication, or its Configuration can map a Secret to a gateway
environment variable. Use the path that matches the consumer:

| Credential                                 | Where to bind it                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Model API key                              | [Agent `harnessAuth`](../../reference/agents.md#harness-authentication); the selected Harness receives it.                    |
| Gateway credential, such as a Slack token  | [Configuration `secretBindings`](../../reference/configuration/secrets.md#secret-bindings); the selected gateway receives it. |
| Backend-issued model access token          | [Service accounts](../../reference/service-accounts.md); this follows its own credential lifecycle.                           |
| Model API key held by a Credential Gateway | [Credential source](../../reference/credential-sources.md); the Harness receives only a placeholder. OpenShell only.          |

## Create and bind a Secret

1. Wait for the Namespace to become `ready`. Use the [Kubernetes Secret Driver
   procedure](../../reference/drivers/kubernetes-secret.md#create-a-namespace-owned-secret)
   to send a value from a protected file. Retain the `sec_…` ID returned in the
   metadata.
2. Bind that ID through the Agent or its Configuration. The Secret, Configuration,
   and Agent must belong to the same Namespace. Never put credential values in
   Configuration `values` or a ConfigMap.
3. Confirm permissions before deployment. Assigning a Secret requires the caller
   to have `operate` on that exact Secret. Once an Agent's draft is bound to a
   Secret for model authentication, every later edit of that draft, including a
   switch to another Secret, also requires `operate` on the Secret bound now.
   Deploying also
   requires the Agent's service principal to have `operate`. The
   [driver guide](../../reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment)
   explains who can grant it. Namespace access or possession of the Secret ID
   does not grant permission to consume the value.

For an Installation created by the local Quickstart, [Deploy your first Agent](../first-agent.md)
grants that exact permission to the Agent it creates. Shared Installations still
require an administrator with access to the configured IAM authority.

## Rotate or remove a Secret

Updating a Secret changes the stored value. It does not restart a workload or
change a running process's environment. Redeploy each consumer through OCE and
verify the new revision. There is no value history or automatic rotation. If a
credential is exposed, stop the affected workloads, revoke it at the upstream
provider, store a replacement, and redeploy. OCC rejects deletion while a
current Configuration, credential source, Agent draft, active revision,
pending deployment, or pending Agent provisioning request still references the
Secret. See [Update and redeploy](../../reference/drivers/kubernetes-secret.md#update-and-redeploy).
