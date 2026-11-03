#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
source "${RUN_DIR:?}/session.sh"
export RUN_DIR PLATFORM_NS TENANT_NAMESPACE RELEASE INSTALLATION_FILE VALUES_FILE
dir=scripts/ci/k3d-quickstart
guide=docs/guides/repository-credentials/openshell-git-push.md
repo=oce-test/oce-app-test
repo_id=1412618387
ref=application
APP_SLUG=oce-test-repo-access
WRITE_REGISTRY=qa-git-write
READ_REGISTRY=qa-git-read
node "$dir/git-fixture.mjs" issue read
trap 'node "$dir/git-fixture.mjs" revoke read || exit 1' EXIT
GH_TOKEN=$(cat "$RUN_DIR/git-read.token")
export GH_TOKEN
test "$(gh api "repos/$repo" --jq .id)" = "$repo_id"
gh api /meta > "$RUN_DIR/github-meta.json"

# The worker owns the signing and custody keys. The supervisor presents a Gateway JWT.
jq -n --arg ns "$namespace" --arg repo "$repo" --arg id "$repo_id" --arg ref "$ref" '{
  version:1,backendId:"repository-backend",providerInstanceId:"github-team",appId:"5258029",
  githubInstallationId:"170000975",maximumDurationSeconds:3600,repositories:[{repositoryRef:$ref,
  repositoryId:$id,repository:$repo,namespaces:[{namespaceId:$ns,profiles:["github-repository"],
  permissions:{contents:"write",metadata:"read"}}]}]}' > "$RUN_DIR/registry.json"
for mode in write read; do
  jq --arg mode "$mode" '.repositories[0].namespaces[0].permissions.contents=$mode' "$RUN_DIR/registry.json" > "$RUN_DIR/registry-$mode.json"
  kube -n "$PLATFORM_NS" create configmap "qa-git-$mode" --from-file="registry.json=$RUN_DIR/registry-$mode.json" \
    --dry-run=client -o json | jq '.immutable=true' | kube create -f -
done
kube -n "$PLATFORM_NS" get secret openshell-gateway-jwt-keys -o jsonpath='{.data.public\.pem}' | base64 -d > "$RUN_DIR/gateway-public.pem"
kube -n "$PLATFORM_NS" get secret openshell-gateway-jwt-keys -o jsonpath='{.data.kid}' | base64 -d > "$RUN_DIR/gateway-kid"
host="openclaw-enterprise-openshell-git.$PLATFORM_NS.svc"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=OCE CI Git CA' \
  -keyout "$RUN_DIR/git-ca.key" -out "$RUN_DIR/git-ca.crt" 2>"$RUN_DIR/git-cert.log"
openssl req -newkey rsa:2048 -nodes -subj "/CN=$host" -keyout "$RUN_DIR/git-tls.key" \
  -out "$RUN_DIR/git-tls.csr" 2>>"$RUN_DIR/git-cert.log"
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$host" > "$RUN_DIR/git-tls.ext"
openssl x509 -req -in "$RUN_DIR/git-tls.csr" -CA "$RUN_DIR/git-ca.crt" -CAkey "$RUN_DIR/git-ca.key" \
  -CAcreateserial -days 1 -extfile "$RUN_DIR/git-tls.ext" -out "$RUN_DIR/git-tls.crt"
