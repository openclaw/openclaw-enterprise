import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

type RunWorkloadScript = (script: string) => Promise<unknown>;

export async function verifyNativeGitPush({
  repository,
  runContributor,
  runReader,
}: {
  repository: string;
  runContributor: RunWorkloadScript;
  runReader: RunWorkloadScript;
}): Promise<void> {
  assert.ok(
    /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/i.test(repository),
    "The Git push proof requires an admitted owner/repo slug.",
  );

  const branch = `oce-git-proof-${randomUUID()}`;
  // The callbacks run these scripts as sh -eu in their respective Harness workloads.
  const setup = `
export GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1 GIT_HTTP_LOW_SPEED_TIME=20
url=https://github.com/${repository}.git
ref=refs/heads/${branch}
marker=${branch}
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
cd "$directory"
git init --quiet
fail() {
  printf '%s\n' "$1" >&2
  exit 1
}
remote_commit() {
  listing=$(git ls-remote --refs "$url" "$ref" 2>/dev/null) || return
  printf '%s\n' "$listing" | cut -f1
}
commit() {
  git -c user.name='OCE test' -c user.email=oce-test@example.com -c commit.gpgSign=false \
    commit --quiet --allow-empty -m "$1"
}
`;
  const create = `
before=$(remote_commit) || fail 'Could not check that the proof ref is absent.'
test -z "$before" || fail 'The proof ref already exists.'
commit "$marker"
expected=$(git rev-parse HEAD)
git push --quiet --force-with-lease="$ref:" "$url" "HEAD:$ref" >/dev/null 2>&1 ||
  fail 'Contributor could not create the proof ref.'
after=$(remote_commit) || fail 'Could not read back the Contributor push.'
test "$after" = "$expected" || fail 'Contributor push did not publish the expected commit.'
`;
  const refuse = `
git fetch --quiet --no-tags "$url" "$ref" >/dev/null 2>&1 ||
  fail 'Read Agent could not fetch the proof ref.'
git checkout --quiet --detach FETCH_HEAD
expected=$(git rev-parse HEAD)
test "$(git log -1 --format=%s)" = "$marker" || fail 'Read Agent fetched the wrong commit.'
before=$(remote_commit) || fail 'Could not observe the ref before the Read Agent push.'
test "$before" = "$expected" || fail 'Read Agent did not fetch the current remote ref.'
# A commit descended directly from the fetched ref makes this an ordinary fast-forward push.
commit "$marker-denied"
if git push --quiet "$url" "HEAD:$ref" >/dev/null 2>&1; then
  fail 'Read Agent could push to the proof ref.'
fi
after=$(remote_commit) || fail 'Could not observe the ref after the Read Agent push.'
test "$after" = "$expected" || fail 'Read Agent push changed the proof ref.'
`;
  const cleanup = `
current=$(remote_commit) || fail 'Could not inspect the proof ref for cleanup.'
test -n "$current" || exit 0
git fetch --quiet --no-tags "$url" "$ref" >/dev/null 2>&1 ||
  fail 'Could not fetch the proof ref for cleanup.'
test "$(git rev-parse FETCH_HEAD)" = "$current" || fail 'Proof ref changed during cleanup.'
case "$(git log -1 --format=%s FETCH_HEAD)" in
  "$marker"|"$marker-denied") ;;
  *) fail 'Proof ref contains a commit this test does not own.' ;;
esac
git push --quiet --force-with-lease="$ref:$current" "$url" ":$ref" >/dev/null 2>&1 ||
  fail 'Contributor could not remove the proof ref.'
after=$(remote_commit) || fail 'Could not verify proof ref removal.'
test -z "$after" || fail 'The proof ref still exists after cleanup.'
`;

  try {
    await runContributor(setup + create);
    await runReader(setup + refuse);
  } catch (error) {
    await runContributor(setup + cleanup).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "Native Git push proof and cleanup failed.");
    });
    throw error;
  }
  await runContributor(setup + cleanup);
}
