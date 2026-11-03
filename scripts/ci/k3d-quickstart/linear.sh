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

stage_file="$RUN_DIR/linear-stage"
evidence=scripts/ci/k3d-quickstart/linear-evidence.mjs
printf '%s\n' before > "$stage_file"
request GET "$base/agents/$agent" > "$RUN_DIR/linear-agent-before.json"
jq -e --arg agent "$agent" --arg ref "$ref" --slurpfile git "$RUN_DIR/git-receipt.json" '
  .data | .id==$agent and .activeRevisionId==$git[0].readRevision and
  .repositoryBindings==[{repositoryRef:$ref,profile:"github-repository"}]' \
  "$RUN_DIR/linear-agent-before.json" > /dev/null
for stage in catalog deploy prompt send; do
  printf '%s\n' "$stage" > "$stage_file"
  if [[ $stage == send ]]; then
    # Native Codex may expose the installed plugin through Code Mode discovery.
    # Give it the team's key; the expected ID stays out of the entire prompt.
    printf '%s\n' 'Through your managed Linear plugin, find the team with key OCE and include its ID, key and name from the real tool result. Use the native tool search and Code Mode if needed to discover and invoke the Linear list_teams action. Do not use shell, network commands, or guessed data.' >> "$RUN_DIR/linear-prompt"
  fi
  echo "Running Add Plugin step: $stage"
  # The published examples display connected-account data. Keep all raw output
  # private, including stderr. Source in this shell so the plugin ID persists.
  source "$RUN_DIR/linear-$stage.sh" > "$RUN_DIR/linear-$stage.log" 2>&1
  if [[ $stage == deploy ]]; then
    revision=$(cat "$RUN_DIR/requested-revision")
    request GET "$base/agents/$agent/deployments/$revision" > "$RUN_DIR/linear-deployment.json"
    jq -e '.data.status=="succeeded" and (.data.warnings // [])==[]' "$RUN_DIR/linear-deployment.json" > /dev/null
  fi
done
printf '%s\n' agent > "$stage_file"
revision=$(cat "$RUN_DIR/requested-revision")
run_id=$(cat "$RUN_DIR/linear-run-id")
request GET "$base/agents/$agent" > "$RUN_DIR/linear-agent-after.json"
jq -e --arg a "$agent" --arg r "$revision" --arg p "$plugin" \
    --slurpfile before "$RUN_DIR/linear-agent-before.json" '
      .data | .id==$a and .activeRevisionId==$r and .plugins[$p].enabled==true and
      .repositoryBindings==$before[0].data.repositoryBindings and
      .credentialSources==$before[0].data.credentialSources' "$RUN_DIR/linear-agent-after.json" > /dev/null
# Use the displayed call and its matched result if the fresh session retained
# both. The guide's native reader handles hidden rows and dispatch_action.
if ! node "$evidence" history "$RUN_DIR"; then
  printf '%s\n' transcript > "$stage_file"
  # agent.wait can finish before the Gateway finishes mirroring the turn.
  # Only reread the submitted run. Never repeat chat.send.
  for attempt in 1 2 3 4 5; do
    if bash -euo pipefail -c 'source "$RUN_DIR/session.sh"; source "$RUN_DIR/linear-transcript.sh"' > "$RUN_DIR/linear-transcript.log" 2>&1; then break; fi
    if [[ $attempt == 5 ]]; then exit 1; fi
    sleep 3
  done
  printf '%s\n' evidence > "$stage_file"
  jq -e --arg run "$run_id" --arg team "$team" '
    .runId==$run and .toolName=="codex_apps.linear.list_teams" and
    any(.results[].content | .. | strings; ascii_downcase | contains($team|ascii_downcase)) and
    (.reply | ascii_downcase | contains($team|ascii_downcase))' "$RUN_DIR/linear-transcript.json" > /dev/null
fi
jq -n --arg a "$agent" --arg r "$revision" --arg run "$run_id" \
  '{agentId:$a,revisionId:$r,runId:$run,tool:"codex_apps.linear.list_teams",teamMatched:true}' \
  > "$RUN_DIR/linear-receipt.json"
