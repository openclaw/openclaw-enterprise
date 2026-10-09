# ChatGPT service-account tests

Verify real ChatGPT service-account creation, credential delivery, and a Codex
model turn. Prepare the [Kubernetes runtime setup](kubernetes.md#kubernetes-model-turns-and-secrets)
and [private credential file](README.md#requirements-and-credentials) first.

## ChatGPT service accounts

Use the linked Kubernetes setup for a disposable cluster, migrated database,
and immutable runtime images. Supply a protected admin-key file and the exact authorized workspace ID;
the test creates a real provider account and issues its model credential. For a
direct local `node --test` run, import approved gateway and Agent images first
and export their immutable `image@sha256:<digest>` references as shown in
[Kubernetes model turns and Secrets](kubernetes.md#kubernetes-model-turns-and-secrets).

The test uses stock local-path RWO storage in the disposable k3d cluster and
grants its controller identities the production worker's volume and Pod
observation permissions. The worker remains unable to read Secrets.

The protected `provider-account` GitHub Actions lane builds the checked-in
runtime image and imports it into the run-owned k3d cluster when either
`OCC_TEST_KUBERNETES_GATEWAY_IMAGE` or `OCC_TEST_KUBERNETES_AGENT_IMAGE` is
unset. If both image variables are set, the lane uses those explicit references
after validating that each is immutable.

```sh
(
  unset OCC_TEST_CHATGPT_ADMIN_KEY
  export OCC_TEST_CHATGPT_ADMIN_KEY_PATH=/absolute/path/to/private/chatgpt-admin-key
  export OCC_TEST_CHATGPT_WORKSPACE_ID='<authorized-workspace-id>'
  OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1 \
    node --env-file="$TEST_ENV_FILE" --test tests/integration/service-account-driver-real.test.mjs
)
```

Keep `OCC_TEST_CHATGPT_ADMIN_KEY` out of that environment file as well: a nonempty
environment key takes precedence over the file-path option. Protect the supplied
key file with mode `0600`. `OPENAI_API_KEY` is not required. Set the supported
model explicitly with `OCC_TEST_OPENAI_MODEL`. The test attempts provider-account deletion and
scoped resource cleanup; investigate any reported cleanup failure before rerunning.

## ChatGPT service-account integration test environment

[`service-account-driver-real.test.mjs`](../../tests/integration/service-account-driver-real.test.mjs)
creates an actual ChatGPT service account, issues its credential, deploys the
associated dedicated Codex Agent, and requires one genuine provider-backed
model turn. Set `OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1` to opt in; missing
prerequisites then fail rather than skip.

| Variable                                | Requirement                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL` | Set to `1` to enable the real provider-backed account and model-turn test.               |
| `OCC_TEST_CHATGPT_ADMIN_KEY`            | Explicit admin key; takes precedence over the path when set.                             |
| `OCC_TEST_CHATGPT_ADMIN_KEY_PATH`       | Protected `0600` admin-key file read only when `OCC_TEST_CHATGPT_ADMIN_KEY` is unset.    |
| `OCC_TEST_CHATGPT_WORKSPACE_ID`         | ChatGPT workspace authorized for account and credential creation.                        |
| `OCC_TEST_KUBERNETES_KUBECONFIG`        | Absolute kubeconfig path for the dedicated disposable local cluster.                     |
| `OCC_TEST_KUBERNETES_CONTEXT`           | Explicit `k3d-*` context with a verified loopback HTTPS API.                             |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`     | Imported immutable real OpenClaw gateway image.                                          |
| `OCC_TEST_KUBERNETES_CODEX_IMAGE`       | Imported immutable real Codex image; `OCC_TEST_KUBERNETES_AGENT_IMAGE` is also accepted. |
| `OCC_TEST_DATABASE_URL`                 | Migrated disposable loopback PostgreSQL database named `openclaw_k8s_*`.                 |

This scenario uses its newly issued access token, not `OPENAI_API_KEY`. Its
optional `OCC_TEST_OPENAI_MODEL` defaults to `gpt-6-astra`; select a model
available to the issued ChatGPT account's Codex credentials. API-key model
availability does not establish support for this authentication mode.
When using the file path, unset `OCC_TEST_CHATGPT_ADMIN_KEY` first so the test
actually reads the protected file. See the
[ChatGPT service-account testing guide](#chatgpt-service-accounts)
for the complete setup.

## Local and provider coverage

`tests/integration/occ-api.test.mjs` covers native references, immutable revision
snapshots, and Namespace-scoped access.
`tests/conformance/service-account-driver.test.mjs` covers authorized lifecycle,
transaction-failure compensation, and execution-mode admission. Against an
in-memory Admin API, it checks that a create reply naming a disabled account in
this workspace removes only that account, a lost reply deletes nothing, and a
retried delete completes. An invalid credential reply revokes only a credential
it places under the requested account in this workspace.
`tests/conformance/kubernetes-compute.test.mjs` checks that a failed token Secret
create deletes only an account-owned Secret with the request's token, and that a
failed issuance's compensation keeps the Secret a later issuance stored under the
same name.

Its Backend regression uses built-in fetch and real HTTPS connections against a
loopback TLS server with a test-owned certificate. An unfinished 429, 503 or
oversized declared response must release a single-connection pool so the next
account request completes before a five-second deadline. Fetch, response bodies
and cancellation are not mocked; the provider replies and credentials are synthetic.
The test restores the original dispatcher, destroys its pool, closes the server
and removes the temporary certificate/key directory. It requires `openssl`.
These checks do not exercise a live provider or Kubernetes cluster.

`tests/integration/postgres-service-account-deletion.test.mjs` uses the
[PostgreSQL test setup](postgresql.md) to verify deletion rejection before Driver
effects for queued, claimed, and active revisions after draft detachment. It
also checks that completed cutover and permanently failed work release account
references. The shared storage contract covers active and historical revisions
in both storage adapters. These are persistence and controller checks, not live
credential-revocation or model-turn proof.

The real account suite above creates a provider account and runs dedicated Codex
with its issued credential. The ordinary
[Kubernetes runtime suite](kubernetes.md#kubernetes-model-turns-and-secrets)
separately covers native API-key Codex and embedded OpenClaw execution.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
