---
rfc: ../rfcs/0034-reusable-model-providers/index.md
---

# Implementation plan: Reuse a model provider across Agents

- **ID:** RFC-0034
- **Delivery status:** In progress
- **Owner:** stevenlee-oai
- **Source baseline:** `b3f542cdf`

## Delivery

1. Define the Installation's provider catalog, the static-key Connection Template, and the credential owner's approval of a specific template version. Expose the public API and generate its reference.
2. Store provider records and immutable grants. During Agent admission, resolve the selected model and check its provider against the credential grant. Save the provider, model information, and resolved route with the revision so retries and recovery use the same destination. Enforce the approved request in the trusted sender.
3. In Settings, let an administrator save the provider and its model list. In Credentials, let the key owner select a Secret and approve the template's request. Create Agent offers the saved provider and its eligible credentials, followed by its models. The Agent's default and additional switchable models are a separate change.

## Private endpoint routing

The current implementation uses the trusted sender’s existing network route. Automatic Kubernetes policy for a private receiver remains open. It needs an Installation-authorized network peer and port and an enforcing-cluster test that distinguishes the approved destination from an unapproved one.

## Verification

Exercise provider creation, template versioning, credential consent, and Agent deployment through the supported API. Redeploy after changing the provider and check the old revision still holds its original route. Try a mismatched credential and verify refusal before work starts. Exercise the allowed and denied requests at the credential sender.

Check the Console setup and selection workflows in the browser. Private inference qualification requires a reachable private endpoint, an authorized inference credential, an enforcing cluster, and a tool-using turn on two Agents. Track that result separately from fixture and generated-policy checks.
