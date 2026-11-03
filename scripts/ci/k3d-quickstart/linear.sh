#!/usr/bin/env bash
# Run the published Add Plugin CLI path once on the Agent created by setup.
set -euo pipefail
set +x
umask 077

source "${RUN_DIR:?Missing quickstart run directory}/session.sh"
guide=docs/guides/integrations/codex-plugins.md
extractor=scripts/ci/k3d-quickstart/guide-bash.mjs
team=${OCC_TEST_LINEAR_TEAM_ID:?Set the known team UUID for the connected Linear account}
[[ $team =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]
# Extract and check all steps before touching the Agent or sending a turn.
for stage in catalog deploy prompt send transcript; do
  case "$stage" in
    catalog) marker='while true; do' ;;
    deploy) marker='> "$RUN_DIR/plugin-agent"' ;;
    prompt) marker='linear_marker="linear-' ;;
    send) marker='turn "$RUN_DIR/linear-prompt"' ;;
    transcript) marker='read -r gateway_ns gateway_pod' ;;
  esac
  node "$extractor" "$guide" "$marker" > "$RUN_DIR/linear-$stage.sh"
  bash -n "$RUN_DIR/linear-$stage.sh"
done

request GET "$base/agents/$agent" > "$RUN_DIR/linear-agent-before.json"
for stage in catalog deploy prompt send transcript; do
  echo "Running Add Plugin step: $stage"
  # The published examples display connected-account data. Keep all raw output
  # private, including stderr. Source in this shell so the plugin ID persists.
  source "$RUN_DIR/linear-$stage.sh" > "$RUN_DIR/linear-$stage.log" 2>&1
done
revision=$(cat "$RUN_DIR/requested-revision")
run_id=$(cat "$RUN_DIR/linear-run-id")
request GET "$base/agents/$agent" |
  jq -e --arg a "$agent" --arg r "$revision" --arg p "$plugin" \
    --slurpfile before "$RUN_DIR/linear-agent-before.json" '
      .data | .id==$a and .activeRevisionId==$r and .plugins[$p].enabled==true and
      .repositoryBindings==$before[0].data.repositoryBindings and
      .credentialSources==$before[0].data.credentialSources' > /dev/null
# The native reader pairs a direct or dispatched call to its successful result
# on this marked turn. The expected UUID is never part of the Agent prompt.
jq -e --arg run "$run_id" --arg team "$team" '
  .runId==$run and .toolName=="codex_apps.linear.list_teams" and
  any(.results[].content | .. | strings; ascii_downcase | contains($team|ascii_downcase)) and
  (.reply | ascii_downcase | contains($team|ascii_downcase))' "$RUN_DIR/linear-transcript.json" > /dev/null
jq -n --arg a "$agent" --arg r "$revision" --arg run "$run_id" \
  '{agentId:$a,revisionId:$r,runId:$run,tool:"codex_apps.linear.list_teams",teamMatched:true}' \
  > "$RUN_DIR/linear-receipt.json"
