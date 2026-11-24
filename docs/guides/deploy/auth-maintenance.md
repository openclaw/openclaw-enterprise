# Maintain external sign-in with the API stopped

Use `pnpm auth:maintain` when external sign-in (Google or OIDC) needs a change the online API
cannot make: the recovery administrator is locked out, an account was never
enrolled, sessions must be ended at once, or the Installation must return to
password-only sign-in. `purge-sessions` also works on a password-only
Installation. The command ships in the controller image and connects with the
migration credential, never the application credential. To run it from a release
checkout instead, first run `pnpm install --frozen-lockfile` in the checkout root.

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
sessions leaves them valid. They never grant a session. The command writes one
JSON line to stdout for exit codes `0`, `2`, and `3`. Diagnostics go to stderr.

| Exit | Meaning                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Done.                                                                                                                                    |
| `2`  | Another client is connected to the database. Nothing changed; the output lists the backends.                                             |
| `3`  | A precondition refused the operation (`reason` in the output, for example `DISABLED_ACCOUNTS` or `ACTIVATION_REFUSED`). Nothing changed. |
| `1`  | Configuration, credential, or database failure.                                                                                          |
| `64` | Invalid arguments, rejected before configuration or database access.                                                                     |

## Stop every writer

For `deactivate`, read the [deactivation prerequisites](#deactivate-external-sign-in)
before stopping the API. Close ingress and pause anything that could restart
the Deployments.

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

## Close ingress and use restricted access

Sign-in procedures say to close ingress and to verify through restricted access. The
chart does not own the public route to the Console; your Gateway, Ingress controller
or load balancer does.

- **Close ingress:** stop serving ordinary users at that layer, for example by
  answering the Console host with a maintenance page or `503`, or by removing its
  route. Leave the API Service alone.
- **Restricted access:** a path only operators can use that still reaches the
  canonical HTTPS origin (`OCC_AUTH_BASE_URL`): the same host name on port 443, with
  the same certificate. For example, keep the route but admit only operator source
  addresses, or serve the same host name on a private listener and point operator
  machines at it with a DNS override (a hosts entry, or `curl --resolve`).

Do not use `kubectl port-forward` directly to the production API Pod or Service.
The API binds the Pod IP, while port-forward connects through Pod loopback, so even
reads that need no session, such as `GET /api/auth/providers`, cannot connect.
Use the restricted canonical HTTPS origin above for these reads and sign-in checks.
Session cookies require HTTPS. Starting external sign-in requires an `Origin` that
exactly matches `OCC_AUTH_BASE_URL`; the identity provider returns the browser to
its registered redirect URI on the canonical host.

## Run the command

Run the command from the installed controller image in a temporary Job. Use the
Job example for the release of that image. The Job controller owns its Pod; this matters on EKS, where NetworkPolicy enforcement can be unreliable
for standalone Pods. The Pod labels below select the installed initialization
NetworkPolicy for the Helm release (`RELEASE`), allowing DNS and database egress.
Keep that policy and the `openclaw-enterprise-initialization` service account in place.

The operator needs permission to create, read, watch, and delete Jobs, read Pods
and their logs, and scale the API and worker Deployments. The maintenance Pod has
no mounted service-account token. Use the installed database Secret name and
migration key; the example uses the chart defaults `occ-database` and
`migration-url`. Match `database.caKey`, `database.caMountPath`, and any
`controlPlane.nodeSelector` to your installed values. Without a database CA,
remove `volumes` and `volumeMounts`.

For `reset-recovery-password`, mount the new password from a Secret read-only
in the maintenance Pod. Pass the mounted path with `--password-file`. Keep the
password out of arguments, output and audit. Keep the Secret until you verify
sign-in with the new password.

Create one Job for the selected operation. `create` refuses an existing Job;
finish inspecting and removing the previous maintenance Job before another run.

```bash
export RELEASE=oce DATABASE_CA_SECRET='<database.caSecretName>'
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system create -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: occ-auth-maintain
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openclaw-enterprise
        app.kubernetes.io/instance: "$RELEASE"
        app.kubernetes.io/component: initialization
    spec:
      serviceAccountName: openclaw-enterprise-initialization
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      volumes:
        - name: database-ca
          secret:
            secretName: "$DATABASE_CA_SECRET"
            items:
              - key: ca.pem
                path: ca.pem
      containers:
        - name: occ-auth-maintain
          image: "$CONTROLLER_IMAGE"
          args: ["scripts/auth-maintain.ts", "status"]
          env:
            - name: NODE_ENV
              value: production
            - name: OCC_MIGRATION_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: occ-database
                  key: migration-url
          volumeMounts:
            - name: database-ca
              mountPath: /etc/openclaw/database-ca
              readOnly: true
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
EOF
```

For a [selected-image migration](separate-database-upgrade.md#run-a-selected-image-migration),
assign `MIGRATION_ARGS` there first. Replace the `args:` line inside this unquoted
heredoc with the literal line `args: ${MIGRATION_ARGS:?Select migration arguments first}`.
Use that procedure's migration verification and recovery steps instead of the sign-in steps below.

Replace `"status"` with the operation's arguments, for example
`"deactivate", "--writers-stopped"`. The Pod's own database connection is excluded
from the writer check. The Job does not retry a failed Pod.

Wait for completion, inspect the JSON output, then delete the Job and wait for
its Pods to stop. This block attempts cleanup even after a failure and returns
nonzero if completion, diagnostics, or cleanup fails. A timeout does not establish
whether a change committed.

```bash
(
  result=0
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system wait --for=condition=Complete \
    job/occ-auth-maintain --timeout=5m || result=$?
  if [ "$result" -ne 0 ]; then
    kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
      --namespace openclaw-system get job/occ-auth-maintain -o yaml || result=$?
  fi
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system logs job/occ-auth-maintain -c occ-auth-maintain || result=$?
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system delete job/occ-auth-maintain \
    --cascade=foreground --wait=true --timeout=5m || result=$?
  exit "$result"
)
```

Keep ingress closed and writers stopped until cleanup is complete. After a
change or an uncertain result, run `status` in a fresh Job and clean it up.
Confirm the intended Installation and database state.

- **Password reset.** Check `profile: guarded` and `designation.userId`.
  Neither the designation nor the session count confirms the reset. If the
  outcome is uncertain, ask an [authorized database reader](../topics/audit-log.md#access-and-limitations)
  to check `occ.audit_events` for a successful
  `authentication.recovery.password-reset`. Match the Installation,
  `details.userId`, `maintenance:<database role>` and attempt time. This event
  commits with the reset. An older match or a missing event cannot settle this
  attempt. If you cannot establish the outcome, leave ingress
  closed and writers stopped. Do not repeat the reset.
- **Deactivation.** Continue with [the configuration changes below](#deactivate-external-sign-in)
  before restarting. A configured provider can reactivate the guarded profile.

For a confirmed change other than deactivation, restore the API and
worker replica counts. Verify a fresh sign-in through
[restricted access](#close-ingress-and-use-restricted-access). After a reset,
use the new password and check the recovery account ID before deleting the
password Secret. Reopen ingress only after verification succeeds.

## Deactivate external sign-in

Before stopping the API, use restricted access to confirm that the recovery administrator can sign in
with a password. Review disabled accounts. If you use `host-only-exchange`,
password-only sign-in requires switching to
[shared cookies](../../reference/agent-native-admin.md#shared-session-boundary).
Every host that receives the cookie must be a trusted OCE ingress endpoint.
Do not deactivate if you cannot meet that requirement.

Deactivation returns the Installation to the legacy password profile and
requires the API to be stopped. In one transaction it removes the recovery
designation, enrolment, session bindings, pending external sign-in attempts, and
every session. Linked Google and OIDC identities stay in the database but
are unused, so `status` still counts them under `externalMethods`.

The legacy profile ignores account disablement, so `deactivate` refuses while any
account is disabled and lists their IDs. Use `--purge-disabled` only if you are
authorized to erase those accounts’ passwords. They cannot then sign in. Deactivation also removes the
database fence on unbound sessions.

Confirm that `status` reports `profile: legacy`. Keep ingress closed and
writers stopped while you prepare the new configuration.

- **Helm.** In the protected values, set `auth.google.enabled` and
  `auth.oidc.enabled` to `false` and `auth.google.allowedDomains` to `[]`.
  Remove `auth.oidc.enrollment`. Clear `auth.oidc.caSecretName`,
  `auth.oidc.caSecretKey` and `auth.recoveryUserId`. Set `auth.passwordSignIn`
  to `all` and `agentNativeAdmin.sessionMode` to `shared-cookie`.
  Run `helm upgrade` with the updated values to restore the configured replicas.
- **Without Helm.** Remove every `OCC_AUTH_GOOGLE_*` and `OCC_AUTH_OIDC_*`
  variable, `OCC_AUTH_RECOVERY_USER_ID`, `OCC_AUTH_PASSWORD_SIGN_IN` and
  `OCC_AGENT_NATIVE_ADMIN_SESSION_MODE` from the API environment. Remove
  OIDC-only CA trust while preserving Gateway trust. Then restore the writers.

Through [restricted access](#close-ingress-and-use-restricted-access), check
`GET /api/auth/providers`. Expect `google: false`, `oidc: false`,
`password: true` and `sessionBinding: false` in `data`. Confirm a fresh
password sign-in to the intended administrator account before reopening ingress.

Activating again later, at startup or with `activate`, enrolls every account
that has its Principal and exactly one password, as an enabled account; earlier
disablement is not restored. Accounts that `--purge-disabled` left without a
password are skipped: startup logs them, `status` lists them as unenrolled, and
they cannot sign in. The startup warning names at most 100 accounts;
`skippedUserCount` gives the total and `skippedUserIdsTruncated` is `true` when
names were left out, so use `status` for the complete list. Disable again, through the accounts API, any account that
must stay disabled.
