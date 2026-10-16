# Gateway outbound validation

Use the suites below to distinguish approval, persistence, transport and runtime
proof. Operator settings belong in the [feature reference](../reference/gateway-outbound.md).

## API and persistence

```sh
node --test tests/integration/console-api.test.mjs
node --test tests/conformance/platform-state-memory.test.mjs
```

The actual Fastify/OCC/IAM tests exercise exact-Agent update plus administer,
ordinary edits after ceiling tightening, deployment admission and immutable
snapshots. The fixture replaces workload provisioning; these cases do not prove
Kubernetes enforcement.

Follow [PostgreSQL setup](postgresql.md), migrate a new disposable database as
`occ_migrator`, then run the Gateway case in
`tests/integration/postgres-platform-state.test.mjs` as `occ_app`. It checks
persisted approval, database shape/topology constraints, the limited update grant,
and immutable admitted state. The migration compatibility suite separately checks
canonical source hashes and actual PostgreSQL catalog/history behavior.

## Real proxy transport

```sh
OCC_TEST_GATEWAY_OUTBOUND_PUBLIC=1 \
  node --test tests/integration/gateway-outbound-proxy.test.mjs
```

The default suite uses real local sockets and OS DNS. The explicit selector adds
certificate-verified public HTTPS requests, idle tunnel behavior, clean EOF and
established-tunnel shutdown. A selected public lane fails on unavailable networking;
it does not silently skip. This variable selects contributor proof and is not an
operator setting.

The suite does not prove native Gateway behavior, cluster NetworkPolicies, Slack
Socket Mode, arbitrary plugin transports, or deterministic mixed-address DNS and
rebinding scenarios. Address vetting and one-resolution literal connection are
also reviewed in source; do not label that inspection as runtime rebinding proof.

## Kubernetes and Console

Use the existing [production topology prerequisites](kubernetes.md) with a
fresh controller image containing this change, the explicitly pinned stock native
runtime, an enforcing owned k3d cluster, and a dedicated migrated `openclaw_k8s_*`
database. Prepare ownership with the existing gateway-routing or k3d-model lane
and allocate this file’s database through `prepare.mjs --file`. Set
`OCC_TEST_OPENAI_MODEL` explicitly for the test process to an authorized model;
preparation does not save that input in the file environment. Then select:

```sh
OCC_TEST_GATEWAY_OUTBOUND_K3D=1 node --env-file=<prepared-file-env> --test \
  --test-name-pattern="production dedicated Gateway outbound" \
  tests/integration/harness-topology-k3d-real.test.mjs
```

The existing `k3d-model` lane requires this case. Record image IDs, the source
revision, allowed/denied requests and lifecycle results. Fixture manifests or SDK
client doubles do not prove actual network isolation or native plugin execution.

For a revision with both Gateway access and an admitted public GitHub reader,
verify that terminal refusal starts both withdrawals even if one Kubernetes delete
fails. Restart the worker while withdrawal is pending, restore authority and prove
that neither access route repairs. Completion requires the exact proxy Pods and
reader Harness to terminate. Qualify this composition on the refreshed source;
separate earlier passes do not establish the combined outcome. Protected Harness
and Credential Proxy compositions remain unqualified.

Storybook **Pages/Agent detail** includes Gateway Network, Restricted, Empty,
Read Only, Disabled, Embedded, Loading and Error scenarios. Rebuild from current
source, inspect the previews and walk through editing, saving and deploying.
Capture screenshots and a short video outside the checkout; attach them to the
PR. Storybook is simulated UI proof and does not establish backend persistence,
credential delivery, proxy readiness, or model execution.
