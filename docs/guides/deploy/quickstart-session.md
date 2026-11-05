# Use the quickstart operator session

Each installation setup page creates a private `RUN_DIR` and stages the shared helpers. [Deploy your first Agent](deploy-first-agent.md) uses that directory and saves `session.sh` after onboarding. Continue in that shell or source the printed file in Bash. Select the platform once during setup; Add Git, Add Plugin and Delete Agent use this same session.

The operator needs Pod read and `pods/exec` access in `PLATFORM_NS` for the API and worker helpers. REST calls still authenticate with the service key and require the corresponding OCC permissions.

## Session values

| Value                                   | Meaning                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RUN_DIR`                               | Absolute, owner-only directory for this installation's operator session.                                                                                     |
| `PLATFORM`                              | `local-k3d`, `kubernetes`, or `eks`; identifies the installation cleanup path.                                                                               |
| `KUBECONFIG`, `CONTEXT`                 | Private kubeconfig file and exact context for this installation. Commands do not change the default kubeconfig.                                              |
| `PLATFORM_NS`                           | Kubernetes namespace containing OCC, distinct from the OCE Namespace ID.                                                                                     |
| `RELEASE`, `OCE_CHART`                  | Existing OCE Helm release and matching chart directory or archive.                                                                                           |
| `INSTALLATION_FILE`, `VALUES_FILE`      | Current Installation configuration (`RUN_DIR/installation.yaml`) and current OCE Helm values (`RUN_DIR/values.json`). Update these files when enrolling Git. |
| `OCC_SERVICE_KEY_FILE`                  | Protected JSON service-key file at `RUN_DIR/service-key.json`. Never store the raw key in shell variables or command arguments.                              |
| `CONSOLE_ORIGIN`, `NATIVE_ADMIN_DOMAIN` | HTTPS Console origin and the configured Agent browser domain.                                                                                                |
| `namespace`, `base`                     | OCE Namespace ID and relative REST path `/namespaces/<id>`.                                                                                                  |
| `agent`, `principal`, `name`, `role`    | Deploy your first Agent                                                                                                                                      | Deploy your first Agent | Update and redeploy the same Agent      |
| `modelSource`, `MODEL`                  | Model and source selected during Agent deployment                                                                                                            | Same as local k3d       | Agent authentication and Linear catalog |
| `name`, `role`                          | Setup's resource-name prefix and exact model-access role ID.                                                                                                 |
| `TENANT_NAMESPACE`                      | Backing Kubernetes namespace, needed by existing-cluster network preparation.                                                                                |

Platform-only inputs remain in setup: local `OCC_DEVELOPMENT_STATE_DIRECTORY`; cluster `CLUSTER_DOMAIN` and `ENVOY_IMAGE`; and EKS `EKS_CLUSTER` and `AWS_REGION`. `CLUSTER_DOMAIN` is the verified Kubernetes DNS suffix used by the OpenShell certificate and private Gateway route, not the cluster name. Git adds `BOT_NAME`, `BOT_EMAIL`, `repo`, `repo_id`, `ref`, `READ_REGISTRY`, `WRITE_REGISTRY`, `branch` and `first_sha`. Run `save_session` after changing retained values.

## Files and helpers

`stage-session.sh` copies the Codex configuration template, REST client, WebSocket client, transcript reader, Git audit and common shell helpers into `RUN_DIR`. Existing-cluster setup also stages its network and browser assets in `RUN_DIR/kubernetes`. The `platform.sh` file supplies deployment preflight and network preparation for the selected cluster.

| Helper                                                  | Contract                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kube ...`                                              | Run kubectl against the saved kubeconfig and context.                                                                                                                       |
| `request METHOD PATH [--data JSON or --data-binary @-]` | Authenticate through the selected API Pod. Accept relative API paths; return JSON on success and fail on HTTP or transport errors. Do not pass an origin.                   |
| `request_status METHOD PATH`                            | Return only the HTTP status, for example `404` after Agent deletion. Transport errors still fail.                                                                           |
| `deploy_and_wait`                                       | Run platform preflight, submit one deployment, save its ID, prepare the required network rules, and wait for that revision to become active.                                |
| `wait_deployment ID`                                    | Prepare network rules and wait for an already submitted Console deployment. It does not submit another deployment.                                                          |
| `turn PROMPT_FILE`                                      | Send one OpenClaw WebSocket turn from the API Pod. Each call creates a new conversation; browser onboarding proves continuity separately.                                   |
| `upgrade_installation`                                  | Verify the selected Installation, patch its existing Secret, set the rollout checksum, upgrade the recorded Helm release, and wait for API/worker rollout.                  |
| `git_audit REVISION`                                    | Read scoped Git attempt custody and request receipts through the worker's database connection. It does not read keys or change records.                                     |
| `stop_and_retire REVISION`                              | Stop a finite Git grant and wait for recorded revocation/expiry with no retained sealed material. This is for permission changes, not a prerequisite for deleting an Agent. |
| `select_registry CONFIGMAP read\|write`                 | Check the exact repository/Namespace/permission map, upgrade the existing release, and verify the worker mount.                                                             |
| `save_session`                                          | Save nonsecret IDs, paths and helper loading to the private `session.sh`.                                                                                                   |

