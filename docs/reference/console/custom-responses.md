# Use custom Responses endpoints in Create Agent

Choose **Custom (Responses API)**, enter an HTTPS endpoint ending in `/v1`, and
enter the model ID manually. The browser does not contact the provider. Changing
the provider or endpoint clears the key and model.

Supply a separate endpoint-specific key, or select a Secret whose immutable
`authorizedEndpoint` matches the normalized endpoint. Permission to operate a
shared Secret does not authorize another destination. Admission and provisioning
reject mismatches. Direct delivery exposes the key to the Harness and does not
restrict it to that hostname; Agent egress is unchanged.

For Dedicated Codex or native OpenClaw, you can select an existing API-key
Credential Source with an explicit `base_url`. Its endpoint is read-only. Native OpenClaw also requires the
model's context window, output limit, and cost values; obtain them from the
provider. OCE does not infer them. Source registration follows the
[Gateway destination contract](../drivers/credential-gateway.md).

Embedded OpenClaw uses `custom/<model-id>` and `OCE_MODEL_API_KEY`. Dedicated
Codex uses its existing Responses transport. An Installation-configured custom fallback
also requires a matching endpoint-authorized key. URL acceptance does not qualify a
provider's streaming or tool-call support.

Return to [Create and deploy Agents](create-and-deploy.md).
