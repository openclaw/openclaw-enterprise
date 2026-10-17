# Native Git with a prepared GitHub App credential

Use this profile when a dedicated Codex Agent needs to clone a private repository
and push one review branch. It is an explicit Installation choice, not an upgrade
of an existing metadata-read grant. Qualify the exact deployment before using a
real provider credential.

The first supported topology is the dedicated Codex Harness owned by Kubernetes
Compute, with no Sandbox Driver selected. The Agent receives a short-lived OCE
repository session, not a GitHub credential. Native Git verifies HTTPS to the OCE
repository service. This topology does not provide OpenShell network isolation.
An Installation that requires OpenShell must not fall back to it automatically.
For the opt-in stock OpenShell trial, see [OpenShell Git](openshell-git.md).

## What a request authorizes

1. Grant one repository and one exact writable ref, such as
   `refs/heads/review/skipper-123`, using the
   [Git-only registry policy](push-ref-guardrail.md#enforce-the-ref-policy-at-the-gateway-for-a-github-app).
2. An OCE worker prepares a repository-scoped installation token in the background.
   Only that worker needs the App signing key and custody key. A Git request can use
   eligible, committed material or fail; it cannot ask the worker to mint a token.
3. The broker authenticates the Agent's session and checks the actual repository,
   Git operation and proposed refs. It sends only after the worker authorizes that
   use of the prepared credential. An authorization record is not a delivery receipt.

Reads cover the repository, not just the review branch. GitHub's `contents: write`
permission is not branch-scoped: protect important refs at GitHub independently,
without an App bypass. The Git-only profile exposes fetch and push, not GitHub REST or GraphQL.

## Let the Agent open a draft pull request

If the task includes handing work to a reviewer, explicitly select
`transport: git-and-draft-pr`, keep one exact writable review ref, and set
`pullRequestBase: main` in the registry policy. The worker then requests
`pull_requests: write` as well. GitHub does not limit that permission to drafts;
the broker limits it to creating one draft from the review branch to the selected
base. Later feedback and commits use ordinary Git on the same branch.

The Agent uses `oce-github pr-create --draft` with the head, base, title, optional
explicit `--body` text and a fresh operation ID. The helper refuses `--body-file`;
the JSON request body must fit within 64 KiB. If the reply is lost, look for the draft at GitHub;
do not submit another create. The receipt identifies the admitted Agent session,
not the person who assigned the task. Use a trusted team for the initial trial;
do not treat that receipt as per-person task authorization.

## Install and check

Select `repositoryCredentials.authority: prepared-git` in the chart and
`drivers.repo.preparedGitHub` in the Installation. Mount the signing and custody
keys in the worker; do not copy them to the Agent or broker. OCE must be able to
bind this repository session to the admitted revision and restrict broker ingress.
If it cannot, do not fall back to an ambient token or grant broader broker access.
The broker Service must record the same hostname selected for the session and route
HTTPS on port 443 to the selected worker on port 8443. A missing or mismatched
Service binding prevents admission, including when the chart and controller versions differ.

Before team use, chat with the Agent, then use that same Agent to clone, fetch an
independently known commit, and push a new commit to the allowed review ref. Read
the exact commit back independently. In a disposable test repository, also show
that the broker refuses another writable ref, rather than relying on a client hook.

To withdraw access, remove the repository binding on the running Agent. Confirm a
new authenticated fetch is denied and chat still works. Withdrawal cannot erase
an existing clone or recall a push already sent. If the outcome of a push is
unknown, inspect the remote ref before deciding what to do; do not replay it.