Use the same matching release checkout when running source-dependent setup commands. Retain service-key files, chart files and the private session directory; moving or deleting them breaks the saved session. A timed-out mutation has an unknown outcome. Read the existing resource or saved deployment ID before submitting it again.

`upgrade_installation` checks that saved values, live Helm values and the running API select the same Secret and key. It binds an initially unannotated Secret to the authenticated Installation with `openclaw.dev/installation-id`; an existing annotation must match. It preserves other Secret data and metadata; a concurrent Secret change rejects the patch. The printed private evidence directory retains the original Secret, live values and proposed update. A failed or interrupted patch or Helm upgrade may have changed the Secret: inspect it and Helm status before another mutation, and follow [Installation-change recovery](production-installation-changes.md) to restore a refused change. Saved values advance only after Helm succeeds.

## Where setup supplies the session

| Required input                                             | Local k3d                                         | Kubernetes and EKS                                                                      | Consumer                                                        |
| ---------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `RUN_DIR` and staged files                                 | Step 1                                            | Step 1                                                                                  | All later commands; files remain private                        |
| `KUBECONFIG`, `CONTEXT`, `PLATFORM_NS`                     | Step 3, from launcher state                       | Step 1, from the selected cluster                                                       | `kube`, REST, transcript reader and Helm                        |
| `RELEASE`, `OCE_CHART`, `INSTALLATION_FILE`, `VALUES_FILE` | Step 4; release `openclaw-enterprise`             | Steps 1–3; release `oce`                                                                | Git enrollment and read-only restoration                        |
| `OCC_SERVICE_KEY_FILE`                                     | Step 4, from launcher bootstrap                   | Step 2's browser preparation                                                            | `request` and `request_status`                                  |
| `namespace`, `base`, `TENANT_NAMESPACE`                    | Step 4                                            | Step 3                                                                                  | Both capabilities; OCE IDs are not Kubernetes names             |
| `CONSOLE_ORIGIN`, `NATIVE_ADMIN_DOMAIN`                    | Step 4                                            | Steps 2–3                                                                               | Agent origin and browser onboarding                             |
| `modelSource`, `MODEL`                                     | Model and source selected during Agent deployment | Same as local k3d                                                                       | Agent authentication and Linear catalog                         |
| `agent`, `principal`, `name`, `role`                       | Deploy your first Agent                           | Deploy your first Agent                                                                 | Update and redeploy the same Agent                              |
| `platform.sh`                                              | Step 4; launcher owns network preparation         | Step 1; uses `ENVOY_IMAGE`, `TENANT_NAMESPACE`, `trusted-peers.json` saved in steps 1–3 | Deployment preflight, Gateway Service wait and network policies |
| `session.sh`                                               | After Agent onboarding                            | After Agent onboarding                                                                  | Resume in a fresh Bash shell                                    |

Both capability guides load `session.sh` before using these inputs. Add Git supplies its own App, repository, registry and commit inputs. Add Plugin discovers its plugin ID and creates its prompt marker and result files. Neither requires the other capability's files or identifiers.
