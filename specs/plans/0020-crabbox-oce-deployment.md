---
rfc: ../rfcs/0020-crabbox-oce-deployment.md
---

# Implementation plan: Deploy OCE development environments with Crabbox

- **ID:** RFC-0020 (primary plan)
- **Delivery status:** Planned
- **Owner:** OCE deployment and development-launcher contributors
- **Authority:** [RFC-0020](../rfcs/0020-crabbox-oce-deployment.md)
- **Source baseline:** Enterprise `8642bef0e3a3`; Crabbox `3d9260e7`; Tailscale `v1.104.1`

## Outcome and scope

Deliver the RFC's [goals](../rfcs/0020-crabbox-oce-deployment.md#goals): run the
existing development profile on a remote host and make its normal console usable
over the tailnet. Keep OCE authentication unchanged. Implementation starts after
responsible maintainers accept the RFC and its deployment scope.

The launcher already owns cluster creation, bootstrap credentials, authenticated
Installation checks, Namespace readiness, state ownership, and rollback. Crabbox
already owns leases, checkout synchronization, hydration, tool-environment reuse,
and release. The new wrapper connects those mechanisms and manages the Serve
publication; it does not implement another deployment lifecycle.

## Implementation

### 1. Reuse the authentication URL in the local launcher

Implement [the RFC's origin contract](../rfcs/0020-crabbox-oce-deployment.md#console-origin-and-authentication)
by accepting the existing `OCC_AUTH_BASE_URL` as a new local-launcher input.
Trace both entry points: `scripts/dev-up` delegates Kubernetes startup to
`internal/occcli/dev.go`, then `occdev.Up` selects `upK3d` for the Kubernetes
control plane. This owns a local k3d cluster; it is not the production procedure
for installing into an existing cluster. Docker is the container engine, not
this profile's Compute driver. Compose control-plane profiles are excluded.

Reuse one Go validator before deployment side effects. Reject invalid or explicitly
empty inputs and unsupported profiles through both CLI and script entry points.
Accept and normalize the RFC's HTTPS origin syntax. Preserve defaults when unset.
Do not change backend authentication admission or the separately generated
Compose/OpenShell `OCC_DEVELOPMENT_BROWSER_ORIGIN`.

In the first generated Helm values, select the override instead of overwriting it
with the localhost hostname. Set `auth.baseUrl` to the override and derive
`agentNativeAdmin.sharedCookieDomain` from its host and `agentNativeAdmin.domain`
as `agents.<override host>` in `developmentBrowserHosts`, so the chart's and
controller's cookie-domain checks pass. Keep `agentNativeAdmin` enabled, shared
session cookies, private `gatewayRouting`, the bootstrap administrator, password
sign-in, and the loopback API exactly as in Local Setup. Print the external
console URL. Keep password-only startup's loopback API, service-key,
Installation, and Namespace checks independent of Serve publication.

The backend setting exists today; caller support in this launcher does not.
Exporting it alone currently has no effect on this path. Neither trusted proxies
nor Agent `controlUi.allowedOrigins` replaces the console's configured origin.
Do not add a second wrapper Helm upgrade or a new backend authentication setting.

### 2. Reuse prerequisite setup

Use the existing [`setup-tools.sh k3d`](../../scripts/ci/setup-tools.sh) profile
for Docker verification, kubectl, k3d, Helm, and yq. Do not add another toolchain
profile or copies of these installers.

Go is the missing prerequisite on a fresh host. Install a supported, exactly
pinned Go 1.27 patch in a hydration step using the existing
[`download-pinned.sh`](../../scripts/ci/download-pinned.sh) checksum/retry helper.
Local Crabbox `actions/setup-go` verifies an installed Go; it does not install it.

### 3. Add host hydration

Create `.github/workflows/crabbox-hydrate.yml` using Crabbox's existing
[hydration contract](https://github.com/openclaw/crabbox/blob/3d9260e7a37e025ed36b3c38fbcf1ae50e4a3520/docs/features/actions-hydration.md#authoring-a-hydrate-workflow).
Use its supported local steps and a `workflow_dispatch` trigger.

Check the RFC's host prerequisites before OCE host preparation. Install missing
Docker/tool packages, enable working Docker access, and apply the documented
Codex sandbox host setting. Use the CI-pinned Node version and repository-pinned
pnpm. Verify quickstart disk capacity and required ports. After changing Docker
group membership, verify access in a fresh SSH session; the current shell does
not acquire new supplementary groups. Reuse the k3d profile and publish readiness
only after setup succeeds.

Persist tool paths through Crabbox's canonical non-secret `ENV_FILE`, including
paths supplied by the existing setup helpers. Later runs reuse this environment;
no second environment file is needed. The logging-specific CI Docker action is
not appropriate here because it stops and replaces the host daemon.

### 4. Add the thin deployment wrapper

Add `scripts/crabbox/oce-dev` with `up [--tailscale]` and `down` commands. Select
`OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes`,
`OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`,
`OCC_DEVELOPMENT_CONTAINER_ENGINE=docker`, and
`OCC_DEVELOPMENT_SANDBOX_DRIVER=none`; unset `OCC_DEVELOPMENT_SIGN_IN`.
Use an owned private state directory outside the synchronized checkout.
Keep publication recovery records outside launcher state, because `dev down`
removes that directory. Keep the publication target consistent with the
launcher's API port. Use ordinary Linux locking for wrapper operations and leave
the launcher's own state lock intact.

For `up`:

1. Validate the selected configuration. With Tailscale, derive the external origin
   from the certificate-eligible machine name, pass it as `OCC_AUTH_BASE_URL`,
   and refuse conflicting publication or inherited URL values. The base job
   explicitly unsets the URL override.
2. Install locked dependencies, build the CLI, and run `scripts/dev-up`. Reuse its
   authenticated readiness checks and rollback; do not duplicate them or parse
   human-readable output to establish readiness.
3. After successful startup, configure the RFC's TLS-terminated TCP publication.
   Verify ownership and retain enough information to recover an interrupted or
   uncertain publication operation without overwriting unrelated configuration.
4. Check the tailnet HTTPS console with normal certificate validation. If
   publication or that check fails, clean up the owned publication and report
   the surviving installation and recovery action.

For `down`, use `scripts/dev-down` for installation removal and remove only the
matching owned Serve publication. Attempt both independently, report partial
failure, and preserve recovery information until cleanup succeeds. Reuse the
existing CLI build command if rebuilding is necessary. No new cluster/state
cleanup implementation belongs in the wrapper.

Resolve exact record formats, shell traps, status parsing, and retry mechanics
during implementation. They must satisfy the RFC's ownership and recovery
outcomes without creating another general-purpose lifecycle framework.

### 5. Define the Crabbox jobs

Create `.crabbox.yaml` using the existing job mechanism:

| Job                    | Work                                                                                                  | Lease handling                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `oce-deploy`           | Hydrate a lease from a qualifying provider and run the wrapper's base deployment.                     | Keep the lease after success or failure. |
| `oce-deploy-tailscale` | Reuse the deployment job with required tailnet SSH and private publication.                           | Keep the lease after success or failure. |
| `oce-teardown`         | Reuse the retained workspace/tool environment and run `down`, without new hydration or checkout sync. | Release only after successful cleanup.   |

Set deploy jobs to `stop: never` and teardown to `stop: success`. Teardown uses
`noSync: true` and omits hydration, preserving the retained workspace and tools.

The caller selects the provider. Deploy jobs request the RFC's bounded managed
lifetime; static hosts provide persistent use. Validate job expansion with
Crabbox's job-list and dry-run commands.

Teardown must target an explicit lease ID. Retain that lease when tearing down
for redeployment; otherwise successful teardown releases it. Do not collect
credential-bearing state as artifacts.

### 6. Document the supported flow

Update the development setting reference and environment-variable cheat sheet.
Add a remote development guide under `docs/guides/deploy/`, register it in
`docs.json`, and link it from local development and remote-console troubleshooting.
Explain supported hosts/profile, password authentication identical to Local Setup, private
credential access, lease lifetime/reuse, and teardown/recovery. Distinguish local
k3d from production installation and Compose. Explain that the tailnet origin
is the single supported browser login in that mode; localhost service-key CLI
access remains. The base job retains the tunnel and development-CA procedure.

Update `docs/layout.md` and the owning launcher flow as
[local-dev](../../.agents/skills/local-dev/SKILL.md) requires. Current procedures
belong in the guide. Update RFC implementation status and the index together when
actual delivery evidence supports it.

## Verification

Implementation acceptance checks remain **Not run**. Record the implementation revision, host/provider,
Tailscale version, results, and unavailable prerequisites.

| RFC goal | Required proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Fresh installations on a `tailscale`-capable cloud provider, a second qualifying provider, and a static host, covering Ubuntu 24.04 and 26.04. Existing launcher checks establish authenticated Installation access and Namespace readiness. Verify refusal of a non-Ubuntu image.                                                                                                                                                                                                 |
| 2        | A permitted second device opens the normal login page, signs in, uses an authorized resource, and logs out. Authentication and permission denials match local setup; denied/off-tailnet devices cannot connect.                                                                                                                                                                                                                                                                    |
| 3        | Refuse missing tailnet SSH or certificate eligibility. Verify certificate/publication failure cleanup and useful recovery output.                                                                                                                                                                                                                                                                                                                                                  |
| 4        | Extend existing launcher coverage for invalid origins, unsupported entry paths, and unchanged defaults. Verify generated API/bootstrap URLs, native admin still enabled with the cookie and native admin domains under the override host, and routing retained. Exercise real k3d and tailnet access; refuse foreign and former localhost browser origins while loopback service-key CLI still works. Complete an Agent model/workspace operation to prove routing remains usable. |
| 5        | Verify explicit-lease teardown/redeployment, publication ownership, interruption recovery, unrelated configuration preservation, and partial cleanup failure. Confirm startup failure creates no Serve publication.                                                                                                                                                                                                                                                                |
| 6        | Inspect actual job logs and artifact configuration for credential exposure; keep state private.                                                                                                                                                                                                                                                                                                                                                                                    |

Focused script checks can verify orchestration; they do not replace real launcher,
host, browser, and tailnet proof. Required unrun outcomes keep delivery incomplete.
Use documentation checks, without product tests, for this proposal.

## Delivery record

Not started. Source review at Enterprise `8642bef0e3a3` traced local startup,
Helm rendering, authentication guards, and loopback readiness. Configuration and
Helm probes support this design; they do not qualify the unimplemented launcher
input, Crabbox jobs, or remote browser flow. Rendering the current chart with a
tailnet `auth.baseUrl`, native admin enabled, and the cookie and native admin
domains under that host passed; keeping the `.oce.localhost` cookie domain with a
tailnet origin fails the chart's cookie-domain check.
A separate existing local deployment passed HTTPS, password sign-in/sign-out,
foreign-origin refusal, and service-key Installation access checks. Its older
image is not qualification of the reviewed main revision or the proposed jobs.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-13: Authored against Enterprise `3d180654c` and Crabbox `3d9260e7`.
- 2026-10-13: Align all RFC goals with concrete steps/checks; preserve local authentication, select header-free TCP publication, and specify credential inputs, validation, ownership, and failure recovery (Tailscale `v1.104.1`).
- 2026-10-13: Reuse launcher readiness, k3d/download helpers, and Crabbox environment; publish after startup. Keep implementation mechanics in implementation rather than prescribing them here.
- 2026-10-14: Recheck current local k3d code and quickstart; reuse `OCC_AUTH_BASE_URL` through a new launcher input, preserve routing/readiness, and distinguish the single browser origin from loopback CLI access. Specify profile, hydration, job cleanup, and acceptance checks.
- 2026-10-14: Keep Local Setup authentication unchanged: email and password sign-in, native admin, and shared session cookies stay enabled. Only the browser origin and the cookie and native admin domains move to the tailnet host.
