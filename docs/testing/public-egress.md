# Qualify public egress with protected credentials

Run the connected scenario against an explicitly prepared, disposable Kubernetes
Installation. It creates a regular protected Agent, compares restricted and public
revisions, and uses model-driven shell commands for network and repository work.
The test does not provision infrastructure or select credentials for the operator.

## Prepare inputs

Prepare a dedicated loopback k3d cluster, migrated `openclaw_k8s_*` database and
production Helm API/worker installation. Follow [Kubernetes setup](kubernetes.md)
and [repository enrollment](../guides/repository-credentials/openshell-enrollment.md).
Use matching candidate OpenShell components that report the **actual applied**
public-egress flag in the current supervisor configuration admission. The test
binds its accepted state, policy hash/version and configuration/provider revisions
to current Gateway observations. A requested policy document alone is insufficient.

Keep model credentials, the App signing key and fresh custody key with their
owning services. Configure a Gateway-owned `codex-pat` source and a real authorized
public repository with `github-repository` standing access. Start the Installation
with `networkEgressMode: restricted` and no credential-free artifact allowances.
The test checks explicit modes; default selection belongs to packaging tests.

Set these variables through the authorized credential workflow:

| Variable                             | Value                                              |
| ------------------------------------ | -------------------------------------------------- |
| `OCC_TEST_PUBLIC_EGRESS_INPUTS`      | Absolute path to the private JSON input below      |
| `OCC_TEST_PUBLIC_EGRESS_SERVICE_KEY` | Scoped controller operator key                     |
| `OCC_TEST_DATABASE_URL`              | Limited `occ_app` URL for the dedicated database   |
| `NODE_EXTRA_CA_CERTS`                | Listener CA when the loopback API uses private TLS |

The JSON uses this contract. It contains references and expected public metadata,
not credential values.

| Field                                                 | Required value                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `version`                                             | `1`                                                                                         |
| `apiOrigin`, `installationId`, `namespaceId`          | Exact loopback API origin and prepared IDs                                                  |
| `modelSourceId`, `model`                              | Ready Gateway source and authorized native model                                            |
| `repositoryRef`, `repository`                         | Registry reference and authorized `owner/name`                                              |
| `repositoryPermissions`                               | Expected authenticated GitHub permissions object, including `pull`                          |
| `expectedGitHubAppId`, `expectedGitHubInstallationId` | Decimal strings naming the authorized App installation                                      |
| `custodySecretNames`                                  | Nonempty list of worker/model Kubernetes Secret names forbidden in Agent Pod references     |
| `publicTcp`                                           | Controlled HTTPS `url` on a nonstandard public TCP port, plus `expectedBodySha256`          |
| `kubeconfigPath`, `kubernetesContext`, `clusterUID`   | Absolute owned kubeconfig, `k3d-*` context and `kube-system` UID                            |
| `controllerNamespace`, `controllerSelector`           | Exact namespace and selector for one ready API Pod                                          |
| `openShellBackend`                                    | Authenticated HTTPS endpoint, CA path and mTLS certificate/key paths                        |
| `images`                                              | Digest-pinned `controller`, `gateway`, `agent`, `openShellGateway`, `sandbox`, `supervisor` |
| `oceCommit`                                           | Candidate checkout's base commit                                                            |
| `evidenceDirectory`                                   | New absolute evidence directory outside the checkout                                        |
| `pauseForAcceptance`                                  | Optional boolean, default false; retain the public revision for operator checks             |

The controlled endpoint must be reachable by public DNS and a globally routable
address, use valid TLS, and return the prepared fixed body. The scenario sends
no credentials to it. Missing preparation fails before Agent creation; it does
not substitute a local mock or count a skip as runtime proof.

## Run and coordinate

Use the canonical QA matrix with the same prepared inputs:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_PRESET=Codex \
  OCC_TEST_QA_INSTALLATION=kubernetes OCC_TEST_QA_SCENARIOS=public-egress \
  node --test tests/integration/qa-matrix-real.test.mjs
```

The matrix invokes the same standalone workflow as:

```sh
OCC_TEST_PUBLIC_EGRESS=1 node --test tests/integration/public-egress-connected.test.mjs
```

Wait for `baseline-ready.json`. The restricted revision must support managed Git
and model access while denying unclaimed public hosts and cold Corepack bootstrap.
Change only the Installation's egress mode to `public` through the normal
API/worker configuration rollout. Do not deploy the test Agent manually. Write
`successor-ready.json` with the baseline receipt's unchanged `runId`, `agentId`
and `baselineRevisionId`.

The runner verifies that the retained revision remains restricted, then deploys
its public successor. It requires public HTTPS reads at `registry.npmjs.org` and
`nodejs.org`, a successful response from the controlled nonstandard-port endpoint,
and a cold integrity-pinned Corepack bootstrap. Managed hosts remain denied on
undeclared ports in both modes. The probe derives those hosts from the installed
model Provider profile and protected Git middleware. It records the workload
process identity separately from the supervisor configuration identity; fresh
credential-use records must match the current workload network instance.

When `pauseForAcceptance` is true, `public-egress-ready.json` retains that successor
for separately authorized repository checks. Finish within 30 minutes, then write
`acceptance-complete.json` with its unchanged `runId`, `agentId`,
`baselineRevisionId` and `revisionId`. The runner retires its Agent after success
or failure. An uncertain create response is reconciled by the exact run-owned
Agent name before cleanup; it is not replayed.

## Interpret results

The scenario requires authenticated GitHub permission fields and new database
credential-use records bound to the selected App installation, Agent revision,
current recipient fence and prepared credential version.
Those records prove authorization; successful native command completion and
response checks establish the observed read. A public repository read alone is
not accepted as authentication proof.

Custody checks examine Agent Pod references, readable process environments and
the native PAT file. They emit booleans for opaque provider values and absence of
refresh/private-key material. They do not establish arbitrary filesystem secrecy
or provider revocation. No real credential is sent to an untrusted receiver, and
this scenario does not currently prove a synthetic-canary receiver boundary.

`complete.json` records acceptance; `cleanup.json` separately records retirement
and closed repository sessions. Retain the owned stack and custody until cleanup
succeeds. Keep separate evidence for repository installation, formatting and tests;
a successful package-manager bootstrap does not prove those operations.

This is an explicit, manually prepared QA selection. It is excluded from `all`
and hosted advisory jobs. The matrix wrapper requires one passing test with no
skips and retains a redacted runtime log.
