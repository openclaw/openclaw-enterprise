# Protected static inference

Select the Credential Proxy Driver only with a Kubernetes Compute and OpenShell pair that
enforces the whole-execution profile below. The security principal is one freshly
admitted Agent execution. Its parent, a sibling and an ordinary client can use the
same allowed operation. A different execution, even of the same Agent, cannot
inherit that authority. There is no caller binary allowlist or client hook.

The bundled legacy OpenShell release cannot enforce this profile. Before using a
candidate pair, [qualify its installed dispatch and response custody](../../testing/protected-repository-custody.md)
and test the actual static inference path. A repository metadata read exercises the
shared exchange but does not establish static inference or Git transport support.

## Execution admission cutoff

A fresh revision records its execution admission, including whether it is protected.
A protected plan with no bindings means deny all, including direct networking.
Readers that cannot interpret the decision refuse the revision. Other Compute
implementations refuse protected admission. See the
[developer upgrade and withdrawal procedure](../../guides/deploy/protected-egress-development.md)
before migrating an installation with running Agents.

Kubernetes Compute waits for the authenticated current installation, records it and
rechecks it before signing a fresh startup challenge with its control-plane Ed25519
key. The workload gets only the verifier. If startup or the serving check cannot
establish the admitted installation, the execution stays unavailable. For a prepared
credential, the source can be configured and a revision requested while the source's
`status.state` is `pending`. Compute waits for the exact family to be warm before
releasing the workload, then for the Harness to report `serving` before reporting ready.
If the revision never becomes ready, deployment status reports the convergence timeout.
Only the preparation worker can warm the family; startup, readiness and requests cannot.

## Loaded enforcement

The OpenShell Gateway and trusted supervisor must report credential access,
installation exchange, response custody and whole-execution authority, in that order.
Credential Proxy compares the current source and effective policies, installation and
supervisor identity. A loaded policy, executable-scoped capability, bearer or
historical receipt cannot establish this authority.

The supervisor accepts the downstream response recipient before resolving a
credential. It signs the exact opening, including ephemeral response custody,
on the bidirectional installation exchange. All subsequent decisions belong to that
stream. One required exchange owner verifies identity, captures the request origin
and checks live response custody. Credential Proxy snapshots the bounded request
before asynchronous verification. Credential reads share cancellation and an
absolute deadline; nested Kubernetes reads cannot extend either bound, and an
expired deadline prevents HTTP dispatch even before its timer fires.
Closing the stream cancels pending access. Both before material access and before
send, OCC checks the current installation, binding, withdrawal and native IAM
permission. An acknowledged authorization of the exact dispatch releases one permit.
If the COMMIT reply is lost, the origin might have been reachable, but no permit or
retry follows. Retain that uncertain receipt.

## Static source and response policy

The static OpenAI profile admits an explicitly configured model and a closed set of
text inference requests. Unsupported operations, remote provider tools, arbitrary
model selection and discovery are refused before reading the Secret. The trusted
sender injects the selected version. Neither the Agent nor the admission snapshot
receives its value.

Static provider generation two identifies whole-execution authority. A generation-one
grant remains narrower. Adopting live material and authorizing the broader execution
are explicit, separate decisions; a Secret edit grants neither. The first cutover
requires an unbound source and an explicitly admitted new binding. Leave an existing
approved copy available until its owner can make that transition safely.

The supervisor withholds the complete bounded response, including the last trailer,
until Credential Proxy permits its release. Policy can remove or block provider bytes even
after the origin acted. A positive credential rejection fences only that material
version. An observed response or a decision to release bytes does not prove delivery
to the Agent and cannot authorize a replay.

Response protection checks joined assistant text in envelopes, independent items,
and added-item seeds extended by streamed deltas. Safe projections may disagree;
accepted response bodies retain their original bytes. In addition to raw text,
protection checks the selected assistant consumer's literal, nonnested citation
projection: `<oai-mem-citation>` through `</oai-mem-citation>` is hidden, with an
unclosed citation hidden to the end. It also checks that projection in plan mode:
a standalone `<proposed_plan>` line starts a nonnested hidden block ending at a
standalone `</proposed_plan>` line or end of text. Tag lines use Unicode White_Space
trimming and are removed with their newlines. Inline tags and unmatched closing
tags remain text.
Check the Plan itself, too. Codex extracts a completed Plan before removing
citations, but can build a streamed Plan from deltas across several assistant
items. If pending parser tails could change their order, withhold the response.
These checks cover the named views of one finite response, not arbitrary future
client transformations; they do not reinterpret function-call argument data.

## Installation configuration

Use the [protected local launch profile](../../guides/deploy/local-openshell-images.md#select-the-protected-profile)
and the [OpenShell Backend and Sandbox configuration](../drivers/openshell-credential-gateway.md).
Select the same Driver ID in `backend[].drivers.credential_proxy` and the
Installation's `drivers.credential_proxy` selection. Configuring only one is an
error, not a request to disable protection. Startup also rejects the retired
`drivers.conduit` key at either boundary, including when both keys are present;
use `drivers.credential_proxy` instead.
Set its middleware name and `authorityScope: execution`. Provide an authenticated
HTTPS Gateway, the authority's TLS identity and trusted Gateway issuer public key.
Keep the single authority process reachable for the whole exchange.

Prepared GitHub metadata is a separate, bodyless GET grant isolated to the named
Agent. Its optional custody and trusted issuer settings belong to the Installation
operator, not the credential source. [Credential preparation](../../flows/credential-source-refresh.md)
describes the worker, cold behavior and recovery.
