# Agent plugin testing

## Overview

Run Agent plugin tests for API, Driver, persistence, and runtime behavior from the repository root. The [plugin reference](../reference/agent-plugins.md) describes supported behavior.

## Local and integration suites

| Coverage                 | Command                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API and contracts        | `pnpm test:conformance` and `node --test tests/integration/occ-api.test.mjs`                                                                                                     |
| Driver and startup       | `node --test tests/conformance/plugin-driver.test.mjs tests/integration/plugin-driver-startup.test.mjs`                                                                          |
| Compute boundaries       | `node --test tests/conformance/plugin-compute.test.mjs tests/conformance/ssh-compute.test.mjs`                                                                                   |
| Persistence and recovery | Run the prepared `postgres-application` and `postgres-platform` lanes using the [PostgreSQL procedure](postgresql.md#revision-worker-tests); each lane needs its own state file. |

The discovery fixture uses simulated provider responses. These checks do not prove a live provider or native runtime.

### Kubernetes status transport

Prepare a [disposable Kubernetes fixture](kubernetes.md), a worker node, and a migrated `openclaw_k8s_*` database. Set `OCC_TEST_KUBERNETES_KUBECONFIG`, `OCC_TEST_KUBERNETES_CONTEXT`, `OCC_TEST_KUBERNETES_IMAGE`, `OCC_TEST_DATABASE_URL`, and `OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS` to the comma-separated API-server proxy source CIDRs from the [networking reference](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking).

```sh
node --test tests/integration/kubernetes-plugin-status-real.test.mjs
```

This checks status transport and restart behavior with controlled producers. It does not prove native plugin compatibility.

## Native startup metadata reads

After credential authorization under the [contribution policy](../../CONTRIBUTING.md), inject `CODEX_ACCESS_TOKEN` without printing it. Set `OCC_TEST_KUBERNETES_AGENT_IMAGE` to an available immutable image containing Codex `0.163.0-alpha.2`, and start Docker.

```sh
OCC_TEST_CODEX_STARTUP_READS_REAL=1 node --test \
  --test-name-pattern='native Codex app-server' \
  tests/integration/codex-plugin-startup-reads-real.test.mjs
```

The test removes its container. It checks the authenticated metadata protocol, not a model turn or connector call.

## Native runtime prerequisites

Prepare the [Kubernetes runtime setup](kubernetes.md#kubernetes-model-turns-and-secrets), including immutable gateway and Agent images, an authorized model, a disposable cluster, and the proxy CIDRs above. For one scenario, set its database URL below or use `OCC_TEST_DATABASE_URL`. Set one scenario flag:

| Scenario                                | Flag                                        | Database variable                                   |
| --------------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| Embedded OpenClaw Diffs                 | `OCC_TEST_PLUGIN_DRIVER_OPENCLAW_REAL`      | `OCC_TEST_PLUGIN_DRIVER_OPENCLAW_DATABASE_URL`      |
| Dedicated Codex Linear                  | `OCC_TEST_PLUGIN_DRIVER_CODEX_LINEAR_REAL`  | `OCC_TEST_PLUGIN_DRIVER_CODEX_LINEAR_DATABASE_URL`  |
| Dedicated Codex install or auth failure | `OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_REAL` | `OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_DATABASE_URL` |

Set the chosen flag to `1`, then run:

```sh
node --test tests/integration/plugin-driver-real.test.mjs
```

`OCC_TEST_PLUGIN_DRIVER_REAL=1` selects all three and requires all three scenario-specific URLs with distinct databases; separate host aliases for one database do not count. Unselected cases skip. The OpenClaw case needs `OPENAI_API_KEY` and an image supporting `plugins install --no-enable`; the repository's pinned runtime lacks that flag. Codex cases need an existing authorized account's `CODEX_ACCESS_TOKEN`, an immutable `OCC_TEST_KUBERNETES_AGENT_IMAGE` or `OCC_TEST_KUBERNETES_CODEX_IMAGE`, and the [Codex sandbox profile](../guides/deploy/codex-sandbox.md) on each test node, selected with `OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE`. Choose a supported model with `OCC_TEST_OPENAI_MODEL`; the default is `gpt-6-astra`. Provide sufficient cluster memory for revision overlap.

For Linear, connect the account and set `OCC_TEST_CODEX_LINEAR_PROMPT`, `OCC_TEST_CODEX_LINEAR_TOOL_NAME`, and `OCC_TEST_CODEX_LINEAR_RESULT_EXPECT` for a harmless read. For the failure case, connect the successful plugin account and select a real failing plugin; use `OCC_TEST_CODEX_SUCCESS_PLUGIN_ID` and newline-separated `OCC_TEST_CODEX_FAILURE_PLUGIN_IDS` to override the defaults. Calendar tool names differ between accounts: set `OCC_TEST_CODEX_CALENDAR_TOOL_NAME`, `OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`, and, if needed, `OCC_TEST_CODEX_CALENDAR_PROMPT` for an available harmless read. Never print credentials or account identifiers.

## Per-call approval acceptance

Use the [QA matrix](ci.md#qa-matrix) Calendar scenario to exercise human and automatic approval in normal Agent turns. The scenario uses harmless reads. An unselected or skipped case does not prove approval enforcement.

## Tool override acceptance

The Calendar scenario also checks that an enabled tool exception can run and a disabled tool cannot. It does not call sibling write tools. Check the transcript, not discovery metadata alone, for execution evidence.

## Current proof notes

The nested policy contract has not been verified in a real Kubernetes Agent deployment. Before claiming approval enforcement, verify effective native configuration, session approval and permissions, reviewer availability, and a normal Agent turn. Check `write_actions` with both a read and a non-read action; a permissive session can bypass MCP review. Native effective-policy introspection, installation composition, and later session or model changes remain unverified. Historical installation results in [PR #228](https://github.com/openclaw/openclaw-enterprise/pull/228) do not prove these policies or production Helm and shared-cluster admission guardrails.

Record the commit, selected cases, nonsecret image references, runtime versions, model, pass/fail/skip counts, and sanitized evidence for any claimed proof.
