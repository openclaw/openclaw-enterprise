---
tags: [human_verified]
# Backfilled from the verification tag recorded in e22f558c0.
last_verified: "2026-11-02"
---

# Push a Git branch from an OpenShell Agent

Use the Source-backed Git path to push an empty commit from a dedicated Codex
Agent to an approved test repository. TokenService holds the GitHub App signing
key and installation token. OpenShell Credential Proxy injects the token for
requests allowed by the Agent's saved repository policy.

This procedure uses the [unmerged cutover candidate](https://github.com/openclaw/openclaw-enterprise/pull/7224).
Live verification at `a009380c` covered a Codex turn, an allowed Git read, and a
denied Git read. Native Git push still needs live qualification. The recorded
human verification applies to the [pre-cutover push procedure](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/repository-credentials/openshell-git-push.md),
which main still supports.

## Before you start

- Use matching controller, runtime, CLI, and Helm artifacts from the candidate
  checkout. [Configure the TokenService and OpenShell Driver pair](../integrations/drivers.md#credential-delivery-during-cutover).
- Use a dedicated Codex Agent draft in a ready Namespace. Set up the
  [managed model Source](../deploy/deploy-first-agent.md#1-select-or-register-the-model-credential)
  before deploying. Save repository policy before the first deployment.
- Use an approved test repository with an initial commit. Install a GitHub App
  with **Contents write** and **Metadata read** on that repository. Keep its
  App ID, installation ID, and PEM signing key ready for Client registration.
- Use an Installation administrator for setup. In the operator shell, check
  `gh auth status` with a GitHub account approved to read the test repository.

<a id="1-enroll-one-repository-in-the-installation"></a>

## 1. Configure Source-backed repository access

1. [Configure the GitHub Backend and registry](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent).
   Use the short repository name in the registry and the Installation's
   `repositoryNetworkPolicyCeiling`. In the test Namespace's registry entry,
   select `github-repository` with `nativeGit: "v1"` and set `contents: write`
   and `metadata: read`. Set `access: write` for that repository in the
   [Installation ceiling](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/repository-credentials/access-levels.md#tokenservice-registry-example).
   In Helm, point `repositoryCredentials.registryConfigMapName` to the approved
   registry ConfigMap. Set the GitHub Backend's `registryPath` to
   `/etc/openclaw/repository-registry/registry.json`.
2. In **Credentials → Credential clients → Register client**, select
   **GitHub App**. Choose **Installation-wide** or the Agent's Namespace,
   enter the App ID, and select its PEM signing key. TokenService verifies
   the key and keeps it in private custody.

<a id="2-bind-the-agent-and-deploy-once"></a>

## 2. Grant the Agent access and deploy

1. In the Agent draft's **Repositories** settings, choose the registered
   Client and approved test repository. Select **Read/write Git**. Selecting
   or changing the Client requires Installation administration.
2. Select the Agent's model Source, then save the draft and deploy. The deployer
   needs permission to use a matching Git Source or create one in the
   Namespace. OCC resolves or enrolls that Source during deployment.
3. Wait for deployment to succeed and confirm that the Agent's `activeRevisionId`
   matches the deployed Agent revision. Send a model request through the running
   Agent and verify the reply before running Git.

<a id="3-push-the-first-empty-commit-through-openclaw"></a>

## 3. Push an empty commit

In the Agent's Control UI, ask it to run this block with the native shell in
its workspace. Open the Git tool output to see the result.
Replace `example/project` with the approved GitHub owner and repository. Choose
a new branch name allowed by the repository's branch rules. The managed request
path supplies authentication.

```sh
set -eu
export GIT_TERMINAL_PROMPT=0
repo=example/project
branch=oce-credential-check-UNIQUE-SUFFIX

git clone --no-tags "https://github.com/$repo.git" "$branch"
cd "$branch"
existing=$(git ls-remote --refs origin "refs/heads/$branch")
test -z "$existing"
git switch -c "$branch"
git -c user.name='Repository Agent' -c user.email='agent@example.invalid' \
  commit --allow-empty -m 'Verify OpenShell Git access'
git push origin "HEAD:refs/heads/$branch"
git rev-parse HEAD
```

Record the commit SHA from successful native tool output. If the push outcome
is uncertain, inspect the remote ref before taking another action.

## 4. Verify the remote ref

In the operator shell, use the same repository and branch and set `expected_sha`
to the commit reported by the Agent. These checks confirm that GitHub received
the expected empty commit.

```bash
repo=example/project
branch=oce-credential-check-UNIQUE-SUFFIX
expected_sha=REPLACE_WITH_COMMIT_SHA

remote_sha=$(gh api "repos/$repo/git/ref/heads/$branch" --jq '.object.sha')
changed_files=$(gh api "repos/$repo/commits/$expected_sha" --jq '.files | length')
test "$remote_sha" = "$expected_sha" &&
  test "$changed_files" -eq 0 &&
  printf 'Verified empty commit %s on %s\n' "$expected_sha" "$branch"
```

<a id="5-restore-read-only-access"></a>

## 5. Remove test write access

Stop the test Agent and wait for Stop to complete. To retain read access,
change the repository setting to **Read-only Git**, save the draft, and deploy
again. To remove all repository access, clear the repository selection and
save the draft.
