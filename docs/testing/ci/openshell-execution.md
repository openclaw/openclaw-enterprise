# OpenShell CI preparation and timing

Use this page to interpret setup costs and first-Agent results from the
[QA Matrix Advisory OpenShell jobs](qa-advisory.md#openshell-file-coverage).
For triggers and invocation, start with that workflow page.

## Hosted preparation

Full advisory OpenShell runs use one Ubuntu 24.04 runner per file from the
[OpenShell manifest](../../../scripts/ci/test-suites/openshell.json). The files run in
parallel across separate VMs, with at most ten OpenShell jobs active.
Gateway policy, network policy, credential replacement, live withdrawal, upstream outages, and
Gateway/OAuth recovery use separate installations and databases. Each workflow
keeps its dependent operations serial, including recovery before later assertions.
The upstream workflow replaces the Harness used by its positive model turns before
redirecting DNS to the untrusted TLS receiver. It requires a rejected handshake
at that receiver, with no completed handshake or HTTP request.
OAuth expiry and model failure bounds are unchanged. The shared
[scenario implementation](../../../tests/helpers/openshell-sandbox-workflows.mjs)
registers only the workflow selected by each test entry point. The two first-Agent files provision and clean up
through Local Setup. Hosted focused preparation restores the main-only BuildKit
caches and builds current-checkout images, without creating a second cluster,
database, routing setup, OpenShell installation, or Keycloak instance. The
Kubernetes case selects the resulting immutable controller/runtime pair. The
builder pushes cached layers directly to an owned loopback registry, without
loading or recompressing the images in the host engine. Both profiles import the
runtime from that registry. Compose also selects the verified development controller
by digest through a Compose override that removes inherited builds. All five
controller-side services share this image; Compose pulls it once instead of
rebuilding/loading per-service images. Cleanup removes only the recorded owned
controller reference. This selection is test-only
(`OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE`); local and setup-shard defaults
still build the controller from the checkout. With a selected runtime, Docker Compose overlaps
database/bootstrap work with cluster setup after creating its owned network.
Kubernetes prepares OpenShell assets after image imports while network probes
finish. Both profiles join preparation before starting the control plane. Local Setup
keeps unselected controller/runtime source builds serial. See the [development flow](../../flows/docker-compose-development.md#4-start-and-clean-up-kubernetes-development).
The installer file also owns its stack, so hosted preparation does not create an
unused cluster or database for it. Instead, it primes its job-owned BuildKit builder
from the read-only cache. The real installer still builds from the checkout, with
the same builder and automatic engine loading. Hosted installer children also
use preparation's fixed `SOURCE_DATE_EPOCH=0`; otherwise [BuildKit invalidates
WORKDIR and subsequent cache entries](https://docs.docker.com/build/cache/invalidation/#workdir-and-source_date_epoch). Local installation and QA-matrix jobs use the
same approach. Source-build preparation materializes layers on that builder even when the
host engine already holds an identical image. The model-provider installation
fixture uses the same selected builder for its checkout images. Cache credentials
are not passed to tests. Other OpenShell files
prepare their required cluster, database server, routing, and images; their image
builds now read the same cache. The runner enforces both lane-wide and per-file `requiredEnv`
inputs, expected cases, and cleanup. A failed shard does not cancel the
others. Each result has `scope: focused`; require every shard to pass before
claiming full advisory OpenShell coverage. Full Integration runs two complete OpenShell lanes on separate VMs.
Each prepares its own shared resources and runs its assigned manifest files
serially. The Full Integration Aggregate requires both results for the same
checkout revision. First-Agent files do not request a separate CI database
in either mode.

## Cache and runner limits

Cache credentials are available only to preparation, and the cache is read-only
for these jobs. A cache miss builds the current source; it does not select an
older image. The development target shares common controller layers but its leaf
is not supplied by the main runtime-target cache. Build, image publication,
installation and cleanup time all count toward the job duration. Report cold
and warm results separately, including any prerequisite warm/build time. Local
runs and the setup shard retain the source-build installer path.

OpenShell jobs use the guarded hosted disk-capacity check before image work.
It skips removal when at least 36 GiB is available and preserves the Go and
Python toolchains. Its receipt records capacity and removal duration. An explicitly
selected installed browser is validated by a sandboxed launch and page evaluation;
these jobs do not install an unused Playwright browser alongside it.

## Interpret timing and proof

First-Agent stage measurements appear in `files[].measurements`: Local Setup,
initial deployment and model calls, reuse after changing only the request nonce, native deployment, native
model execution, native redeployment, resumed model execution, and cleanup.
Each record contains only a fixed stage, outcome, and elapsed milliseconds.
The parent test duration includes its native subtest; do not add them together.
After setup, the test verifies the existing default Namespace and overlaps the
distinct Codex and native Agents. Each keeps its own credentials, Configuration,
identity, and session proof. Both operations settle before shared mutation and
denial checks or stack teardown, including cancellation. Capacity samples report
CPU count, minimum free memory and maximum load while the scenarios run.

First-Agent command profiles summarize the Local Setup CLI timing records for
setup and cleanup. The CLI times
real Docker builds, Compose builds/startup, image pulls/exports/imports, cluster
creation, Helm installation, and Kubernetes readiness commands. Records contain
fixed categories, counts, elapsed milliseconds, and nonzero exit counts. Retry
attempts are counted individually; failure handling stays unchanged. Arguments, output, environment values, and
resource names are excluded. Concurrent or nested commands can overlap, so do
not sum these durations as wall time. Fixed setup milestones record offsets from
startup to place these operations on the wall-clock timeline. OpenShell asset
preparation reports its failed operation, such as chart acquisition, rollout,
workspace rendering, or image import, with elapsed time measured from that
operation’s start. Success reports the total preparation time. A failed operation
may reflect cancellation by another setup task; it does not establish the primary
cause. These records exclude error text, arguments, and output. Native Pod profiles
report time from the
deploy request to Pod creation and time from creation to scheduling,
initialization, running, readiness, and observation. They retain no Pod identity
or configuration. Pod readiness timing does not replace the model and required
worker proof.

Native first-Agent proof retains the exact run ID, explicit successful exec flag,
standalone tool-proof line, and exact final nonce. After a turn is terminal, history
has 30 seconds to settle; a missing proof remains a failure. Failure diagnostics
retain counts and flags, plus the numeric exit code (0–255) when a single nested
exec result is recognized. The proof program reports fixed operation and error
categories for failed session-file writes, session/workspace-file reads, or proof
emission. These categories contain no paths, commands, raw output, or stacks;
unknown error codes become `other`. A failure before Node starts, or without a
recognized failure marker, remains unclassified. These observations do not relax
any success predicate. Content
shape counts distinguish strings, arrays, recognized text and tool-call parts,
and unsupported parts. Exec observations distinguish an exact requested command,
nonempty output, and the recognized `value.aggregated` result envelope from other
JSON. Read the nonempty-text, marker-containment, and strict-match counts together:
they show whether the helper recognized text, found the marker anywhere in it,
or found it in the required form. These counts aggregate the run; they do not
identify the cause of an individual mismatch or relax the proof requirements.
An unrecognized shape remains a failed proof.
This settling bound does not reduce the model-execution budget or count a failed
proof as a performance improvement. Before a turn, placement polling retries only
a correlated `UNAVAILABLE` response with the pinned Gateway's explicit
read-generation invalidation message. All other describe rejections fail with
allowlisted error classification; they are not converted to an assertion that
loses the cause. The same session identity and active placement remain required.

## Workflow duration and cost

Compare the full workflow, not one successful shard. Require every selected job,
expected case, and cleanup to pass at the same checkout revision. Include tool
setup, image builds/imports, tests, cleanup, and artifact upload in elapsed time.
Report runner allocation and protected-environment waiting separately, and keep
failed or canceled runs separate from successful runtime measurements.

The job summary records phase timings for each physical lane: `openshell`,
`openshell-policy`, or `openshell-installers`. Use the receipt's lane, source SHA,
run ID, and attempt to compare matching jobs. The same JSON is retained for seven
days as `timing-<artifact-prefix>-<lane>-attempt-<attempt>`. Its elapsed time
covers the lane action through result artifact upload; it excludes earlier checkout and runner or
environment waiting. Missing checkpoints remain missing measurements.

Parallel workflows repeat installation setup and can use more runner minutes
even when wall time falls. The OpenShell job cap bounds concurrent VMs; each
security workflow keeps model calls serial. Existing model request deadlines,
retry rules, and provider rate limits still apply. A cache miss builds current
source and can exceed a warm-run timing target. Successful test-file durations
are in the result artifacts; preparation timings and cache outcomes are in the
job log. Do not count a failed proof or a missing case as a speed improvement.
