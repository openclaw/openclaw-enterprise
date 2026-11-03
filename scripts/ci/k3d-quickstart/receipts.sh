#!/usr/bin/env bash
# Upload only the files constructed expressly as public receipts. The private
# run directory also has headers, logs, operator keys and transcript bodies.
set -euo pipefail
umask 077
out="$RUNNER_TEMP/oce-receipts"
mkdir -m 700 "$out"
jq -n '{sourceSha:env.GITHUB_SHA,run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,
  setup:env.SETUP,git:env.GIT,linear:env.LINEAR,recall:env.RECALL,images:env.IMAGES,
  gitCleanup:env.GIT_CLEANUP,teardown:env.TEARDOWN}' > "$out/status.json"
jq -r 'to_entries[] | "- \(.key): \(.value)"' "$out/status.json" >> "$GITHUB_STEP_SUMMARY"

receipt() {
  local outcome=$1 file=$2
  if [[ "$outcome" == success ]]; then
    jq -e '.' "$RUN_DIR/$file" > "$out/$file"
  fi
}
receipt "$SETUP" receipt-browser-onboard.json
receipt "$GIT" git-receipt.json
receipt "$LINEAR" linear-receipt.json
receipt "$RECALL" receipt-browser-final.json
receipt "$IMAGES" images.json
receipt "$GIT_CLEANUP" git-cleanup-receipt.json
if [[ "$SETUP/$GIT/$LINEAR/$RECALL/$GIT_CLEANUP/$TEARDOWN" == success/success/success/success/success/success ]]; then
  jq -en --slurpfile onboard "$out/receipt-browser-onboard.json" \
    --slurpfile git "$out/git-receipt.json" --slurpfile linear "$out/linear-receipt.json" \
    --slurpfile recall "$out/receipt-browser-final.json" \
    --slurpfile cleanup "$out/git-cleanup-receipt.json" '
    [$onboard[0], $git[0], $linear[0], $recall[0]] | map(.agentId) |
      (all(.[]; type=="string" and length > 0) and (unique|length)==1)
      and $onboard[0].workspaceVerified and $onboard[0].terminalAssistant and $recall[0].preferenceRecalled
      and ($onboard[0].sessionId | type=="string" and length>0)
      and $onboard[0].sessionId==$recall[0].sessionId
      and $git[0].repository=="oce-test/oce-app-test" and $git[0].writeRetired and $git[0].readVerified
      and $linear[0].tool=="codex_apps.linear.list_teams" and $linear[0].teamMatched
      and $recall[0].revisionId==$linear[0].revisionId
      and $cleanup[0].writeRetired and $cleanup[0].readRetired and $cleanup[0].branchRemoved' >/dev/null
fi
