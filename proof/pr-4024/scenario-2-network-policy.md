# Scenario 2 — live NetworkPolicy enforcement for the new egress rules

**Result: passed.** The issuer deliberately runs on a different address and
port than the gateway, so the two egress rules this PR adds are provable
separately.

## Expected

The profile's enforcing NetworkPolicies admit the control-plane pods to
exactly the gateway's gRPC port and the issuer's token port, and refuse the
same hosts on any other port.

## Probes (from the worker Pod, selected by the policy)

| Probe | Expected | Actual |
| --- | --- | --- |
| `https://<issuer>:8443/realms/oc4024` with the mounted CA bundle | allowed | `200` |
| `http://<gateway>:8081/health` (health port, not admitted) | denied | `ECONNREFUSED` |
| `http://<gateway>:9090/metrics` (metrics port, not admitted) | denied | `ECONNREFUSED` |

Control from the host (not selected by the policy): the same gateway health
and metrics ports answer `{"status":"healthy",...}` and `200`, so the refusals
above are the policy, not the gateway. The k3s CNI rejects rather than drops,
hence `ECONNREFUSED` instead of a timeout.

## The rendered policy (from the cluster)

```yaml
# openclaw-enterprise-openshell-egress (namespace oc4024-system)
egress:
- ports: [{port: 8080, protocol: TCP}]
  to: [{ipBlock: {cidr: <gateway>/32}}]
- ports: [{port: 8443, protocol: TCP}]
  to: [{ipBlock: {cidr: <issuer>/32}}]
podSelector:
  matchExpressions: [{key: app.kubernetes.io/component, operator: In, values: [api, worker]}]
  matchLabels: {app.kubernetes.io/instance: openclaw-enterprise, app.kubernetes.io/name: openclaw-enterprise}
policyTypes: [Egress]
```

```yaml
# allow-openshell-sandbox-callback (applied in the workspace namespace)
egress:
- ports: [{port: 8080, protocol: TCP}]
  to: [{ipBlock: {cidr: <gateway>/32}}]
podSelector:
  matchLabels: {openshell.ai/boundary-role: supervisor, openshell.ai/managed-by: openshell}
policyTypes: [Egress]
```

The supervisor callback policy is rendered and applied, but no supervisor
existed to traverse it (see Scenario 4).
