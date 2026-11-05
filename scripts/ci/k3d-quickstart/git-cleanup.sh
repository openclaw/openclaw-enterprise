#!/usr/bin/env bash
# Retire the disposable Agent's credentials and remove only its verified empty-commit branch.
set -euo pipefail
set +x
umask 077
dir=scripts/ci/k3d-quickstart
fixture="$dir/git-fixture.mjs"
: "${RUN_DIR:?}"
case "${1:-all}" in
  custody)
    [[ -e "$RUN_DIR/git-deploy-started" ]] || exit 0
    source "$RUN_DIR/session.sh"
    request POST "$base/agents/$agent/stop" > "$RUN_DIR/git-stop.json"
    for ((i=0;i<100;i++)); do
      if request GET "$base/agents/$agent" |
        jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null' >/dev/null; then break; fi
      sleep 3
    done
    request GET "$base/agents/$agent" | jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null' >/dev/null
    # Include failed and superseded revisions, even if a create response was lost.
    request GET "$base/agents/$agent/revisions?limit=100" |
      jq -er --arg a "$agent" --arg n "$namespace" '
        select(.meta.nextCursor==null and (.data|length)>0 and all(.data[];.agentId==$a and .namespaceId==$n)) | .data[].id' > "$RUN_DIR/git-cleanup-revisions"
    while IFS= read -r revision; do
      for ((i=0;i<100;i++)); do
        git_audit "$revision" > "$RUN_DIR/git-final-custody.json"
        if jq -e 'all(.attempts[]; (.custody=="revoked" or .custody=="expired" or .custody=="not_issued") and (.sealed_present==false))' \
          "$RUN_DIR/git-final-custody.json" >/dev/null; then break; fi
        sleep 3
      done
      test "$i" -lt 100
    done < "$RUN_DIR/git-cleanup-revisions"
    ;;
  branch)
    [[ -f "$RUN_DIR/git-intent.json" ]] || exit 0
    repo=oce-test/oce-app-test
    branch=$(jq -er '.branch|select(test("^codex/oce-git-renew-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}$"))' "$RUN_DIR/git-intent.json")
    parent=$(jq -er '.parent|select(test("^[0-9a-f]{40}$"))' "$RUN_DIR/git-intent.json")
    node "$fixture" issue cleanup
    trap 'node "$fixture" revoke cleanup || exit 1' EXIT
    GH_TOKEN=$(cat "$RUN_DIR/git-cleanup.token")
    export GH_TOKEN
    # Query an exact ref and compare the expected old SHA during deletion. A
    # concurrent update must leave the branch alone, even after verification.
    remote_sha() {
      gh api "repos/$repo/git/matching-refs/heads/$branch" |
        jq -er --arg r "refs/heads/$branch" '[.[]|select(.ref==$r)|.object.sha]|if length==0 then "absent" else .[0] end'
    }
    sha=$(remote_sha)
    [[ "$sha" != absent ]] || exit 0
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]]
    if [[ -f "$RUN_DIR/git-receipt.json" ]]; then
      jq -e --arg s "$sha" '.commit==$s' "$RUN_DIR/git-receipt.json" >/dev/null
    fi
    tree=$(gh api "repos/$repo/git/commits/$parent" --jq .tree.sha)
    gh api "repos/$repo/commits/$sha" | jq -e --slurpfile intent "$RUN_DIR/git-intent.json" --arg t "$tree" '
      $intent[0] as $i | (.parents|length)==1 and .parents[0].sha==$i.parent and .commit.tree.sha==$t and
      .commit.message=="OpenShell Git renewal first" and (.files|length)==0 and
      .author.login==$i.bot and .committer.login==$i.bot and all(.commit.author,.commit.committer;.name==$i.bot and .email==$i.email)' >/dev/null
    cat > "$RUN_DIR/git-askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' x-access-token ;;
  Password*) printf '%s\n' "$GH_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
    chmod 700 "$RUN_DIR/git-askpass"
    git init -q "$RUN_DIR/git-delete"
    LC_ALL=C GIT_ASKPASS="$RUN_DIR/git-askpass" GIT_TERMINAL_PROMPT=0 \
      git -C "$RUN_DIR/git-delete" -c credential.helper= -c http.followRedirects=false push \
      --force-with-lease="refs/heads/$branch:$sha" "https://github.com/$repo.git" ":refs/heads/$branch"
    test "$(remote_sha)" = absent
    ;;
  all)
    rc=0
    # Each action runs with errexit in its own shell. A custody failure cannot skip branch cleanup.
    bash "$0" custody || rc=1
    bash "$0" branch || rc=1
    for mode in read cleanup; do
      if [[ -e "$RUN_DIR/git-$mode.token" ]]; then node "$fixture" revoke "$mode" || rc=1; fi
    done
    test "$rc" = 0
    printf '%s\n' '{"branchRemoved":true,"writeRetired":true,"readRetired":true}' > "$RUN_DIR/git-cleanup-receipt.json"
    ;;
  *) exit 2 ;;
esac
