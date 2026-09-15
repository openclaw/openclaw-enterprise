# Feature Spec: Deployment Simplification: contract

[Spec overview](../18-deployment-simplification.md). Original record; decisions and status are preserved.

## Contract

### Two configuration owners remain explicit

| Operator choice | Existing authoritative input |
| --- | --- |
| Development ports, credentials, runtime images, bridge and local overrides | [`.env.example`](../../.env.example), Compose environment and override files |
| Controller image, system Secret references, bootstrap claim, API endpoint/client selectors, dependency egress | [Helm values](../../deploy/helm/openclaw-enterprise/values.yaml) |
| Driver selections, gateway/Agent images, projected workload identity, runtime networking/storage | [Installation startup YAML](../../docs/reference/configuration.md#installation-startup-configuration) |
| PostgreSQL roles, immutable image approval, TLS, enforced NetworkPolicies and storage suitability | Operator infrastructure and security policy |
| Optional managed Provider, tenant RoleBindings, execution mode and Agent credentials | Existing [Provider](../../docs/reference/providers.md), [Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md) and [Agent](../../docs/reference/agents.md) contracts |

Ship editable `deploy/examples/production/values.yaml`, `installation.yaml`, and `bootstrap-pvc.yaml` using existing Helm, Installation, and Kubernetes schemas. Required site-specific fields remain explicit placeholders. The default example omits the optional ChatGPT Provider and its service-account Driver; the guide links the existing paired configuration when selected. Secrets remain file-backed operator inputs, outside version control. Example files contain no credential values.

Helm values do not duplicate gateway/Agent images or translate Driver configuration. Additional `-f` files and ordinary Helm overrides remain usable. Direct Compose and Helm commands remain supported. Neither helper reads a new settings file, evaluates YAML as shell, edits operator configuration, or installs host tools.

### Local startup helper

`scripts/dev-up [--key-output PATH] [-- COMPOSE_GLOBAL_OPTIONS...]` runs from the checkout root using Bash, Docker Compose, curl, and Python 3, which the current guide already requires.

1. Resolve the effective native Compose configuration without logging expanded credentials. Preserve `.env`, Compose project selection, override files and environment precedence; do not source `.env` as shell. If neither a shared nor individual runtime image is configured, select `openclaw-enterprise-runtime:quickstart` for this invocation and build the existing [runtime recipe](../../deploy/runtime/README.md) only when that local image is absent. Custom images must already exist; incomplete custom image selection fails with the existing configuration diagnostic.
2. Run Compose configuration validation and `up --build -d`. Compose retains startup dependency ownership; the helper never invokes migration or bootstrap independently. Within a bounded 300-second startup wait, require both one-shot services to exit `0`, a healthy controller, and a successful existing [worker readiness probe](../../scripts/production-healthcheck.mjs) inside the worker container. A stopped or failed component fails the command.
3. After confirmed bootstrap success, copy the initial service-key response from the stopped bootstrap container to a new owner-only file in a private directory. `--key-output` selects an absent destination in an operator-owned private directory; otherwise create a private temporary directory and print only its path. Existing destinations are never overwritten. Preserve initializer-owned output and credentials.
4. Reuse [`scripts/occ-api`](../../docs/guides/cli.md) to read `/installation` at the effective loopback API URL. Require `data.id` to match the copied key's `meta.installationId`. Print the URL, Installation ID, private key-file path, and the existing next-step/cleanup links; never print the key or an expanded credential-bearing command.

The helper exits nonzero with the failed stage and scoped diagnostic command when startup, copying, authorization, or ID matching fails. It never resets volumes or reissues a missing/expired key. Preserve any successfully delivered key copy for recovery. Repeat startup retains the Installation and its accounts; use normal human-administrator recovery when its original service key is unusable. Starting OCC needs no model credential and makes no model call. Only the local worker retains the Docker socket; host API/database exposure stays loopback.

### Production preparation and installation

Production retains these operator decisions before running commands: explicit kubeconfig/context; an approved controller/runtime image set; external PostgreSQL with separate migrator/application roles; HTTPS and exact API clients; post-translation `/32` dependency endpoints/ports; suitable bootstrap and gateway storage; and RWX storage when selecting dedicated Agents. A short input table in the guide links the owning references instead of repeating their contracts.

Create the system namespace and separate startup/database/auth Secrets using the current `kubectl create ... --from-file` commands and protected input files. These commands remain explicit because they provision operator-owned inputs; they do not become an apply-on-every-run secret synchronizer. Custom Secret names and keys are selected in native values. Optional Provider credentials remain a separate API-only Secret.

Create the bootstrap claim using the native example manifest, then run `scripts/prepare-bootstrap-volume --kubeconfig FILE --context NAME --namespace NAME --claim NAME --image DIGEST`. All selectors and the approved Node-capable image are required. This is an explicit fresh-claim operation that replaces the guide's inline preparation Pod manifest and wait/log/delete sequence:

- Create one uniquely named preparation Pod in the selected namespace, mounting only the named claim and disabling ServiceAccount-token automount. Preserve the current root-only `CHOWN`/`FOWNER` preparation and other Pod restrictions; do not broaden cluster policy.
- Require a fresh volume: refuse symlinks at the mounted root and existing content other than the filesystem-created `lost+found` directory. Set only the mounted root to UID/GID `1000`, mode `0700`; never recurse, delete content, or prepare an initialized claim. This also protects installations using customized bootstrap filenames.
- Wait at most 120 seconds for success and verify the non-secret owner/mode result. Delete only the preparation Pod created by this invocation after success. On failure, stop and identify that Pod/claim for diagnosis; leave credentials and volume content untouched.
- If policy forbids this Pod, the storage administrator prepares the same root permissions through the existing storage workflow. A preprepared claim goes directly to Helm; the helper is optional. It does not create a PVC or silently repair a used one.

Install with native Helm values and `--wait --timeout 5m`. The [initialization hook](../../deploy/helm/openclaw-enterprise/templates/jobs.yaml) owns migration/bootstrap order, no automatic Job retry, and bootstrap-output mounting. Helm readiness covers the API and worker probes. The guide then requires approved protected-storage retrieval of the bootstrap service-key file and an authenticated `/installation` read with ID matching. A completed Job is not an exec endpoint; API and worker never mount its output PVC.

Repeat installation uses the same values and retained inputs. A failed or ambiguous bootstrap stops for the existing recovery procedure; neither helper retries bootstrap, deletes output, resets the database, or changes identities. Helm failure does not mean its database hook was rolled back. Changing an external startup Secret alone does not restart the [API/worker Deployments](../../deploy/helm/openclaw-enterprise/templates/deployments.yaml); custom configuration changes still require explicit operator rollout and readiness verification. No automatic Secret reload or upgrade coordinator is added.

### Before and after usage

Today, local startup requires copying/editing `.env`, building the runtime, invoking Compose, inspecting service/log output, copying credentials, and manually checking access. Production requires an inline Installation document, a preparation Pod heredoc, and a long Helm `--set` command before the access check.

Proposed local default, with Docker running:

```bash
./scripts/dev-up
```

Customization uses the existing files and precedence:

```bash
OPENCLAW_DEV_PORT=3100 OCC_DOCKER_RUNTIME_IMAGE=my-approved-runtime:local \
  ./scripts/dev-up --key-output /secure/occ/session-key.json -- -f compose.yaml -f compose.local.yaml
```

Proposed production commands after editing native example files and provisioning the documented system Secrets and fresh claim; use the same explicit context for every preparatory `kubectl` call:

```bash
./scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace openclaw-system --claim occ-bootstrap-admin-password --image "$CONTROLLER_IMAGE"
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" --namespace openclaw-system \
  -f /secure/occ/values.yaml --wait --timeout 5m
# Retrieve the key through approved protected-storage access, then:
OCC_URL=https://occ.example.internal OCC_SERVICE_KEY_FILE=/secure/occ/session-key.json \
  scripts/occ-api GET /installation
```

`CONTROLLER_IMAGE` is the reviewed immutable image also used in values. The helper's claim matches `bootstrap.password.claimName`. Preparation and key retrieval are explicit steps, not hidden infrastructure guarantees.
