# Diagnose native permission refusals in OpenShell tests

After the real Driver classifies a Codex PAT permission refusal, the fixture
collects one diagnostic per revision before rethrowing that failure. One
connection through the same OpenShell exposure reads requirements and PAT status,
then requests an ephemeral `:danger-full-access` thread with user review.

The receipt compares approval/profile requirements and the returned profile,
reviewer, approval policy, ephemeral flag, and legacy sandbox representation.
`accepted` requires matching permission settings and an ephemeral thread; unconfirmed profile provenance is
`unconfirmed`, and different settings are `mismatch`. RPC errors do not establish
a policy denial. Receipts include the fixture revision ID and fixed phase,
outcome and cleanup classifications. Peer fields contain known enums and boolean
or null comparisons; credentials, account details, instructions and peer text are excluded.

For a mismatching grant, `permissionProfileFallback` records whether the selected
Harness logged a native permission-profile fallback warning. `observed` includes
sorted, deduplicated source categories; `unobserved` means the returned logs had no
matching warning, and `unavailable` means collection could not be completed or
attributed safely. Composite sources remain composite, and unknown sources remain
unknown. Raw logs, paths, managed identifiers, policy contents and errors are omitted.

The fixture reads only the `agent` container of one Pod matching the
Namespace, Agent and revision. Before and after the read, it verifies that the
revision's Sandbox controls that Pod by API version, name and UID, and that the
Sandbox, Pod and container identities are unchanged. Its kubectl processes receive
only `PATH` and `HOME`; kubeconfig and context are explicit arguments.
The log window starts at the diagnostic thread request;
collection has a shared five-second deadline and a 128 KiB limit. Log timestamps preserve the
millisecond cutoff that kubectl's request reduces to seconds. A warning identifies
the container and time window, without a per-RPC correlation identifier.
Missing or truncated logs, clock differences and an absent warning leave the
requirement's provenance unresolved. Offline native and simulated Kubernetes API
checks do not establish installed or hosted collection.

No diagnostic model turn or approval response is sent; ordinary runtime startup
still performs its authentication probe. The exchange has ten seconds, socket
cleanup two seconds, and output one second. Cancellation preserves an already
classified Driver failure without changing worker claim-loss handling. Normal
candidate teardown owns thread cleanup; socket closure does not prove removal.

The [diagnostic](../../tests/helpers/openshell-permission-diagnostic.ts),
[Kubernetes fixture](../../tests/helpers/openshell-kubernetes-real.mjs) and
[installer workflow](../../tests/helpers/openshell-sandbox-workflows.mjs) own this
collection. Return to [OpenShell coverage](openshell-coverage.md#native-permission-refusals)
for the suite's other proof boundaries.
