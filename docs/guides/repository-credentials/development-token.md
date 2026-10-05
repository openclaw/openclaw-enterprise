# Test repository access locally with a host GitHub token

Use this procedure to clone, push and call the GitHub API from the credential
client container with a token your host already holds, without a GitHub App.
The token stays in the credential service container; the client receives only a
session bearer. This is development-only; the
[development token reference](../../reference/repository-credentials/development-token.md)
defines its gates, scope and limits. Agents started by `occ dev up` still use the
GitHub App through the [local Agent guide](../deploy/local-repository-credentials.md).

Never mount `~/.ssh`, forward `SSH_AUTH_SOCK`, or pass `GH_TOKEN`/`GITHUB_TOKEN`
into the client. The gateway uses HTTPS only, and the client needs only its
session directory.

## Choose a repository and token

Use a scratch repository. A fine-grained token limited to that repository
(Contents read and write, Metadata read) bounds the damage if a session bearer
leaks, and is the only class that may enable read-only GraphQL. The host `gh` token
(`gho_`) works for clone, push and REST; GraphQL stays refused. Find the
repository ID:

```sh
gh api repos/OWNER/scratch-repo --jq .id
```

## Prepare inputs

Build the emitted artifacts and both images as described in
[Run the repository credential service](standalone-service.md#container-images).
Then create a private input directory owned by the UID the service runs as. Using
your own UID avoids `sudo`:

```sh
export CREDENTIAL_SERVICE_UID=$(id -u) CREDENTIAL_SERVICE_GID=$(id -g)
export INPUTS=/absolute/private/token-inputs
install -d -m 700 "$INPUTS"
```

Copy `deploy/examples/repository-credentials/service-config.development-token.json`
to `$INPUTS/config.json` with mode 0600, and set `repositoryId`, `repository`,
`gateway.publicOrigin` and `pushRefAllowlist`. Add `tls.crt` and `tls.key` (mode 0600) for the gateway hostname. Write the token last, into a fresh file, without
printing it:

```sh
rm -f "$INPUTS/token"
(umask 077; gh auth token > "$INPUTS/token")
test -s "$INPUTS/token" && stat -c '%a %u' "$INPUTS/token"
pnpm credentials:check-config "$INPUTS/config.json" --development-authority
```

Expect `600` with your UID, then a summary with
`"authority":"github-token-development"` and a `tokenClass`. Without the flag,
the check prints `invalid-configuration`.

## Start the service and open a session

Set the Compose variables from the
[standalone guide](standalone-service.md#container-images), with
`CREDENTIAL_SERVICE_INPUTS="$INPUTS"`, and add the development overlay:

```sh
compose="docker compose -f deploy/examples/repository-credentials/compose.yaml \
  -f deploy/examples/repository-credentials/compose.development-token.yaml"
$compose up -d service
docker logs "$($compose ps -q service)" 2>&1 | grep '"event":"started"'
pnpm credentials:operator open --socket "$CREDENTIAL_SERVICE_CONTROL/control.sock" \
  --duration-seconds 3600 --profile git-write \
  --output "$CREDENTIAL_CLIENT_SESSION" --ca "$INPUTS/tls.crt"
```

Starting with only `compose.yaml` exits with `repository credential service
failed`, because the process flag is missing.

## Clone, push and call the API

```sh
$compose run --rm client /session git clone https://GATEWAY_HOST/OWNER/scratch-repo.git /workspace/r
$compose run --rm client /session git -C /workspace/r push origin HEAD:refs/heads/agent/check
$compose run --rm client /session gh api repos/OWNER/scratch-repo
```

A push outside `pushRefAllowlist` fails twice over: the client hook refuses it
first, and with `--no-verify` the gateway answers 400 before anything reaches
GitHub. Both also refuse a branch name with an invisible or direction-changing
character, such as U+202E or U+200B. One push may update at most 256 refs; a
larger one (for example `git push --all` in a clone with many branches) gets
`HTTP 413` with code `push-ref-limit-exceeded`, so push branches in smaller
batches. `gh api graphql` fails unless GraphQL is enabled for a fine-grained
token, and even then mutations fail, including those behind `gh pr create`,
`gh pr comment` and `gh pr edit`.

## Close and clean up

```sh
pnpm credentials:operator close --socket "$CREDENTIAL_SERVICE_CONTROL/control.sock" --session SESSION_ID
$compose down
shred -u "$INPUTS/token"
```

`operator status` shows the session DISPOSED with no pending cleanup soon after
close. Delete test branches from the host, and revoke a fine-grained token you
created for the test.
