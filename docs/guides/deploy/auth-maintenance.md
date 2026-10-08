# Maintain external sign-in with the API stopped

Use `pnpm auth:maintain` when external sign-in (GitHub, Google, or OIDC) needs a change the online API
cannot make: the recovery administrator is locked out, an account was never
enrolled, sessions must be ended at once, or the Installation must return to
password-only sign-in. `purge-sessions` also works on a password-only
Installation. The command ships in the controller image and connects with the
migration credential, never the application credential.

The [authentication reference](../../reference/authentication/external-sign-in.md#session-and-recovery-controls)
owns the profile's rules; this page is the operator procedure.

## Choose the operation

| Command                                                            | Use it when                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                                           | Read the profile (`legacy` or `guarded`), recovery designation, enrolled, disabled, and unenrolled accounts, session counts, linked external identities per provider instance (`externalMethods`, keyed by `providerId`), and other connected clients. Changes nothing. |
| `activate --recovery-user <userId> --writers-stopped`              | Activate external sign-in before the new API starts. Same checks as startup activation: the recovery account needs a password, its Principal, and Installation `administer`.                                                                                            |
| `enrol <userId> --writers-stopped`                                 | An account exists but is not enrolled (for example, an older controller created it after activation). Requires the account's Principal and exactly one password; the account's sessions are ended.                                                                      |
| `reset-recovery-password --password-file <path> --writers-stopped` | The recovery administrator lost the password. Reads the new password (12 to 128 characters; one trailing newline is ignored) and ends the recovery account's sessions.                                                                                                  |
| `purge-sessions [--user <userId>] --writers-stopped`               | End every session, or one account's sessions. Service keys are not affected.                                                                                                                                                                                            |
| `deactivate [--purge-disabled] --writers-stopped`                  | Return to password-only sign-in. See [Deactivate](#deactivate-external-sign-in).                                                                                                                                                                                        |

Every change writes an audit event attributed to `maintenance:<database role>`.
`activate` also records startup's own activation event, attributed to the
recovery Principal; re-running it changes nothing and writes no audit. Like
startup, it keeps an existing designation, including one moved online through
`POST /api/auth/recovery`: a different `--recovery-user` prints
`"seedIgnored":true` and re-checks the current holder, which `status` shows.
`enrol` applies the same rule as the online `POST /api/auth/accounts/:userId/enrol`.
The tool never reads the controller auth secret. An ended session's console
`sessionKey` and any pending external sign-in receipt stop working with it, and the
browser signs in again. Resetting a password revokes the account's
[known-device cookies](../../reference/authentication.md#known-devices), and a
disabled account's cookies exempt nothing while it stays disabled; purging
sessions leaves them valid. They never grant a session. The command prints one JSON line and exits with:

| Exit | Meaning                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Done.                                                                                                                                    |
| `2`  | Another client is connected to the database. Nothing changed; the output lists the backends.                                             |
| `3`  | A precondition refused the operation (`reason` in the output, for example `DISABLED_ACCOUNTS` or `ACTIVATION_REFUSED`). Nothing changed. |
| `1`  | Configuration, credential, or database failure.                                                                                          |
| `64` | Invalid arguments, rejected before configuration or database access.                                                                     |

## Stop every writer

`--writers-stopped` is checked, not trusted. Inside its transaction the command
takes the activation lock and refuses while any other client is connected to
the database, then checks again before committing; `activate` runs the same
checks inside the startup activation transaction. Stop the API and the worker,
and close any `psql` or monitoring session on this database:

```bash
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system scale deployment/openclaw-enterprise-api \
  deployment/openclaw-enterprise-worker --replicas=0
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system wait --for=delete pod \
  -l 'app.kubernetes.io/component in (api,worker)' --timeout=5m
```

Close ingress first so users see a maintenance response rather than errors, and
pause anything that would scale the Deployments back up.

## Run the command

Run it from the installed controller image as a one-off Pod. The labels and
service account reuse the initialization Job's database egress policy, which
selects on the Helm release name (`RELEASE`); the Secret is the chart's
`occ-database` with its `migration-url` key. The example mounts the
`database.caSecretName` CA (key `ca.pem`) at the chart's `database.caMountPath`;
without a database CA, drop `volumes` and `volumeMounts`.

```bash
export RELEASE=oce DATABASE_CA_SECRET='<database.caSecretName>'
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system run occ-auth-maintain --rm -i --restart=Never \
  --image "$CONTROLLER_IMAGE" \
  --labels "app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=initialization" \
  --overrides '{"spec":{"serviceAccountName":"openclaw-enterprise-initialization","automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"volumes":[{"name":"database-ca","secret":{"secretName":"'"$DATABASE_CA_SECRET"'","items":[{"key":"ca.pem","path":"ca.pem"}]}}],"containers":[{"name":"occ-auth-maintain","image":"'"$CONTROLLER_IMAGE"'","args":["scripts/auth-maintain.mjs","status"],"env":[{"name":"NODE_ENV","value":"production"},{"name":"OCC_MIGRATION_DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"occ-database","key":"migration-url"}}}],"volumeMounts":[{"name":"database-ca","mountPath":"/etc/openclaw/database-ca","readOnly":true}],"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}}]}}'
```

Replace `"status"` with the operation's arguments, for example
`"deactivate","--writers-stopped"`. The Pod's own connection is excluded from
the check; `kubectl run --rm` removes it afterwards.

For `reset-recovery-password`, put the new password in a Secret, mount it
read-only in the Pod, and pass the mounted path with `--password-file`. Delete
the Secret after verifying sign-in. The password never appears in arguments,
output, or audit.

After a change, run `status`, scale the worker and API back to one replica,
verify sign-in through restricted access, and reopen ingress.

## Deactivate external sign-in

Deactivation returns the Installation to the legacy password profile and
requires the API to be stopped. In one transaction it removes the recovery
designation, enrolment, session bindings, pending external sign-in attempts, and
every session. Linked GitHub, Google, and OIDC identities stay in the database but
are unused, so `status` still counts them under `externalMethods`.

The legacy profile ignores account disablement, so `deactivate` refuses while any
account is disabled and lists their IDs. `--purge-disabled` removes those
accounts' passwords instead, so they still cannot sign in. Deactivation also
removes the database fence on unbound sessions, so the older image and plain
password sign-in work again.

Then, in the protected values, set `auth.github.enabled`, `auth.google.enabled`,
and `auth.oidc.enabled` all to `false`, remove `auth.recoveryUserId`, and reset
`auth.passwordSignIn` to `all`. Run `helm upgrade`, which also restores the
replicas. Without Helm, remove every `OCC_AUTH_GITHUB_*`, `OCC_AUTH_GOOGLE_*`,
and `OCC_AUTH_OIDC_*` variable (including `OCC_AUTH_GITHUB_RECOVERY_USER_ID`) and
`OCC_AUTH_PASSWORD_SIGN_IN` from the API environment before scaling it up. If any
provider is still configured, startup activates the profile again.

Activating again later, at startup or with `activate`, enrolls every account
that has its Principal and exactly one password, as an enabled account; earlier
disablement is not restored. Accounts that `--purge-disabled` left without a
password are skipped: startup logs them, `status` lists them as unenrolled, and
they cannot sign in. The startup warning names at most 100 accounts;
`skippedUserCount` gives the total and `skippedUserIdsTruncated` is `true` when
names were left out, so use `status` for the complete list. Disable again, through the accounts API, any account that
must stay disabled.