openssl rand -out "$RUN_DIR/custody.key" 32
kube -n "$PLATFORM_NS" create secret generic qa-git-custody --from-file="custody.key=$RUN_DIR/custody.key"
kube -n "$PLATFORM_NS" create secret generic qa-git-app --from-file="private-key.pem=${GITHUB_APP_KEY_FILE:?}"
kube -n "$PLATFORM_NS" create secret tls qa-git-tls --cert="$RUN_DIR/git-tls.crt" --key="$RUN_DIR/git-tls.key"
kube -n "$PLATFORM_NS" create configmap qa-git-ca --from-file="ca.crt=$RUN_DIR/git-ca.crt"
kube -n "$PLATFORM_NS" create configmap qa-git-issuer --from-file="gateway-public.pem=$RUN_DIR/gateway-public.pem"
helmopts=(--kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS")
helm get values openshell-gateway "${helmopts[@]}" --all -o json > "$RUN_DIR/openshell-values.json"
node "$dir/git-configure.mjs"

request POST "$base/agents/$agent/stop" > "$RUN_DIR/git-stop.json"
stopped() { request GET "$base/agents/$agent" | jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null' >/dev/null; }
for ((i=0;i<90;i++)); do if stopped; then break; fi; sleep 2; done
stopped
kube -n "$TENANT_NAMESPACE" apply -f "$RUN_DIR/git-egress.json"
upgrade_installation
helm upgrade openshell-gateway "$OCC_DEVELOPMENT_STATE_DIRECTORY/openshell/chart/helm-chart-0.1.6.tgz" \
  "${helmopts[@]}" -f "$RUN_DIR/openshell-git-values.json" --wait
kube -n "$PLATFORM_NS" rollout status statefulset/openshell-gateway --timeout=3m
kube -n "$PLATFORM_NS" exec -i deployment/openclaw-enterprise-worker -c worker -- \
  node --input-type=module - "$namespace" "$ref" < docs/assets/openshell-quickstart/verify-github-installation.mjs \
  > "$RUN_DIR/github-worker-check.json"
jq -e '.success==true' "$RUN_DIR/github-worker-check.json" >/dev/null
request GET "$base/agents/$agent/repository-options" |
  jq -e --arg ref "$ref" 'any(.data[];.repositoryRef==$ref and (.allowedProfiles|index("github-repository"))!=null)' >/dev/null
guide_step() {
  node "$dir/guide-bash.mjs" "$guide" "$1" > "$RUN_DIR/git-guide-step.sh"
  source "$RUN_DIR/git-guide-step.sh"
}
GIT_SESSION_MODE=owner guide_step 'stop_git_test()'
# Track the write revision even when deployment fails after creating it.
touch "$RUN_DIR/git-deploy-started"
rm -f -- "$RUN_DIR/requested-revision"
deploy_and_wait
write_revision=$(cat "$RUN_DIR/requested-revision")
printf '%s\n' "$write_revision" > "$RUN_DIR/last-write-revision"
guide_step 'push_turn()'
# Store the intent before sending the only mutation so cleanup can handle a lost reply.
jq -n --arg b "$branch" --arg p "$base_sha" --arg bot "$BOT_NAME" --arg email "$BOT_EMAIL" '{branch:$b,parent:$p,bot:$bot,email:$email}' > "$RUN_DIR/git-intent.json"
push_turn first "$base_sha"
guide_step 'verify_push()'
git_audit "$write_revision" > "$RUN_DIR/git-write-uses.json"
jq -e 'any(.uses[]; .operation=="receive-pack")' "$RUN_DIR/git-write-uses.json" >/dev/null
tree=$(gh api "repos/$repo/git/commits/$base_sha" --jq .tree.sha)
stop_and_retire "$write_revision"
touch "$RUN_DIR/git-write-retired"
select_registry "$READ_REGISTRY" read
rm -f -- "$RUN_DIR/requested-revision"
read_recovery=null
if ! deploy_and_wait; then
  # A held Git route cannot reopen on the same revision. For the two documented
  # terminal causes only, confirm cleanup before making one fresh read revision.
  failed_read=$(cat "$RUN_DIR/requested-revision")
  [[ $failed_read =~ ^rev_[0-9a-f-]{36}$ && $failed_read != "$write_revision" ]]
  status_path="$base/agents/$agent/deployments/$failed_read"
  request GET "$status_path" | jq -e --arg r "$failed_read" --arg a "$agent" --arg n "$namespace" '
    .data | .deploymentId==$r and .agentId==$a and .namespaceId==$n and
    .status=="failed" and .error.code=="REPOSITORY_GIT_ROUTE_BLOCKED"' >/dev/null
  route_check() {
    kube -n "$PLATFORM_NS" exec -i deployment/openclaw-enterprise-worker -c worker -- \
      node --input-type=module - "$namespace" "$agent" "$failed_read" "$1" < "$dir/git-route-status.mjs"
  }
  reason=$(route_check recovery-reason)
  [[ $reason == bootstrap_failed || $reason == worker_replaced ]]
  read_recovery=$(jq -nc --arg revision "$failed_read" --arg reason "$reason" '{revision:$revision,reason:$reason}')
  printf '%s\n' "$read_recovery" > "$RUN_DIR/git-read-recovery.json"
  request GET "$base/agents/$agent" | jq -e --arg r "$failed_read" --arg ref "$ref" '
    .data | (.activeRevisionId==null or .activeRevisionId==$r) and
    .repositoryBindings==[{repositoryRef:$ref,profile:"github-repository"}]' >/dev/null
  request GET "$base/agents/$agent/repository-approvals" | jq -e '.data==[]' >/dev/null
  request POST "$base/agents/$agent/stop" > "$RUN_DIR/git-stop.json"
  for ((i=0;i<100;i++)); do
    if stopped && request GET "$status_path" | jq -e '.data.cleanup.status=="succeeded"' >/dev/null; then break; fi
    sleep 3
  done
  test "$i" -lt 100
  route_check retired
  # Verify both live components still mount the validated immutable read map.
  kube -n "$PLATFORM_NS" get cm "$READ_REGISTRY" -o json | jq -e --slurpfile wanted "$RUN_DIR/registry-read.json" '
    .immutable==true and (.data["registry.json"]|fromjson)==$wanted[0]' >/dev/null
  for component in api worker; do
    kube -n "$PLATFORM_NS" get pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=$component" -o json |
      jq -e --arg r "$READ_REGISTRY" '[.items[]|select(.metadata.deletionTimestamp==null)] |
        length==1 and all(.[]; any(.spec.volumes[]; .name=="repository-registry" and .configMap.name==$r))' >/dev/null
  done
  deploy_and_wait
  test "$(cat "$RUN_DIR/requested-revision")" != "$failed_read"
fi
read_revision=$(cat "$RUN_DIR/requested-revision")
printf 'Use native Git to run git ls-remote --exit-code https://github.com/%s.git refs/heads/%s and return the SHA. Do not write.\n' \
  "$repo" "$branch" > "$RUN_DIR/git-read-prompt"
turn "$RUN_DIR/git-read-prompt" > "$RUN_DIR/git-read-result"
jq -e --arg sha "$first_sha" '.outcome.status=="ok" and (.outcome.terminalReply.text|contains($sha))' "$RUN_DIR/git-read-result" >/dev/null
git_audit "$read_revision" > "$RUN_DIR/git-read-uses.json"
jq -e 'any(.uses[];.operation=="upload-pack" or .operation=="advertise-upload-pack") and all(.uses[];.operation!="receive-pack")' \
  "$RUN_DIR/git-read-uses.json" >/dev/null
# The final Git revision must retain the Linear configuration that passed its live read.
request GET "$base/agents/$agent" | jq -e --arg revision "$read_revision" \
  --slurpfile previous "$RUN_DIR/linear-agent-after.json" '
  .data | .activeRevisionId==$revision and .id==$previous[0].data.id and
  .plugins==$previous[0].data.plugins and .credentialSources==$previous[0].data.credentialSources' >/dev/null
request GET "$base/agents/$agent/deployments/$read_revision" |
  jq -e '.data.status=="succeeded" and (.data.warnings // [])==[]' > /dev/null
save_session
run_id() { jq -er '.runId|select(test("^[a-zA-Z0-9_-]{1,80}$"))' "$1"; }
push_run=$(run_id "$RUN_DIR/first-result")
read_run=$(run_id "$RUN_DIR/git-read-result")
jq -n --arg agent "$agent" --arg w "$write_revision" --arg r "$read_revision" --arg repo "$repo" \
  --arg b "$branch" --arg c "$first_sha" --arg p "$base_sha" --arg t "$tree" \
  --arg pushRun "$push_run" --arg readRun "$read_run" --argjson recovery "$read_recovery" \
  '{agentId:$agent,writeRevision:$w,readRevision:$r,repository:$repo,branch:$b,commit:$c,parent:$p,tree:$t,pushRun:$pushRun,readRun:$readRun,pushAuthorized:true,writeRetired:true,readVerified:true} + (if $recovery==null then {} else {readRecovery:$recovery} end)' \
  > "$RUN_DIR/git-receipt.json"
