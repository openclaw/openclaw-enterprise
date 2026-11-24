# Verify Agent HTTP chat

Run the `http-chat` scenario through the [regular QA matrix](ci/qa-advisory.md).
It provisions real Agents through Fastify, PostgreSQL and IAM, then calls the
private Kubernetes proxy and pinned runtime. It does not use fake completions.

## Select the scenario

Prepare the [Kubernetes test tools](kubernetes.md), source-built QA images and
an authorized model credential in an owner-readable file. Keep it out of logs,
command arguments, the controller and a separate Gateway. The QA workflow sends
it through the Secret API to the selected Agent-owned Harness.

```bash
OCC_TEST_QA_MATRIX=1 \
OCC_TEST_QA_SCENARIOS=http-chat \
OCC_TEST_QA_INSTALLATION=kubernetes \
OCC_TEST_QA_PRESET=OpenClaw \
OCC_TEST_QA_OPENAI_KEY_FILE=/private/path/model-key \
OCC_TEST_QA_OPENAI_MODEL=your-authorized-model \
  node --test tests/integration/qa-matrix-real.test.mjs
```

Use `OCC_TEST_QA_INSTALLATION=compose` to host OCC outside Kubernetes while
keeping Agent Compute in Kubernetes. Select `Codex` and set
`OCC_TEST_QA_CODEX_MODEL` to test the dedicated Codex Harness with API-key auth.
The matrix owns disposable resources and cleanup; preserve unrelated clusters,
services and the default kubeconfig. Do not use a shared database.

## Authorized full-access test runtime

When explicitly authorized for the test Agents, set
`OCC_DEVELOPMENT_CODEX_VERIFICATION_MODE=danger-full-access` with an exclusive
`http-chat` scenario. The launcher reports workspace-write sandbox proof as
[not applicable and not performed](../guides/deploy/codex-sandbox.md#explicit-container-only-development-verification).
It does not verify the container boundary at startup.
The QA helper sets only the selected Codex Agents' native sandbox configuration
to `danger-full-access` and disables their inner named workspace network profile,
which otherwise overrides that selector. Kubernetes NetworkPolicies remain in
force. The helper retains each Agent's approval policy and reviewer. It does
not edit standard Presets, host security controls or the development agent.

First qualify the existing model credential and pinned runtime with a bounded
model/tool smoke. Record the effective permission profile, approval policy and
reviewer. A refused profile is a blocker, not permission to bypass managed policy.
Full-access results do not establish workspace-write isolation.

## Checks and evidence

An exclusive `http-chat` selection disables Installation native browser access.
Each Agent also disables browser chat and omits the HTTP endpoint opt-in. It checks:

- Human and service JSON/SSE, with a tool-created file read independently from
  the selected Harness Pod and then removed.
- Fresh requests, explicit continuation, principal/Agent separation and service-key rotation.
- Private-route method/path restrictions, direct Gateway authority rejection,
  and NetworkPolicy rejection of a Pod without Agent identity.
- Authentication, exact-Agent access, read-only credentials with forged identity,
  reserved headers/model, request size and body deadline,
  explicit opt-out and stopped-Agent status.
- Service-key revocation, replacement and stop during a native SSE response,
  with no success terminator after interruption. Tool rollback is not claimed.

The [admission integration test](../../tests/integration/agent-http-chat.test.ts)
uses real Fastify authentication and native IAM without a real runtime. It proves
only admission and capability ordering. It does not replace credentialed QA.

Record the tested commit, images, mode, pass/fail/skip results and cleanup with
the [implementation plan](../../specs/plans/0040-agent-chat-completions.md#verification).
The plan tracks the complete RFC acceptance criteria, including remaining
network isolation, deadline, audit and topology qualification. Do not report
those outcomes as passed merely because a narrower scenario succeeds.

## Current pinned-runtime qualification limit

The [delivery record](../../specs/plans/0040-agent-chat-completions.md#authorized-full-access-retry)
contains the exact revisions, images and outcomes. Embedded OpenClaw passes the
selected scenario. Dedicated Codex JSON/tool execution and full-access policy
were verified, but repeated SSE attempts returned the native error
“Assistant output cannot be represented as an append-only response stream.”
An explicit final-answer-only request produced the same result.

This remains a native streaming qualification blocker. Do not discard the error,
convert buffered JSON into claimed streaming proof, or describe all Codex
requests as unsupported. A compatible, qualified native-runtime change is needed
before the dependent acceptance criteria can be marked complete.
