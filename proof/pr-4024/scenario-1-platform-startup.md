# Scenario 1 — `occ dev up` against an external gateway and a real IdP

**Result: passed with a finding** (the finding is Scenario 4's provider-Harness gap;
everything this scenario covers worked).

## Commands

`./scripts/dev-up` with `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`,
`OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell`, the four
`OCC_DEVELOPMENT_OPENSHELL_*` external-gateway inputs, and
`OCC_DEVELOPMENT_OPENSHELL_CA_FILE`. Expected: the launcher skips the in-cluster
gateway and its images, renders the OIDC Backend, and the platform starts with the
bootstrap Namespace ready. Actual: it did.

## Key evidence (launcher log)

```
OpenShell sandbox image: source=ghcr.io/nvidia/openshell/sandbox:0.1.5@sha256:e9adf9ecde328122414ad2ee8c6fc5d5b389e4cf168daf4357c46f5a77d55851 containerd=docker.io/openclaw-development/openshell-sandbox@sha256:d60222e1183ad3212436507c4b9035c0aeda1c1bba4a00a02ec7949fb0a0d7b2
OpenShell supervisor image: source=ghcr.io/nvidia/openshell/supervisor:0.1.5@sha256:fabcd01f656e9d23df4386f82e80b4f48b90f3452d7d5c58889007643a069161 containerd=docker.io/openclaw-development/openshell-supervisor@sha256:07cc8b62b34a0b54a3ebeb485cebe9f223cffe10dad819af550849cf0699816f
Installing OCE in Namespace oc4024-system...
networkpolicy.networking.k8s.io/openclaw-enterprise-openshell-egress created
Service key file: /tmp/oc4024/state-parent/state/initial-admin-service-key.json
Administrator: admin@development.openclaw.invalid
```

Note "Installing OCE in Namespace" (not "Installing OpenShell Gateway and OCE"):
the in-cluster gateway install and readiness gate are skipped, while the
supervisor and static sandbox launcher images are still imported for the
gateway's driver to use in the launcher cluster.

## Key evidence (external gateway log)

```
2026-10-29T18:31:49.147688Z  INFO openshell_server::cli: TLS enabled — listening on encrypted HTTPS
2026-10-29T18:31:49.147856Z  INFO openshell_server::cli: OIDC authentication enabled
2026-10-29T18:31:49.313229Z  INFO openshell_server: OIDC JWT validation enabled (issuer: https://<issuer>:8443/realms/oc4024)
2026-10-29T18:32:21.334097Z  INFO openshell_driver_kubernetes::driver: operator namespace added to allowlist namespace="oce-395e5274d09f28d"
2026-10-29T18:32:22.632676Z  INFO request{method=POST path="/openshell.v1.OpenShell/GetWorkspace" request_id="a4570df5-8cf7-4950-a704-3874bd5bcb41" otel.name=openshell.v1.OpenShell/GetWorkspace otel.kind="server" rpc.system="grpc" rpc.service="openshell.v1.OpenShell" rpc.method="GetWorkspace" http.response.status_code=200 rpc.grpc.status_code=5 otel.status_code="ERROR"}: openshell_server::multiplex: response status=200 latency_ms=2
2026-10-29T18:32:22.680774Z  INFO request{method=POST path="/openshell.v1.OpenShell/CreateWorkspace" request_id="01380a45-9957-4c1a-be63-1427896c5fad" otel.name=openshell.v1.OpenShell/CreateWorkspace otel.kind="server" rpc.system="grpc" rpc.service="openshell.v1.OpenShell" rpc.method="CreateWorkspace" http.response.status_code=200}: openshell_server::multiplex: response status=200 latency_ms=43
```

The real v0.1.5 gateway: TLS on, OIDC validation against the real Keycloak
issuer, the launcher's workspace namespace discovered through the
`openshell.ai/openclaw-workspace` label, and the control plane's
GetWorkspace (NOT_FOUND) then CreateWorkspace calls completing over the
OIDC-authenticated connection.

## Key evidence (worker log)

```
{"severity":"INFO","time":"2026-10-29T18:32:16.409Z","service":"occ-worker","event":"worker.completed","workId":"namespace:ns_f0721b15-23a4-49de-828d-0e191242ad44:reconcile:ready","attempt":1,"operation":"namespace.ensure","namespaceId":"ns_f0721b15-23a4-49de-828d-0e191242ad44","result":"pending","outcome":"pending","code":"NAMESPACE_INCOMPLETE"}
{"severity":"INFO","time":"2026-10-29T18:32:17.260Z","service":"occ-worker","event":"worker.completed","workId":"namespace:ns_f0721b15-23a4-49de-828d-0e191242ad44:reconcile:ready","attempt":1,"operation":"namespace.ensure","namespaceId":"ns_f0721b15-23a4-49de-828d-0e191242ad44","result":"pending","outcome":"pending","code":"NAMESPACE_INCOMPLETE"}
{"severity":"INFO","time":"2026-10-29T18:32:18.463Z","service":"occ-worker","event":"worker.completed","workId":"namespace:ns_f0721b15-23a4-49de-828d-0e191242ad44:reconcile:ready","attempt":1,"operation":"namespace.ensure","namespaceId":"ns_f0721b15-23a4-49de-828d-0e191242ad44","result":"pending","outcome":"pending","code":"NAMESPACE_INCOMPLETE"}
{"severity":"INFO","time":"2026-10-29T18:32:19.918Z","service":"occ-worker","event":"worker.completed","workId":"namespace:ns_f0721b15-23a4-49de-828d-0e191242ad44:reconcile:ready","attempt":1,"operation":"namespace.ensure","namespaceId":"ns_f0721b15-23a4-49de-828d-0e191242ad44","result":"pending","outcome":"pending","code":"NAMESPACE_INCOMPLETE"}
```

The bootstrap Namespace reached `ready` after the sandbox driver's workspace
setup completed through the external gateway.
