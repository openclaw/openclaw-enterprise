# Compose fixtures and readable scenarios

## Overview

Build test fixtures and write scenarios with clear inputs, actions, and expected results. See the
[test audit](../../.agents/skills/test-audit/SKILL.md) for coverage selection.

## Build inputs without deciding expectations

Use builders for fresh data with explicit variations. Keep identities consistent
and obtain opaque handles from their owners. For rejection cases, pass invalid
input unchanged. Specify expectations independently: do not use the production
classifier, or a copy of it, to calculate expected results. Fixtures may emulate
an external protocol but must not replace the authorization or lifecycle behavior
under test.

Captured state must be keyless. The [released Gateway fixture](../../tests/fixtures/runtime-state/released-gateway-state.tar.gz)
has device identity and config version keys removed; regenerate it the same
way using the image identified in its test.
The [workspace node fixture](../../tests/fixtures/runtime-state/workspace-node-state-openclaw-f8386bc7.tar.gz)
is a dedicated Harness's node state and workspace from the OpenClaw `f8386bc7`
runtime image (shared state schema 20). To record it, run `openclaw setup --baseline`
and one `openclaw node run` on that image as uid 1000. Then copy the database with
`VACUUM INTO`, delete its `device_identities` rows, vacuum it again and archive it
without the Git sample hooks. Each test run saves a new identity in the older row format.

## Make cases easy to add and diagnose

Use named cases with independent mutable state. Share a contract suite when
implementations promise the same behavior; keep implementation-specific cases
separate. Register contract suites explicitly so fixture imports do not run
unrelated tests. Start helpers in their owning domain and share them when another
consumer needs the same contract.

## Own resources and time

Register cleanup on acquisition, including partial setup. Stop admission, drain
operations, then close dependencies and remove owned files. Attempt remaining
cleanup after failure and preserve both setup and cleanup errors. Before remote
creation, establish a cleanup or reconciliation obligation; a lost response does
not prove failure or authorize replay. Bound cleanup and join processes and
sockets; a timeout is not disposal.

Inject clocks for long-duration cases and use a real-time teardown watchdog.
Preserve source-versus-built selection and real process or container boundaries
in packaging tests. See the [credential fixtures](../../tests/fixtures/repository-credentials)
and [credential testing guide](repository-credentials.md) for examples.

## Hash fixture passwords cheaply

Build controllers in tests through the constructors in
[`tests/helpers/password-hasher.mjs`](../../tests/helpers/password-hasher.mjs). They inject a
salted SHA-256 hasher in place of the controller's scrypt, which costs about 0.1 CPU-second
per hash or sign-in. It still verifies scrypt hashes that production entry points wrote, such
as the bootstrap administrator's. Pass `scryptPasswordHasher` where hashing cost, timing or the
stored format is under test. Deployments cannot select another hasher: only code passes one.

## Add properties where they improve coverage

Use constrained inputs, independent properties, execution with a time limit, reproducible
counterexamples, and fresh state. Use an established library for generation and
shrinking. Keep heavyweight Git and container workflows as selected integration
scenarios.
