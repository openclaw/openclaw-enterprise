---
rfc: index.md
---

# Authorize a dedicated OpenClaw Agent’s model requests

**Proposed for qualification.** A dedicated OpenClaw Agent should be able to use an OpenAI model key and a saved plugin account together. Credential Proxy would authorize which credential each request can receive.

On a fresh Installation, selecting Credential Proxy sends new `openai` sources through protected static inference. OCC refuses registration when stock OpenShell v0.1.7 cannot advertise that profile’s execution protocol. OCC also rejects a saved plugin account on a revision with a protected inference plan. The deployed plugin test used an existing Gateway-managed model source. [Registration and deployment evidence](https://github.com/openclaw/openclaw-enterprise/pull/4673#issuecomment-6692334499)

## Proposed delivery

1. **Register and bind the key.** In the Agent’s Credentials tab, the operator chooses a Namespace Secret. OCC checks the operator’s permission to use that Secret and the Agent’s grant on the source. The operator selects [online authorization](online-authorization.md) for the model binding. OCC records that choice with the provider, model and destination. The source records the reference to the existing Secret. The worker gets a placeholder and the OpenShell profile identifies the request-time binding. The saved plugin account keeps its own binding and Token Service grant.
2. **Admit both bindings.** Before starting the workload, verify that the supervisor enforces both routes, that each route identifies one binding, and that the workload cannot bypass them. Qualify the actual OpenClaw request method, path, transport, model and request body. Deny unapproved fields such as provider-hosted tools that can call another service. Refuse overlapping credential routes. Preserve the protection level recorded on existing revisions. A revision that requires [exact dispatch](protocol.md) must still meet its original sender and response requirements.
3. **Release the right credential.** Qualify the stock pre-credentials middleware and zero-cache `token_grant` used for [saved accounts](../0027-agent-oauth-connections/contracts.md). The supervisor authenticates its Sandbox and presents the request ID and binding. OCC consumes the approval once and rechecks the Agent grant, route and credential version before release. For the model route, resolve the current static key through the Secret Driver. For the plugin route, resolve the account token through Token Service. The approval deadline bounds this use. The provider controls the lifetime of the underlying key.

Review whether per-request authorization is sufficient for this model profile, including streamed responses. A request authorized before withdrawal can finish. Exact dispatch additionally binds the send and response to the execution. Coordinate the model profile with [static inference retirement](https://github.com/openclaw/openclaw-enterprise/issues/4437) and [Credential Gateway retirement](https://github.com/openclaw/openclaw-enterprise/issues/4843).

## Qualification before enabling the profile

Start from a fresh Kubernetes Installation with Credential Proxy selected. Register the model key, connect the plugin account through browser consent, and deploy through the ordinary worker. Run a real model turn that calls the selected plugin tool. Verify which credential each HTTPS service received and that the guest sees only placeholders. Exercise the model transport the Harness actually uses, including streaming if the turn uses it.

Deny a different model or destination, a redirect carrying credentials to another host, an unselected tool, and replay of a consumed approval. Rotate the referenced model key and check its next request. Withdraw Agent A’s model grant while the key remains valid at the provider. A’s next model request must miss the origin and its plugin must still work. Separately detach A’s plugin account. A must retain its model access in that case and Agent B must retain its plugin access. If stock OpenShell cannot enforce a required boundary, keep that profile unavailable and name the missing sender capability in the implementation PR.
