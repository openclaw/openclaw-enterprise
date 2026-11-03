# Verify Git token renewal

Complete [the first push](openshell-git-push.md#4-verify-the-remote-ref) and keep the same shell, helpers, Agent revision, and write grant. Run this optional proof before restoring read-only access. Arrange an approved read-only PostgreSQL connection.

GitHub issues short-lived tokens. The worker prepares a replacement before expiry. Record the first push's Git authorization receipt using an approved read-only PostgreSQL connection. Set the psql variable `revision` to the active revision recorded in the Git setup guide. These queries return identifiers and expiry only.

```sql
-- Run after each push. Save the result before performing the next push.
SELECT u.exchange_id, u.material_version, a.provider_expires_at
FROM occ.prepared_repository_git_uses u
JOIN occ.repository_session_attempts s ON s.admission_id = u.admission_id
JOIN occ.prepared_github_attempts a ON a.id = u.attempt_id
WHERE s.revision_id = :'revision' AND u.operation = 'receive-pack';

-- Poll until this revision has a committed current version different from the first receipt.
SELECT a.material_version, a.provider_expires_at
FROM occ.prepared_github_attempts a
JOIN occ.prepared_github_families f ON f.source_id = a.source_id
WHERE f.source #>> '{session,revisionId}' = :'revision'
  AND a.state = 'committed' AND a.custody = 'current';
```

Wait for normal worker renewal. The reference implementation starts renewal roughly ten minutes before the usable cutoff for an hour-long token. Do not rotate a key, edit the database, restart the worker or redeploy to force the transition. Confirm the same revision is active, then make one fast-forward push whose parent is the first commit:

```bash
test "$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)" = "$revision"
push_turn second "$first_sha"
second_sha=$(verify_push second "$first_sha")
test "$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)" = "$revision"
printf 'Second commit: https://github.com/%s/commit/%s\n' "$repo" "$second_sha"
```

A proxy receipt records authorization. Verify that GitHub accepted the commit using the remote ref, parent and tree.

Require a second `receive-pack` receipt using the replacement material version, plus both verified GitHub commits. Two pushes with one token do not prove renewal. If Linear is enabled, [repeat the Linear read](../integrations/codex-plugins.md#verify-a-linear-read-through-openclaw) on this revision. If the second push has an uncertain outcome, inspect the remote ref before any retry.

Then [restore read-only access](openshell-read-only.md).
