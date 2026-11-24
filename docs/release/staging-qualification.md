---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Qualify a published release for staging

## Overview

Choose the evidence you need from **Staging Release Qualification**:

| Mode                         | Inputs beyond the candidate publication    | Success evidence                                       | Limit                                                          |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| Startup                      | None                                       | `staging-qualification.json`                           | Controller/runtime startup on Linux amd64; no install.         |
| Controller pair              | Complete previous publication tuple        | `staging-pair-images.json`, `staging-signin-plan.json` | Input preparation only; previous runtime stays fixed.          |
| Disposable sign-in rehearsal | Previous tuple and `rehearse_signin: true` | `staging-signin-qualification.json`                    | Sequential installed controller replacement in disposable k3d. |

[Run the workflow](#execution) with the candidate source SHA, publication run ID,
and exact attempt. No mode promotes a release or proves staging or production
readiness. If a run fails, inspect its retained evidence and correct the cause
before a new dispatch.

<a id="when-it-runs"></a>

## Trigger

Dispatch from protected `main` in `openclaw/openclaw-enterprise`. Runs for the
same configured Installation share a concurrency group; later dispatches do not
cancel active runs. This is not a PR merge gate.

<a id="run-it"></a>

## Execution

1. Configure the main-only `staging-qualification` environment with
   `STAGING_INSTALLATION`, `GHCR_CONTROLLER_IMAGE`, and `GHCR_RUNTIME_IMAGE`.
   The Installation ID is 1–63 lowercase letters, digits, or hyphens, starting
   with a letter. Image names are explicit `ghcr.io/openclaw/...` repositories
   without tags or digests.
2. Dispatch [Staging Release Qualification](../../.github/workflows/staging-qualification.yml)
   on `main` with `installation` (equal to the configured ID), full lowercase
   `source_sha`, `publication_run_id`, and `publication_attempt`.
   Use a successful ordinary Enterprise Containers publication on `main` with
   its unexpired receipt, successful image job, and exact successful source CI.
   Private/internal packages and preparation-only artifacts are ineligible.
3. Select a mode from the table. Require its success evidence and successful
   cleanup. An early failure does not produce a qualification receipt.

## Scenarios

Startup runs trusted `images-packaging` and `images-runtime-startup` checks
against the pulled controller and runtime. Missing, failed, or skipped cases
fail qualification.

### Source and credential constraints

The trusted workflow validates source ancestry, producer run/attempt, CI,
artifact metadata and hash, publication receipt, image digests, platform, source
labels, and approved Node base before startup. Only workflow source executes on
the host; historical source supplies inert recipe data. Supported runtime recipes
are the current Codex 0.164.0 profile and reviewed 0.163.0-alpha.2 source
`54bfa7fc1b99e362450beb5f9211e164991fa7b4` with its pinned recipe hash.
Other recipes fail before pulls. The receipt, recipe, and trusted packaging
manifest must agree on the Node base. Dispatch IDs must be positive safe decimal
integers. The artifact archive must contain exactly one regular file of at most
1 MiB; the decoder reads only `publication.json`, limited to 64 KiB. It does
not extract files or receive GitHub tokens.

The runner records the workflow SHA as the test source and the historical image
source separately in the pull receipt. It verifies each pulled Linux amd64 digest
and source label, then passes the exact local image IDs to trusted startup tests.

The job uses `packages: read` for digest pulls, removes GitHub tokens before
image operations, and removes its private Docker config before inspection.
Historical images receive isolated fixture mounts, not the runner workspace,
Docker socket, or Actions credentials. No staging cluster or provider credentials
are needed.

## Prepare a controller pair

Add all three inputs: `previous_source_sha`,
`previous_publication_run_id`, and `previous_publication_attempt`. A partial
tuple fails. The candidate and previous publications must be distinct, ordered
`main` commits with successful exact CI and retained receipts. Pair seals must
include platform manifest and config digests. The job pulls two controllers and
the previous runtime, checks their identities, and refuses a Docker store without
platform descriptors.

The pair must match a reviewed controller reader profile and migration tree.
The current v3 profile is
`7e1ac6d88e3893c3d4e6444fb3b9b9776519a3fb`; both releases must match its
production-input projection. A changed projection requires a new review.
The qualification workflow's runtime recipe, Node base, chart, and harness must
also remain compatible. Publish the preparatory release before protocol
activation: Enterprise Containers cannot later publish an unselected historical
commit. Choose a dedicated image alias unless updating `latest` is intended.
Run while both 30-day receipts remain available.

The two pair artifacts survive a later rehearsal failure. They prove preparation,
not startup, callback behavior, rollback, or availability.

## Rehearse installed sign-in

With the pair inputs, set `rehearse_signin: true`. The job installs the pair on
a disposable Linux/amd64 k3d runner with a local database and synthetic HTTPS
identity provider. Both controller digests and the unchanged runtime digest must
be reachable from the node. The job also checks the exact PostgreSQL and Node
support images and builds its fixture CLI from the trusted workflow checkout.
The two controllers share a populated database and one issuer. It needs no
application, model, or operator-cluster credentials.
For the reviewed v3 pair, it checks forward and return replacement, one-use
collection, replay refusal, and expiry with positive lifetime at issuance.
It does not establish the historical v2-to-v3 transition.

A passing case, complete transition evidence, normal runner exit without surviving
descendants, and confirmed cluster cleanup are required for the success receipt.
Ambiguous ownership blocks automatic cleanup. No raw identity-provider material,
cluster config, or session data is uploaded. The case does not measure ingress
availability or qualify overlapping writers.

## Results and limits

Startup retains `staging-pulled-images.json`,
`staging-images-packaging.json`, `staging-images-runtime-startup.json`, and
`staging-qualification.json` when produced. Preparation, tests, and cleanup
must all succeed before the success receipt is written. An early preparation
failure can retain only the pull receipt; it cannot invent suite results. Rehearsal failures retain private `case-result.json` and supervisor
status without qualification. Neither path proves installed Agent workflows,
arm64 behavior, production readiness, or a rollout. See [CI](../testing/ci.md)
for separate installation and provider coverage.

## Files

- [Workflow](../../.github/workflows/staging-qualification.yml)
- [Qualification command](../../scripts/ci/staging-qualification.ts)
- [Packaging](../../scripts/ci/test-suites/images-packaging.json) and
  [startup](../../scripts/ci/test-suites/images-runtime-startup.json) manifests
