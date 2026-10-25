# Native Git with a prepared GitHub App credential

Use this profile when a dedicated Codex Agent needs to clone a private repository
and push one review branch. It is an explicit Installation choice. Existing metadata grants do not authorize it. Qualify the exact deployment before using a
real provider credential.

The first supported topology is the dedicated Codex Harness owned by Kubernetes
Compute, with no Sandbox Driver selected. The Agent receives a short-lived OCE
repository session, not a GitHub credential. Native Git verifies HTTPS to the OCE
repository service. This topology does not provide OpenShell network isolation.
An Installation that requires OpenShell must not fall back to it automatically.
For the protected OpenShell qualification boundary, see [OpenShell Git](protected-openshell-git.md).

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

By default (`limits.exchangesPerSession: 4`), one repository session handles at most four
Git requests at the same time. A fifth concurrent request gets HTTP 503, and Git shows
`The requested URL returned error: 503`. The service-wide `limits.exchanges` bound (default 32)
also answers 503, so a session can get it with fewer requests. Run parallel clones and
fetches in groups no larger than the configured
[service limits](../repository-credentials.md#client-routing-and-limits).

A separately selected protected Credential Proxy can authorize a bounded
`metadata-read` operation. Its [response policy](../../../apps/controller/src/drivers/repo/github/credentials/metadata-response.ts)
requires HTTP 200 and the exact repository ID and full name. After stream end, the
[transport](../../../apps/controller/src/drivers/repo/credentials/transport/upstream.ts)
rejects actual trailers (a declaration alone is not one), enforces byte limits before and
after rewriting, then releases the configured `{ id, full_name }` as fixed JSON with
no-store headers. Streamed responses cannot make that guarantee.

## Let the Agent open a draft pull request

If the task includes handing work to a reviewer, explicitly select
`transport: git-and-draft-pr`, keep one exact writable review ref, and set
`pullRequestBase: main` in the registry policy. The worker then requests
`pull_requests: write` as well. GitHub does not limit that permission to drafts;
the broker limits it to creating one draft from the review branch to the selected
base. Later feedback and commits use ordinary Git on the same branch. The Agent may
also force-push or delete that branch, and deleting it closes the draft; protect the
branch on GitHub to stop either.

On this route, each grant allows one draft. The grant is the repository, review ref and
base, and every Agent and version that has it shares the allowance. Closing the draft or
deleting its branch does not give the allowance back. A later create gets
`operation_conflict`, and GitHub does not receive it. Changing the policy's review ref, base
or transport makes a new grant: after a new version deploys, it allows one more draft. The
`draftPullLimit: none` opt-out applies only to [OpenShell Git](protected-openshell-git.md#use-the-admitted-repository).

The Agent uses `oce-github pr-create --draft` with the head, base, title, optional
explicit `--body` text and a fresh operation ID. The helper refuses `--body-file`;
the JSON request body must fit within 64 KiB. If the reply is lost, look for the draft at GitHub;
do not submit another create. The receipt identifies the admitted Agent session,
not the person who assigned the task. Use a trusted team for the initial trial;
do not treat that receipt as per-person task authorization.

## Install and check

The removed `github-app` and `github-app-registry` startup modes and the legacy
Installation `drivers.repo` selection fail closed.
Stop admissions and drain accepted work on its original owner before switching.
Do not transfer an App key, broaden an approval or replay an uncertain operation.

Select `repositoryCredentials.authority: prepared-git` in the chart and
`repository.preparedGitHub` in the Installation. Select the policy ID and session duration
under `repository.id` and `repository.configuration.sessionDurationSeconds`. Select
`repository.nativeSender.controlSocket` and `repository.nativeSender.publicCaPath`
explicitly. Keep the Backend’s `drivers.repo` policy ID equal to `repository.id`.
Omit the Installation’s `drivers.repo`, Sandbox and Credential Proxy selections. Mount the signing and custody
keys in the worker; do not copy them to the Agent or broker. OCE must be able to
bind this repository session to the admitted revision and restrict broker ingress.
Every fresh native OPEN carries `preparedOnly: true`. The receiver requires a
prepared backend, and the durable attempt records protocol 3. Readiness alone
cannot authorize OPEN; an older receiver rejects the new request field. Existing
v1 records support original-ID lookup and close, never fresh creation or native
release. The independent direct development-token tool cannot answer this request.
If OCE cannot verify prepared authority, do not fall back to an ambient token or
grant broader broker access.
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

## Change the issuer

Changing the worker's GitHub API origin or issuer CA (`issuerCaPath`), for example
from a test fixture to `github.com`, starts a new issuer. OCE never sends a token
to an issuer other than the one that prepared it. The active version gets no new
token until a new version deploys. When a version holding a token from the previous
issuer is replaced or withdrawn, the worker retires that token without revoking it
and logs `worker.error` with `PREPARED_GITHUB_RETIRED_UNREVOKED`
(`reason: issuer_authority_changed`, the Namespace, revision, `repositoryRef` and
`providerExpiresAt`), leaving revocation to the issuer that prepared it. If no
worker with the previous setting is still running, the token stays valid at
GitHub until that time, at most an hour.
