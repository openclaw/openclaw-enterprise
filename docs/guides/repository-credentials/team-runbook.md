# Set up repository access for a team

Connect one team repository to an organization-owned GitHub App, then ask an
embedded OpenClaw Agent to push a branch and open a draft PR. Start with an
existing [Kubernetes installation](../deploy/production-installation.md), an OCC
Namespace, and a repository approved for this exercise.

Repository access is opt-in: Helm's `repositoryCredentials.enabled` defaults to
`false`, Installation `drivers.repo` is optional, and an Agent must request a
repository binding. Workflows without those settings need no GitHub App. This
does not exempt a platform upgrade from its shared database prerequisites; follow
the [upgrade operations guidance](../../reference/settings/operations.md).

This path uses the App installation's authority. Personal GitHub user delegation
is not implemented. This procedure uses Kubernetes Compute, embedded
OpenClaw, `api_key` Harness authentication, and no Sandbox Driver. The separate
credential service holds the App key and GitHub tokens; OCC delivers bounded
gateway session material to the Agent. Do not put keys, tokens, or gateway bearers
in Agent configuration, images, examples, or logs.

## Register and install the GitHub App

A GitHub organization owner or authorized App manager prepares the App; an OCC
administrator configures the platform and Namespace policy, creates each Agent,
and [grants team members access](../topics/iam.md#let-a-person-run-an-existing-agent)
to deploy and operate it. GitHub App installation does not grant a person OCC
access.

1. In the organization's **Settings → Developer settings → GitHub Apps**, create
   an App with a descriptive team name and your team's homepage. For an App used
   only by this organization, select **Only on this account**. Leave user OAuth
   authorization and device flow unused. This integration needs no webhook
   receiver: deselect webhook **Active**. Follow GitHub's
   [registration procedure](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. For this PR workflow, set repository **Contents**, **Pull requests**, and
   **Issues** to **Read and write**, with **Metadata**, **Checks** and **Commit
   statuses** at **Read-only** to support all three
   [access levels](../../reference/repository-credentials/access-levels.md).
   OCE narrows each token to its selected level. This PR workflow uses
   Contributor with issue management off (`git-write`), so its token requests
   Issues read, not write. In the Console, choose **Contributor**, open
   **Customize access**, and turn off **Create and manage issues**. Leave other
   permissions unselected; workflow editing is not part of these levels.
3. [Install the App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
   on the organization and select **Only select repositories**, including the
   intended repository. For an existing installation, have its administrator
   [approve changed permissions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-permissions-of-a-github-app)
   before testing. Repository rules and branch protection still apply; do not
   grant a ruleset bypass for this exercise.
4. Record the numeric **App ID** from App settings, installation ID from its
   installation settings URL, and repository ID. Do not substitute the App client
   ID. In the administrator's already-authenticated workstation shell, obtain
   repository metadata without exposing credentials:

   ```sh
   gh api repos/example/project --jq '{repositoryId: (.id | tostring), repository: .full_name}'
   ```

5. [Generate an App private key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).
   Transfer the downloaded PEM through your approved secret-management process
   to the credential service's protected input. Keep it out of the Agent, API,
   worker container, source tree, shell arguments, and diagnostic output.

`example/project`, the numeric IDs in the examples, and `agent@example.invalid`
are hypothetical placeholders. Replace them before contacting GitHub.

## Configure the platform

Run from the OCE checkout. Copy these nonsecret examples into the protected
operator directory used by the [installation procedure](installation.md):

```sh
install -d -m 700 /secure/occ/repositories
install -m 600 deploy/examples/repository-credentials/registry.json \
  /secure/occ/repositories/registry.json
install -m 600 deploy/examples/repository-credentials/service-config.json \
  /secure/occ/repositories/config.json
```

Edit `registry.json`: replace the three GitHub IDs, canonical `owner/repository`,
and `replace-with-occ-namespace-id` with the server-assigned ID from
`occ namespace list`. Keep `application` as the Agent-facing repository reference.
The sample allows all three profiles for that Namespace and sets a 24-hour
maximum. Reduce its allowed profiles when the team needs less access.

Merge the [Installation fragment](../../../deploy/examples/repository-credentials/installation.fragment.yaml)
into the existing Installation YAML. Preserve the existing Backend list and
Driver settings, including Compute images and network rules: the fragment is not
a complete Installation. Its Backend ID, registry Backend ID, and service
`backend.backendId` must all be `repository-backend`. The repo Driver ID must
match its Backend member. Adjust the release label `oce` if your release differs.

The [service config](../../../deploy/examples/repository-credentials/service-config.json)
is a Kubernetes projection input. The sidecar supplies protected App-key,
registry, and TLS paths; this file alone is not a standalone-service config.
Follow [installation](installation.md) to provision the immutable registry
ConfigMap and separate service-config, App-key, TLS, and public-CA Secrets, then
set the documented `repositoryCredentials` Helm values. Build from the intended
source and select immutable controller, credential-service, and full Agent runtime
images. Use one worker/service owner with `Recreate`.

Before applying the release, verify these network inputs:

- The certificate SAN covers the configured internal Service hostname; the
  separate public CA is trusted by the Agent. Clients use HTTPS 443; the Service
  forwards to worker-sidecar port 8443.
- Cluster DNS works from both the worker and Agent Pods. Match Helm's `dns`
  selectors and Compute's DNS settings to your actual resolver. Preserve UDP/TCP
  DNS access required by your cluster networking.
- `repositoryCredentials.upstreamCidrs` contains operator-maintained approved
  ranges for the actual `github.com` and `api.github.com` HTTPS destinations.
  Check resolved addresses against effective egress policy. A disposable `/32`
  DNS pin is not a production configuration: do not hardcode GitHub addresses in
  production CoreDNS, disable TLS verification, or open unrestricted egress.
- The private credential gateway admits approved Agent workloads and rejects
  unrelated workloads and external clients. A Service name alone provides no
  isolation; worker and sidecar share a Pod's network namespace.

Render and apply through the existing [installation commands](installation.md#install-and-verify).
Check the mounts and tenant RoleBindings there before admitting an Agent.

## Run the team workflow

Follow [Agent creation and deployment](../repository-credentials.md#create-and-deploy-an-agent)
to prepare model access, native command tools, and the Agent-principal Secret
grant. Its create request includes:

```json
{
  "repositoryBindings": [{ "repositoryRef": "application", "profile": "git-write" }]
}
```

This is a fragment of the Agent request, not a complete request or a model
credential. Wait for the requested revision to become active, then send the
Agent a normal task through the [TUI procedure](../repository-credentials.md#ask-the-agent-to-work-in-the-repository).
Ask it to use a fresh approved branch and repository-local author identity:

```sh
git clone https://github.com/example/project.git
cd project
git fetch origin
git switch -c agent-repository-check
git config user.name "Repository Agent"
git config user.email "agent@example.invalid"
# Make the agreed change, then stage and commit it.
git add repository-access-check.md
git commit -m "Verify team repository access"
git push origin HEAD:refs/heads/agent-repository-check
gh pr create -R github.com/example/project --base main --head agent-repository-check \
  --draft --title "Repository access check" --body "Verify the team Agent workflow."
```

Replace the branch if it already exists and use the repository's actual base
branch. Native Git and the bundled `gh` router select the admitted binding. The
Agent does not run `gh auth login`, receive a PAT, or open a session manually.

## Verify, troubleshoot, and finish

Have a human inspect the remote branch's commit and draft PR. Record the source
commit, immutable images, Agent/revision IDs, commit SHA, and PR URL without
credentials. A ready Pod or valid configuration does not prove this workflow;
repeat the installed check after changing controller/runtime images.

| Symptom                                                 | First check and recovery                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admission rejected                                      | Compare the actual OCC Namespace ID, repository reference, selected profile, Backend IDs, and immutable registry across API, worker, and service.                                                                                                                                                                              |
| TLS error or connection timeout                         | Check DNS, certificate SAN/public CA, Service 443 → 8443, and effective DNS/HTTPS NetworkPolicies. Keep certificate verification enabled.                                                                                                                                                                                      |
| GitHub access denied                                    | Check repository selection, approved App permissions, numeric repository identity, repository rules and the selected access level. For this PR workflow, use Contributor with issue management off (`git-write`); in the Console choose **Contributor**, open **Customize access**, and turn off **Create and manage issues**. |
| Push or PR response uncertain                           | Inspect GitHub's branch/PR state before retrying; do not blindly repeat a possible write.                                                                                                                                                                                                                                      |
| Session lost after service restart, or deadline reached | Inspect retained cleanup obligations, then explicitly deploy a new authorized revision. Its deployment does not settle earlier cleanup or replay operations.                                                                                                                                                                   |

When finished, stop the Agent through its normal lifecycle. Confirm runtime
retirement and [credential cleanup](../../reference/repository-credentials.md#sessions-and-closure);
`CLOSED` is not proof of completed revocation. Close the exercise PR and remove
only its temporary branch through your team's GitHub workflow. Keep the shared
App and platform Secrets while other Agents depend on them. For permanent
offboarding, retire affected Agents, resolve cleanup, and then remove the
repository from the App installation and publish a new immutable registry policy.
