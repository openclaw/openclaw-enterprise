# Runbook: when the Strands Box GitHub test fails

Failures seen while running the [runbook](RUNBOOK.md), checked against this
branch. Operator-facing limits are in [KNOWN-GAPS.md](KNOWN-GAPS.md); read it
first.

## When it fails

| Step | Symptom                                                                                                                                     | Cause                                                                                                                                                                        | Fix                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `bwrap` fails with `Failed RTM_NEWADDR` or `uid_map` permission errors                                                                      | Ubuntu 24.04 restricts unprivileged user namespaces                                                                                                                          | load the [AppArmor profiles](#apparmor-profiles) ([known gap](KNOWN-GAPS.md#ubuntu-2404-restricts-unprivileged-user-namespaces))              |
| 1    | Box cannot run programs from its runtime directory                                                                                          | `/run` (or your runtime directory's mount) is `noexec`                                                                                                                       | `sudo mount -o remount,exec /run`, or put `runtimeDir` on an exec mount                                                                       |
| 1, 9 | host refuses with `noncanonical_path`                                                                                                       | a configured path is a symlink, for example `/usr/local/bin/node` linking into a home directory                                                                              | install real root-owned files at those paths                                                                                                  |
| 2    | `gh api apps/<app-slug>` returns `404`                                                                                                      | the App is private                                                                                                                                                           | read the App ID on the App's settings page                                                                                                    |
| 3, 9 | `agent_exec_covers_git` before `startup refused at stage-inputs`                                                                            | an `exec` grant or Codex's `PATH` reaches a `git` other than `/usr/bin/git`                                                                                                  | see [Prepare the host and verify Box](README.md#prepare-the-host-and-verify-box)                                                              |
| 4    | `request` exits `2` with no output                                                                                                          | the body was passed as `--data-binary @<file>`                                                                                                                               | pipe it: `--data-binary @- < <file>`, or `--data '<json>'`                                                                                    |
| 5    | control claim checks 2 or 3 fail after step 7                                                                                               | they need the Worker at zero and an empty export                                                                                                                             | run them before step 7; afterwards use the live mount check                                                                                   |
| 5, 9 | the revision waits, then fails; the Worker cannot reach the relay                                                                           | the chart's Worker egress is default-deny                                                                                                                                    | add the Worker-to-relay NetworkPolicy (runbook step 5)                                                                                        |
| 6    | the prepared attempt fails against `api.github.com`; its issuer is not `#default-https-trust`                                               | `repository.preparedGitHub.issuerCaPath` or `preparedProviderCaConfigMapName` is set; it replaces public trust                                                               | remove both, upgrade                                                                                                                          |
| 6    | a registry change has no effect                                                                                                             | the ConfigMap is immutable and the old one is still named                                                                                                                    | create it under a new name and point `registryConfigMapName` at it                                                                            |
| 6    | GitHub names resolve to a test address                                                                                                      | an earlier `github.com` pin in the host's `/etc/hosts` or CoreDNS `coredns-custom`                                                                                           | remove it; for CoreDNS rewrite the whole custom zone rather than deleting lines, then restart CoreDNS                                         |
| 7    | the pairing-form upgrade is refused: "repository requires explicitly selected protected Git delivery and prepared GitHub custody."          | the Credential Gateway is left out but `backend` or `repository` is kept                                                                                                     | leave out all six entries marked `# protected` (runbook step 7)                                                                               |
| 8    | a new Agent's first deployment fails: "A protected workspace requires retained Agent-owned node setup before provisioning."                 | a protected first deployment: the Agent has no node setup from an earlier deployment                                                                                         | pair it first in the pairing form (runbook steps 7 and 8, [known gap](KNOWN-GAPS.md#a-new-agents-first-deployment-cannot-be-a-protected-one)) |
| 8    | `deploy` of a new Agent with the marker returns `409`: "The selected Credential Gateway requires credential-source Harness authentication." | step 7 selects the Credential Gateway, which refuses marker authentication                                                                                                   | same; the PATCH itself is accepted                                                                                                            |
| 8    | a new Agent's first deployment with the model source and no binding fails: `SANDBOX_HARNESS_UNSUPPORTED`                                    | without a binding the revision is admitted unprotected; the Driver selected in step 7 runs only protected one-repository revisions                                           | same                                                                                                                                          |
| 8    | the pairing chat fails: "Could not deliver the native hook relay credential to Codex"                                                       | the host configuration has no `nativeHookRelay`                                                                                                                              | add `nativeHookRelay: { caSha256 }` (runbook step 9)                                                                                          |
| 9    | host refuses with `runtime_already_used`                                                                                                    | `runtimeDir` holds state from an earlier run                                                                                                                                 | remove everything but `worker-control` (also `source`); unmount the four targets                                                              |
| 9    | the host exits at start: `configuration, listener or retirement refused`                                                                    | for example `approvalDir` is not empty, or a mount target is not bound                                                                                                       | empty `approvalDir`; bind the four subpaths before starting the host                                                                          |
| 9    | host refuses with `upstream_ca_not_configured` or `upstream_ca_route_not_declared`                                                          | a route's `caSha256` differs from `upstreamCa.sha256`                                                                                                                        | give `controlledInference`, `protectedRepository` and `nativeHookRelay` the bundle's exact SHA-256                                            |
| 9    | approval fails with `unadmitted_profile`                                                                                                    | the host's `image` differs from the revision's image (for example after changing the image pin)                                                                              | write the host configuration again with the revision's runtime digest as `image`                                                              |
| 9    | the revision fails, on a later deployment within seconds: "The Strands Box host did not confirm the execution operation."                   | the first deployment gives the host about 3 minutes; a later one first stops the earlier revision through the host, which must already listen. A failed revision is terminal | reset; first deployment: start the host right after `deploy`; later ones: start the host before `deploy`                                      |
| 9    | workspace node refused with `unrecognized_combined_workspace_node_command`                                                                  | the Controller and runtime images come from different commits                                                                                                                | build both from this branch                                                                                                                   |
| 10   | Codex commands fail inside Box with a Bubblewrap error                                                                                      | Codex `sandbox: read-only` wraps commands in its own Bubblewrap, which cannot start inside Box                                                                               | use `sandbox: workspace-write`                                                                                                                |
| 10   | the model tries Code Mode and gets `EACCES`, then uses the shell                                                                            | Code Mode cannot run in Box                                                                                                                                                  | expected ([known gap](KNOWN-GAPS.md#codex-code-mode-cannot-run-in-box))                                                                       |
| 10   | `git push` or `gh` gets `403 credential refused by its source: <code>`                                                                      | `request_not_allowed`: outside the binding or profile; `access_withdrawn`: binding removed; `route_not_ready`: no route                                                      | check the registry, the binding and its profile ([git README](git/README.md))                                                                 |
| 11   | the search finds a PEM private key in `/home/node/.openclaw-node/client/credentials.sqlite`                                                 | the file node's own device key                                                                                                                                               | expected; check that the App key's content has no match                                                                                       |
| 12   | `git` shows only "The requested URL returned error: 403"                                                                                    | `git` hides the response body                                                                                                                                                | read the reason with `gh api` without `--jq` (with it, `gh` fails parsing the reply)                                                          |
| 13   | next revision waits in `REPOSITORY_GIT_MATERIAL_PENDING`                                                                                    | the last prepared attempt has `custody` `unknown`: its revoke could not reach the issuer (stopped after unwiring)                                                            | wait until `greatest(started_at + 72 min, provider_expires_at + 60 s)`; next time stop while GitHub is still wired                            |
| 13   | model source withdrawal returns `409` on a stopped Agent                                                                                    | withdrawal needs an active revision                                                                                                                                          | withdraw before stopping ([known gap](KNOWN-GAPS.md#withdrawing-a-model-source-needs-an-active-revision))                                     |
| 13   | `DELETE` of the source returns `409`, "still references the credential source"                                                              | the Agent still names the source                                                                                                                                             | PATCH the Agent to drop it first; right after that PATCH, `409` lasted about 10 seconds: repeat                                               |
| 13   | a deleted Secret still appears in a datastore search                                                                                        | K3s keeps old revisions until compaction                                                                                                                                     | search again after 5 minutes                                                                                                                  |

## Optional refusals

For runbook step 12. `turn` opens a new chat each call.
`git ls-remote https://github.com/<owner>/<other-repo>.git` fails with `403`
and `gh api repos/<owner>/<other-repo>` prints
`credential refused by its source: request_not_allowed`, with no use row. A
PATCH to `repositoryBindings: []` while running sets the attempt's `custody`
to `revoked`; the next `git ls-remote` of your repository fails with `403`
while chat still answers.

## AppArmor profiles

On Ubuntu 24.04, load one file under `/etc/apparmor.d/` with
`sudo apparmor_parser -r <file>`. Use one path glob per profile; replace
`<box-dir>` with the directory holding the Box programs:

```text
abi <abi/4.0>,
include <tunables/global>
profile strands-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
profile strands-box <box-dir>/* flags=(unconfined) {
  userns,
}
```

## What the existing checks prove

- **`verify-native.ts`**: Box starts Codex and fences the workspace. No OCE,
  model or GitHub.
- **[Ordinary chat](ordinary-chat/README.md)** and
  **[installed ordinary chat](ordinary-chat/installed.md)**: OCE drives Box and
  the file node for one turn. Synthetic model, no credentials, no GitHub.
- **`strands-box-protected.test.ts`, `-protected-gh.test.ts`**: Driver, host
  and OCE decisions with stock `git` and `gh`. Stand-in Box and GitHub.
- **`strands-box-source-native.test.ts`, `-model-native.test.ts`**: a real Box
  asks a request-time source and injects a model key. No installed OCE, no
  github.com.

## Not covered

- Installed runs on Linux ARM64. Box releases ship for ARM64, but every
  installed GitHub run was on x86-64 with the fork build
  ([known gap](KNOWN-GAPS.md#box-releases-ship-for-linux-arm64-only)).
- More than one execution per host, more than one Worker replica, or a Box
  host on a different node from the Worker and Gateway.
- Model ids other than the one id the proven runs sent, endpoints with WebSocket transport, and
  public model certificates without an upstream CA bundle.
- A Controller image built with `pnpm-lock.yaml` regenerated, as
  [the documented procedure](../../../docs/reference/drivers/selection.md#package-identity-and-factory-exports)
  requires. The runs added one stage over the stock `runtime` target that
  copied the unpacked package into
  `/app/apps/controller/node_modules/@openclaw-enterprise/example-strands-box-driver/`
  and added it to `/app/apps/controller/package.json`, without updating
  `pnpm-lock.yaml`.
- Rules on draft state or branch names for `gh` API requests
  ([known gap](KNOWN-GAPS.md#oce-applies-no-draft-or-branch-rule-to-ghs-github-api-requests)):
  the prompt and the App's permissions are the only limits.
- A scripted model against real GitHub. `git/controlled-git-model.ts` is for
  rehearsal against a stand-in; it never ran against github.com.
