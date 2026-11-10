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

A `kubectl port-forward` to the API cannot verify sign-in. The API Service speaks plain
HTTP behind your ingress, the session cookie is `Secure` with the `__Host-` prefix, the
API compares `Origin` exactly, and an IdP returns the browser to the registered
redirect URI on the canonical host, never to a forwarded port. Use a port-forward only
for reads that need no session, such as `GET /api/auth/providers`.

## Run the command

Run it from the installed controller image in a temporary Job. The Job controller
owns its Pod; this matters on EKS, where NetworkPolicy enforcement can be unreliable
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
          args: ["scripts/auth-maintain.mjs", "status"]
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

If cleanup fails, complete it before another operation or resuming writers. If
the result was uncertain, run `status` in a new Job before deciding whether to
retry a change. Confirm the intended database state before resuming writers.

For `reset-recovery-password`, put the new password in a Secret, mount it
read-only in the Pod, and pass the mounted path with `--password-file`. Delete
the Secret after verifying sign-in. The password never appears in arguments,
output, or audit.

After a change, run `status`, scale the worker and API back to one replica,
verify sign-in through [restricted access](#close-ingress-and-use-restricted-access),
and reopen ingress.

## Deactivate external sign-in

Deactivation returns the Installation to the legacy password profile and
requires the API to be stopped. In one transaction it removes the recovery
designation, enrolment, session bindings, pending external sign-in attempts, and
every session. Linked Google and OIDC identities stay in the database but
are unused, so `status` still counts them under `externalMethods`.

The legacy profile ignores account disablement, so `deactivate` refuses while any
account is disabled and lists their IDs. `--purge-disabled` removes those
accounts' passwords instead, so they still cannot sign in. Deactivation also
removes the database fence on unbound sessions, so the older image and plain
password sign-in work again.

Then, in the protected values, set `auth.google.enabled` and `auth.oidc.enabled` to `false`, remove `auth.oidc.enrollment`, clear both `auth.oidc.caSecretName` and
`auth.oidc.caSecretKey`, remove `auth.recoveryUserId`, and reset
`auth.passwordSignIn` to `all`. Run `helm upgrade`, which also restores the
replicas. Without Helm, remove every `OCC_AUTH_GOOGLE_*` and `OCC_AUTH_OIDC_*` variable,
`OCC_AUTH_RECOVERY_USER_ID`, and `OCC_AUTH_PASSWORD_SIGN_IN` from the API environment before scaling it up. If any
provider is still configured, startup activates the profile again.

Activating again later, at startup or with `activate`, enrolls every account
that has its Principal and exactly one password, as an enabled account; earlier
disablement is not restored. Accounts that `--purge-disabled` left without a
password are skipped: startup logs them, `status` lists them as unenrolled, and
they cannot sign in. The startup warning names at most 100 accounts;
`skippedUserCount` gives the total and `skippedUserIdsTruncated` is `true` when
names were left out, so use `status` for the complete list. Disable again, through the accounts API, any account that
must stay disabled.
