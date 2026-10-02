# Feature Design: Bootstrap administrator service account: selected design

[Spec overview](index.md). Original record; decisions and status are preserved.

## Selected design

### Identity and permission scope

Add one random stable `spn_<uuid>` with `kind: service_principal` to the fresh bootstrap seed only. Omit `namespaceId` and `agentId`. Give it a separate binding to the **same Role ID** as the human administrator, omitting binding `namespaceId`, `resourceKind`, and `resourceId`. IAM records inherit the singleton Installation; no new ownership fields are needed.

Reuse the IAM-owned permission definition exactly:

| Resource kind | Allowed actions |
| --- | --- |
| `installation` | `administer`, `read` |
| `namespace` | `create`, `read`, `delete` |
| `configuration`, `service_account`, `secret` | `create`, `read`, `update`, `delete` |
| `secret` additionally | `operate` |
| `agent` | `create`, `read`, `update`, `deploy`, `operate` |
| `agent_revision` | `read` |

These grants cover current and future Namespaces in this Installation, subject to Restrictions and exact request authorization. They confer no provider/Kubernetes privileges, wildcard bypass, or Agent-delete permission. The credential name is `bootstrap-admin`; it is a label, never an identity lookup key.

Installation administrators manage credentials through existing APIs, including service administrators rotating their own keys. The identity survives removal of its original human administrator. Revocation/expiry rejects later authentication; removal of identity/binding/Role or a matching Restriction denies later authorization. Already authorized work may finish. Human-account creation and HTTP bootstrap remain human-only. There is no new principal-management API.

### Bootstrap sequence and failure behavior

1. Run `scripts/bootstrap-installation.mjs` after migration with `NODE_ENV=development` or `production`, application-role PostgreSQL, and Better Auth settings. Load persisted Installation state. If already bootstrapped, retain existing administrator verification and return without issuing keys or touching output, including installations predating this feature. Missing files, expired/revoked keys, or removed identities/grants never trigger regeneration or repair.
2. For fresh native-IAM bootstrap, validate private absolute output paths, create the human as today, and extend its seed with the service identity/binding. Call existing `auth.createServiceKey` for that identity with Installation scope, `bootstrap-admin`, and a 30-day lifetime.
3. Write and fsync the private key file before the existing Installation/IAM/audit commit; production also retains its password-file write. Better Auth persists independently: the key may authenticate before OCC commits, but cannot authorize normal OCC operations without its committed identity/binding. Do not start serving until confirmed bootstrap success.
4. Both modes use the same direct controller transaction and one attempt scope. API and worker startup require the committed Installation and IAM state; development no longer constructs Fastify or signs into itself to bootstrap. A losing initializer exits unsuccessfully. A later complete initialization retry reloads the winner's persisted Installation/IAM instead of serving generated loser IDs. The public `POST /installation/bootstrap` route remains human-session-only and does not issue bootstrap credentials.
5. Existing singleton database constraints select at most one committed Installation/IAM seed. Concurrent attempts can temporarily create independent auth records and files. After a known losing commit, best-effort cleanup removes only that attempt's recorded user/key IDs and files it exclusively created; never the winner's or preexisting resources.

Ordinary failures before OCC commit use the same scoped cleanup and return failure. Attempt each cleanup independently even when an earlier cleanup fails. Retain handles/identity checks sufficient to avoid deleting replaced files. Report cleanup failures with safe IDs and paths so an operator can repair them; do not retry issuance over existing output or adopt users by email/name.

An **unknown commit outcome** preserves all accounts, keys, and output and stops for operator verification. Both modes preserve `PostgresCommitOutcomeUnknownError` directly; there is no internal HTTP translation of the commit outcome. Existence of any Installation is not proof that this attempt committed. Compare the recorded attempt Installation/principal IDs with authoritative Installation/IAM/key state, and confirm the original transaction has finished before deciding cleanup. Database unavailability remains unresolved; no destructive compensation or automatic retry runs.

Abrupt termination can leave auth accounts, key hashes, or partial output without a committed IAM seed. Operator repair is an accepted tradeoff: establish the transaction outcome, identify this attempt's orphan IDs, remove only proven orphans, quarantine stale output privately, then rerun. When the matching seed committed, retain its credentials and use normal recovery if output was lost. File existence alone never proves bootstrap success.

### Private delivery and recovery

Use path-only `OCC_BOOTSTRAP_SERVICE_KEY_FILE`, required on fresh direct initialization. Production requires a distinct sibling of `OCC_BOOTSTRAP_PASSWORD_FILE`. The protected file helper uses the exclusive-create pattern: reject unsafe parents/symlinks and existing destinations, open with `O_EXCL`, enforce `0600`, write complete JSON, and fsync file and parent directory before OCC commit. The protected directory is writable only by the runtime identity and trusted storage administrators. Never overwrite output.

Use the existing response-compatible shape so [service-key client examples](../../../docs/guides/deploy/service-keys.md#use-a-service-key) can consume `data.key`:

```json
{"data":{"id":"<key-id>","servicePrincipalId":"<spn_uuid>","name":"bootstrap-admin","expiresAt":"<UTC-expiry>","key":"<generated-occ-key>"},"meta":{"installationId":"<installation-id>"}}
```

| Entry point | Delivery and user experience |
| --- | --- |
| Production/Helm | Add `bootstrap.serviceKey.fileName`, default `initial-admin-service-key.json`, under the existing password mount; validate a distinct simple basename and pass the full path. Only bootstrap mounts the PVC. Retrieve via approved PVC/storage access after Job success; a completed container is not an exec endpoint. |
| Development Compose | The one-shot `bootstrap` service follows `migrate` and alone mounts `occ_bootstrap_data` at `/var/lib/openclaw/bootstrap`. The development image prepares UID/GID 1000 and `0700`. After confirmed exit `0`, use `docker compose cp bootstrap:/var/lib/openclaw/bootstrap/initial-admin-service-key.json` to copy into an operator-owned `0700` directory under `umask 077`, then enforce local `0600`. API/worker do not mount bootstrap output. |
| Direct development | Run the shared initializer before API/worker startup with an explicit private absolute key-file path, `OPENCLAW_DEV_EMAIL`, `OPENCLAW_DEV_PASSWORD`, and `OPENCLAW_DEV_INSTALLATION_NAME` or their existing defaults. It writes no password file. |
| Unattended installer | Wait for confirmed script/Job/startup success, import the file into existing credential storage, retain key/principal IDs, then remove delivery copies according to policy. Import failures retry the same file without issuing another key. |

“One-time disclosure” means one generated output and no server-side plaintext retrieval; the file remains readable until removed. Bootstrap emits safe outcome/Installation/principal/key IDs, expiry and path only. Never place secrets in stdout/stderr, process arguments, HTTP bootstrap responses, audit, manifests, or image layers. Redact `x-api-key` in request logs and exclude output from diagnostics. Operators own protection of copied files, backups, snapshots, and crash dumps. First-use proof is a key-authenticated Installation read and Namespace create/read.

Lost or exposed token with retained IDs: sign in as the human, revoke the old ID with `DELETE /api/auth/service-keys/:keyId`, then issue a replacement for the recorded principal using `POST /api/auth/service-keys`, omitting Namespace, and save its one-time response privately. Lost file **and IDs** require operator database inspection of existing IAM and key metadata; there is no discovery endpoint. Missing IAM authority is not restored by key issuance. Planned rotation is issue → switch clients → check a real request → revoke old ID. Compromise may require revoking additional keys issued by that administrator; revocation does not cascade. Loss of all admin access requires existing operator recovery, never rerunning bootstrap as a reset.

