# Compose fixtures and readable scenarios

Build tests from small data builders, owned resource fixtures, and explicit
behavior assertions. Keep the scenario and its expected observation visible in
the test. Use the [test audit](../../.agents/skills/test-audit/SKILL.md) to choose
meaningful coverage and the [testing guide](README.md) to select its environment.

## Choose the responsibility

| Component        | Responsibility                                                   | Useful shape                           |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Data builder     | Construct fresh protocol or domain data with explicit variations | `requestHead({ method, rawTarget })`   |
| Pure policy      | Parse, validate, classify, or transform inputs                   | `(input, policy) => outcome`           |
| Factory          | Bind explicit dependencies and return a focused capability       | `createRewriter({ rewriteUrl })`       |
| Resource fixture | Acquire resources and register their cleanup                     | `startUpstream(scope, { clock, tls })` |
| Contract suite   | Verify shared observable behavior against an implementation      | `verifyRepositoryLifetime(t, store)`   |

The signatures above illustrate the conventions; they are not a generic helper
API. A small ordinary function often supplies the needed abstraction.

Keep dependencies explicit. Use readonly dependency records in TypeScript and
pass the particular clock, transport, or operation a component consumes.
Returning a function is useful when the dependencies stay fixed across calls.
Keep resource state inside its owner; a socket or credential lifetime does not
become clearer merely by removing mutable variables.

Factories should show composition. Split policy decisions and independent
resource owners out of a large closure, while retaining a thin recipe for tests
that need the complete service. Return the capabilities and observations the
caller needs, rather than every internal object.

## Build inputs without deciding expectations

A builder supplies valid defaults and returns fresh data. Override the fields
that distinguish a case. Keep related identities consistent, and obtain opaque
handles from their real owner.

For rejection tests, deliberately violate a named invariant. Do not normalize
raw request targets, repair malformed framing, or replace invalid values with
defaults before the implementation sees them. A copied handle belongs in the
case proving that copies are refused.

The credential [data builders](../../tests/fixtures/repository-credentials/builders.mjs)
keep raw request targets intact. The
[planning fixture](../../tests/fixtures/repository-credentials/planning.mjs)
composes the real backend factory, session admission, custody, and controlled
clock for route-policy cases.

Captured state stays small and keyless. The
[released Gateway state](../../tests/fixtures/runtime-state/released-gateway-state.tar.gz)
is the state the 2026-09-28 runtime image wrote in one turn against a stub
provider. Its device identity and config revision keys were deleted and the
database vacuumed; OpenClaw creates new ones at startup. Its test comment
names the image. Regenerate it the same way.

Keep expected outcomes independently specified. A test must not calculate
expected admission using the production route classifier or duplicate that
classifier in its fixture. Fixtures may emulate an external protocol; they
must not substitute for the authorization or lifecycle behavior under test.

Use optional values for legitimate absence. Present-but-invalid input remains
an error. Keep domain outcomes such as refusal, uncertain dispatch, and pending
cleanup distinct when composing fixture operations.

## Make cases easy to add and diagnose

Use named records for repeated cases and ordinary `node:test` registration.
Each case should make its input, action, and expected observation clear. Prefer
one named subtest per case, with independent mutable state where needed.

Keep longer workflows as a short sequence of meaningful actions: open a
session, advance time, use the same client, and observe cleanup. Explain
non-obvious ordering with a concise intent comment. A hidden scenario
interpreter or an expanding set of boolean options usually obscures that story.

Share a contract suite when multiple implementations promise the same behavior.
The existing
[repository lifetime suite](../../tests/conformance/repository-lifetime.contract.mjs)
runs common observations against memory and PostgreSQL adapters. Keep
implementation-specific expectations in their own cases; do not silently skip
incompatible assertions to make one suite fit everything.

Fixture imports should not register unrelated tests as a side effect. Invoke
contract registration explicitly from a selected test entry point.

## Own resources and time

Register cleanup when a local resource is acquired, including resources created
before setup finishes. Release resources in dependency order: stop admission,
drain dependent operations while their upstreams remain available, then close
listeners and remove owned files. Attempt remaining cleanups after a failure and
retain both the primary failure and cleanup failures.

The credential [resource scope](../../tests/fixtures/repository-credentials/resources.mjs)
registers local cleanup, runs it in reverse acquisition order, and retains
setup and cleanup failures. Its
[service resource owners](../../tests/fixtures/repository-credentials/service-resources.mjs)
show how to register key and service cleanup around real implementations.

For a remote creation request, establish the cleanup or reconciliation
obligation before dispatch. A lost response does not prove that creation failed
and does not authorize replay.

Keep cleanup bounded and join owned processes and sockets. A timeout is not
successful disposal. The existing
[process fixture](../../tests/fixtures/repository-credentials/process.mjs)
provides bounded command execution, temporary directories, TLS material, and
listener cleanup for credential tests.

Inject time through trusted composition. The
[controlled clock](../../tests/fixtures/repository-credentials/clock.mjs)
keeps wall and monotonic time separate and exposes scheduled work. Use a fixed
initial time for reproducible cases, and retain a real-time watchdog for teardown.
Advance application time for long-session behavior instead of sleeping for
hours.

Preserve source-versus-built module selection and real process/container
boundaries in packaging tests. A convenient fixture must not silently turn an
installed-runtime check into a source-only check. The credential
[module resolver](../../tests/fixtures/repository-credentials/runtime.mjs) owns
the mapping to common, GitHub, client, and composition modules. Tests should
consume that mapping rather than reconstruct the previous standalone package
paths. The [credential testing guide](repository-credentials.md) separates source
fixtures, detached artifacts, and delivered runtime evidence.

## Add properties where they improve coverage

Named finite cases work well for explicit protocol rules. Property tests are
useful for broader invariants, such as preserving arbitrary user text while
rewriting qualified machine links.

Generate constrained valid inputs, then targeted invalid variants. Require an
independent property, bounded execution, reproducible counterexamples, and
fresh state for each sample. Use an established property-testing library if
generation and shrinking are needed; do not build a custom engine into fixture
helpers. Keep heavyweight Git, CLI, and container workflows as selected
integration scenarios.

## Decide when to share

Start in the owning domain. Promote a helper when another real consumer needs
the same contract. Keep a short direct test inline when a helper would add more
navigation than meaning.

Review an extraction by asking whether the next case is easier to write, the
failure is easier to diagnose, and ownership is easier to explain. Preserve
meaningful boundary coverage and existing regression intent. Fewer lines alone
do not establish an improvement.
