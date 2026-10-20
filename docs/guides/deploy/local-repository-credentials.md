# Configure local Agent repository access

Before starting a fresh Kubernetes-only development installation, prepare a
private directory containing the approved GitHub App key and repository policy.
The launcher creates the initial OpenClaw Namespace first, substitutes its actual
ID into the registry, and enables the repository credential service through the
existing Helm release. Repository access is supported without a Sandbox Driver,
or with OpenShell through the [OpenShell Git route](#use-the-openshell-git-route);
follow the [broker installation guide](../repository-credentials/installation.md)
for production or an already running Installation. This launcher always uses a
GitHub App. To test clone, push and `gh` with a token your host already holds,
use the standalone [host token procedure](../repository-credentials/development-token.md).

## Prepare the approved inputs

Create an absolute private directory outside the checkout. Place these files in it:

| File                  | Contents                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry.json`       | The [canonical registry](../../reference/repository-credentials.md#canonical-platform-registry) with the real App, installation, and repository IDs and the allowed repository profiles. Each repository must have exactly one Namespace policy, with its `namespaceId` set to the literal `${OCC_INITIAL_NAMESPACE_ID}`. |
| `private-key.pem`     | The existing RSA private key for that GitHub App, readable only by the current user.                                                                                                                                                                                                                                      |
| `upstream-cidrs.json` | A JSON array of operator-approved IPv4 `/32` endpoints for the actual GitHub HTTPS destinations.                                                                                                                                                                                                                          |

For example, copy `deploy/examples/repository-credentials/registry.json`, replace
its example identities, set the literal Namespace placeholder, and reduce the
profiles to those explicitly approved. Add `pushRefAllowlist` where needed; an
unlisted repository receives no grant. Do not add a second Namespace policy.
Use the current operator-approved addresses actually reached after network translation.
Cover the addresses that both `github.com` and `api.github.com` can resolve to;
GitHub rotates DNS answers, so one successful lookup or API request does not
establish Git transport connectivity. Review the `git` and `api` inventories in
[GitHub Meta](https://api.github.com/meta) when preparing the allowlist.
Each entry must be a canonical IPv4 `/32`; broad ranges are rejected. The
metadata also includes broader networks, and host DNS alone does not prove
the address seen after cluster network translation. Verify the actual path in
the selected cluster before supplying the endpoints. Update the input and
recreate this disposable installation when provider endpoints change.
The service independently validates the full registry before accepting requests.

Set the directory to mode `0700` and the private key to mode `0600`. Then run:

```bash
export OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY='/absolute/private/repository-inputs'
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./scripts/dev-up
```

The launcher builds the broker service from this checkout and imports its
immutable digest. Alternatively, set `OCC_DEVELOPMENT_REPOSITORY_IMAGE` to a
locally available, provenance-verified digest whose source commit label matches this
checkout. For a selected controller/runtime pair, apply the same
[image selection requirements](../quickstart.md#optional-use-matching-published-images).

The launcher creates a private local CA, name-constrained to exactly
`git.<platform-namespace>.svc.cluster.local`, and a TLS certificate for that
host. It discards the CA key after signing, stores the leaf key and a copy of
the App key in the private development state directory, and sends only the
public CA to repository consumers. The leaf and CA expire after three months.
Automatic renewal is not configured. Recreate the
disposable installation before expiry, or use the production procedure for a
managed certificate lifecycle. Keep the input and state directories private.

Before `dev-down`, stop any Agent using repository access and confirm its
credential sessions are disposed while the broker and provider egress are still
available. A stopped Agent alone does not confirm disposal. Inspect the exact
[private session status](../../reference/repository-credentials.md#sessions-and-closure)
and retain whether each credential was revoked or expired. If a session is
pending, uncertain, missing, or cannot be inspected, retain the cluster and
state for recovery. `dev-down` deletes the owned cluster and its state without
checking repository credential cleanup; it does not delete the input directory.
The development launcher cannot enumerate all historical cleanup obligations,
so individual session checks do not establish installation-wide cleanup.

Startup waits for the worker and for the authenticated repository-options API
to return exactly the configured references and profiles. That verifies
configuration and discovery, not a Git operation or model turn. To exercise
actual repository access, continue with the [Agent repository workflow](../repository-credentials.md#create-and-deploy-an-agent)
and verify both an approved operation and a denied operation with the authorized
App and model credentials. The generated broker allowance is limited to its
exact hostname; existing explicit Codex denies remain in force.

## Use the OpenShell Git route

To try [Git and draft pull requests through OpenShell](../../reference/repository-credentials/openshell-git.md)
locally, select OpenShell and the route with the same input directory:

```bash
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_OPENSHELL_GIT=1
./scripts/dev-up --sandbox-network-policy-file /absolute/sandbox-policies.yaml
```

The launcher installs stock OpenShell 0.1.4 with its own PKI and mutual TLS,
serves the `oce-prepared-git` middleware from the worker, and registers it with
the Gateway once the worker answers. It sets `drivers.repo.openShell` and the
Helm `openshellGit` block, and withdraws the default `source-control` policy, so
the policy file must allow at least one other host and none of the GitHub hosts.
Use `transport: git-and-draft-pr` with a `pullRequestBase`, or `git-only`.

Before creating the cluster it refuses a container engine kernel older than
Linux 6.2 (Sandboxes need Landlock ABI v3) and the protected profile, which
this route cannot combine with. Set `approvalPolicy: never` for unattended
Codex commands, as the reference describes.

For a synthetic origin instead of GitHub, also set
`OCC_DEVELOPMENT_OPENSHELL_GIT_FIXTURE_NETWORK` to a Docker network (Docker 28
or newer) holding it, with its one address in `upstream-cidrs.json` and outside
the private and special-use ranges OpenShell refuses. Its CA is then required
twice: as `issuer-ca.crt` for the worker, and in the PEM bundle named by
`OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_CA_FILE`, which the launcher adds to a
local copy of the supervisor image. The launcher attaches the node and answers
`github.com` and `api.github.com` with that address in cluster DNS.
`scripts/ci/openshell-git-installed.mjs` runs this profile end to end.
