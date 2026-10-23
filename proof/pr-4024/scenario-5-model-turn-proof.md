# Scenario 5 — Full model turn through the external gateway (final proof)

**Result: PASSED.** A complete end-to-end model turn through the external OpenShell
gateway with OIDC authentication: platform startup → workspace creation → credential
registration → sandbox provisioning → Codex harness boot → model probe → model turn
→ agent response.

## Evidence

The agent `oc4024-final-proof` (dedicated Codex harness, model `gpt-6-astra`)
responded to the prompt "Reply with exactly the word: pong" with:

```
pong
```

(first-agent output: `Model response verified: FIRST_AGENT_a49b7323-831c-4540-8a9c-100f7b7f828a`)

### Supervisor logs: model endpoint routing

The Codex binary connects to the real model endpoint (enmaas, not `api.openai.com`):
```
ALLOWED codex(0) -> api.enmaas.devshift.net:443 [policy:_provider_oce_cs_...]
ALLOWED POST https://api.enmaas.devshift.net/v1/responses [policy:_provider_oce_cs_... engine:l7]
```

### NetworkPolicy evidence

The harness egress policy (`allow-openshell-harness-egress`) admits the agent
gateway's connection to the bridge Service using the external gateway's endpoint
address (172.31.42.250/32), not the bridge's ClusterIP — most CNIs (including k3d's
kube-router) evaluate NetworkPolicy after the Service ClusterIP is DNAT'd to the
Endpoints. Tested both on the live cluster: the ClusterIP-based ipBlock was refused
(ECONNREFUSED); the endpoint-based ipBlock connected.

### Sandbox pods (all Running)
```
gateway-22fc0d97d26b-c848d75b5-srn9b    1/1  Running  0  60s
os-0b106e0c07304f77                     1/1  Running  0  63s
os-supervisor-0eb6b67b-...              1/1  Running  0  63s
```

### Additional configuration required

The model turn additionally required:
1. `runtime.modelProvider` in the Installation's compute driver configuration set
   to the custom model endpoint (the OCC compute driver defaults to
   `api.openai.com/v1` for the codex harness).
2. The credential source's `authorized_base_url` set to the same custom endpoint
   (both must match for the deploy-time validation to pass).
3. The external gateway's TLS certificate to include `*.openshell.localhost` as a
   SAN (the harness WebSocket uses the sandbox's advertised `*.openshell.localhost`
   hostname, which the certificate must cover).

These are the same requirements as the in-cluster profile; the first-agent helper
does not set them for custom endpoints.
