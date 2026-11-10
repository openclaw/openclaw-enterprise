# Qualify retained static credentials across a controller upgrade

Use the [connected static-egress lane](static-egress.md#select-the-prepared-connected-lane)
with an admitting controller A and the bundled retirement candidate B. Keep one
test process, provider listener, database, Namespace and running Agent across
replacement of both API and Worker. Starting the ordinary lane directly on B
cannot qualify retained traffic: B refuses its initial source creation.

## Prepare the exact pair

Meet all connected-lane prerequisites, including the five supplier capabilities,
authenticated loaded-policy evidence and immutable compatible runtime images.
Stock OpenShell 0.1.6 does not supply this profile. Missing qualified artifacts
block this proof; fixture-only results cannot replace it.

Build A and B from reviewed commits and retain independent build receipts binding
each source to its image. A must be an ancestor of B. Keep the same runtime and
supplier images, trust, owner configuration and database. Install A through the
production Helm path with exactly one API and one Worker Pod. Verify the
[controller-only upgrade prerequisites](../guides/deploy/production-upgrade.md)
and prepare its exact command before starting the test. The lane observes an
operator-performed upgrade; it does not execute scripts named in input files.

In the private connected input, `oceCommit` and `images.controller` identify B.
Add:

```json
{
  "controllerUpgrade": {
    "fromCommit": "<full admitting A commit>",
    "fromImage": "<A image>@sha256:<digest>",
    "timeoutMs": 900000
  }
}
```

Use distinct immutable images and full commits. The timeout is an integer from
60,000 to 900,000 milliseconds. This option requires
`authorityProfile: "fresh-whole-execution"`. Other inputs retain the connected
lane's contract. Run its normal command from the clean B checkout; no additional
test selector is needed. Its initial controller observation selects A.

## Replace the controllers at the checkpoint

Wait for `controller-upgrade-ready` in the private run ledger. The test first
creates and adopts sources on A, activates its protected revision, observes
packaged Codex and sibling traffic, and waits for outstanding controller work
to settle. It retains a separate unbound source and replacement Secret reference
for refusal checks.

Apply the prepared [controller-only upgrade](../guides/deploy/production-upgrade.md#upgrade-the-control-plane).
Preserve the database, source grants, installation inputs, runtime and supplier;
do not select a runtime upgrade or redeploy the Agent. Keep the test and its
provider running. During the bounded checkpoint the test only observes Kubernetes;
it sends no API or model operation through a mixed controller rollout.

The test resumes after both B application containers are ready and the original
API and Worker Pod identities are gone. It checks runtime container identities,
unchanged controller configuration hashes, supplier processes, Installation ID,
grants, source generations/references, admitted revision, installation record and
settled work. Image references prove selection; retain build receipts separately
to establish source provenance.

## Read the result and preserve cleanup

On B, valid source creation, unbound re-adoption, Secret-reference replacement
and a new deployment must return the exact retirement `409` without new work,
state changes or provider ingress. The same running packaged caller then completes
a fresh turn. Existing checks continue through IAM revocation with no provider
request or released response, regrant success, Secret-value rotation, hostile
responses, withdrawal and absence of the original Sandbox. Expected total ingress
is twenty, including the extra retained turn. Counters are never reset.

This connects installed admission, retained authority and withdrawal; it does not
prove automatic active-revision replay. Kubernetes Compute declares no periodic
maintenance interval, and the test does not fabricate a pending deployment job.
The original job is already settled. B's supported withdrawal exercises its
Worker against the retained owner. It also does not independently audit Secret
reads; source-level refusal coverage and zero provider ingress are separate facts.

Keep the run ledger and both upgrade/build receipts. Cleanup custody remains with
the same test, including unexpected successful source creation. If the checkpoint
expires or an outcome is unknown, inspect the ledger and restore API availability
before reconciling cleanup. Do not rerun a mutation to erase uncertainty. The
operator still owns disposal of the prepared outer stack. Passing this lane does
not itself discharge a review hold or establish external-model usefulness.
