# Runbook: when the Strands Box GitHub test fails

Failures seen while running the [runbook](RUNBOOK.md), checked against this
branch. Operator-facing limits are in [KNOWN-GAPS.md](KNOWN-GAPS.md); read it
first.

## When it fails

| Step | Symptom                                                                                       | Cause                                                                                                                   | Fix                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `bwrap` fails with `Failed RTM_NEWADDR` or `uid_map` permission errors                        | Ubuntu 24.04 restricts unprivileged user namespaces                                                                     | AppArmor `userns` profiles for `bwrap` and the Box directory ([known gap](KNOWN-GAPS.md#ubuntu-2404-restricts-unprivileged-user-namespaces)) |
| 1    | Box cannot run programs from its runtime directory                                            | `/run` (or your runtime directory's mount) is `noexec`                                                                  | `sudo mount -o remount,exec /run`, or put `runtimeDir` on an exec mount                                                                      |
| 1, 9 | host refuses with `noncanonical_path`                                                         | a configured path is a symlink, for example `/usr/local/bin/node` linking into a home directory                         | install real root-owned files at those paths                                                                                                 |
| 3, 9 | `agent_exec_covers_git` before `startup refused at stage-inputs`                              | an `exec` grant or Codex's `PATH` reaches a `git` other than `/usr/bin/git`                                             | see [Prepare the host and verify Box](README.md#prepare-the-host-and-verify-box)                                                             |
| 5, 9 | the revision waits, then fails; the Worker cannot reach the relay                             | the chart's Worker egress is default-deny                                                                               | add the Worker-to-relay NetworkPolicy (runbook step 5)                                                                                       |
| 6    | the prepared attempt fails against `api.github.com`; its issuer is not `#default-https-trust` | `repository.preparedGitHub.issuerCaPath` or `preparedProviderCaConfigMapName` is set; it replaces public trust          | remove both, upgrade                                                                                                                         |
| 6    | a registry change has no effect                                                               | the ConfigMap is immutable and the old one is still named                                                               | create it under a new name and point `registryConfigMapName` at it                                                                           |
| 6    | GitHub names resolve to a test address                                                        | an earlier `github.com` pin in the host's `/etc/hosts` or CoreDNS `coredns-custom`                                      | remove it; for CoreDNS rewrite the whole custom zone rather than deleting lines, then restart CoreDNS                                        |
| 9    | host refuses with `upstream_ca_not_configured` or `upstream_ca_route_not_declared`            | a route's `caSha256` differs from `upstreamCa.sha256`                                                                   | give `controlledInference`, `protectedRepository` and `nativeHookRelay` the bundle's exact SHA-256                                           |
| 9    | approval fails with `unadmitted_profile`                                                      | the host's `image` differs from the revision's image (for example after changing the image pin)                         | write the host configuration again with the revision's runtime digest as `image`                                                             |
| 9    | revision fails while you are still starting the host                                          | the Worker gives the host about 3 minutes to open its control socket; a failed revision is terminal                     | start the host right after `deploy`; for a new attempt reset the host state, then deploy again                                               |
| 9    | workspace node refused with `unrecognized_combined_workspace_node_command`                    | the Controller and runtime images come from different commits                                                           | build both from this branch                                                                                                                  |
| 10   | Codex commands fail inside Box with a Bubblewrap error                                        | Codex `sandbox: read-only` wraps commands in its own Bubblewrap, which cannot start inside Box                          | use `sandbox: workspace-write`                                                                                                               |
| 10   | the model tries Code Mode and gets `EACCES`, then uses the shell                              | Code Mode cannot run in Box                                                                                             | expected ([known gap](KNOWN-GAPS.md#codex-code-mode-cannot-run-in-box))                                                                      |
| 10   | `git push` or `gh` gets `403 credential refused by its source: <code>`                        | `request_not_allowed`: outside the binding or profile; `access_withdrawn`: binding removed; `route_not_ready`: no route | check the registry, the binding and its profile ([git README](git/README.md))                                                                |
| 13   | next revision waits in `REPOSITORY_GIT_MATERIAL_PENDING`                                      | the last prepared attempt has `custody` `unknown`: its revoke could not reach the issuer (stopped after unwiring)       | wait until `greatest(started_at + 72 min, provider_expires_at + 60 s)`; next time stop while GitHub is still wired                           |
| 13   | model source withdrawal returns `409` on a stopped Agent                                      | withdrawal needs an active revision                                                                                     | withdraw before stopping ([known gap](KNOWN-GAPS.md#withdrawing-a-model-source-needs-an-active-revision))                                    |
| 13   | `DELETE` of the source returns `409`, "still references the credential source"                | the Agent still names the source                                                                                        | PATCH the Agent to drop it first                                                                                                             |
| 13   | a deleted Secret still appears in a datastore search                                          | K3s keeps old revisions until compaction                                                                                | search again after 5 minutes                                                                                                                 |

## Not covered

- Installed runs on Linux ARM64. Box releases ship for ARM64, but every
  installed GitHub run was on x86-64 with the fork build
  ([known gap](KNOWN-GAPS.md#box-releases-ship-for-linux-arm64-only)).
- More than one execution per host, more than one Worker replica, or a Box
  host on a different node from the Worker and Gateway.
- A first deployment straight into the protected configuration. The proven
  runs first passed [installed ordinary chat](ordinary-chat/installed.md) on
  the same host.
- Detaching a model source without attaching another one (runbook step 13).
- Model ids other than the one id the proven runs sent, endpoints with WebSocket transport, and
  public model certificates without an upstream CA bundle.
- A Controller image built with `pnpm-lock.yaml` regenerated, as
  [the documented procedure](../../../docs/reference/drivers/selection.md#package-identity-and-factory-exports)
  requires.
- Rules on draft state or branch names for `gh` API requests
  ([known gap](KNOWN-GAPS.md#oce-applies-no-draft-or-branch-rule-to-ghs-github-api-requests)):
  the prompt and the App's permissions are the only limits.
- A scripted model against real GitHub. `git/controlled-git-model.ts` is for
  rehearsal against a stand-in; it never ran against github.com.
