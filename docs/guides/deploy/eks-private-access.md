# Connect to a private EKS API and recover from timeouts

Use an approved connection from the cluster VPC or a connected network for a
private-only Amazon EKS Kubernetes API. AWS distinguishes this Kubernetes API
endpoint from the EKS management API: access to the latter alone does not make
`kubectl` or Helm reach the cluster. See [EKS cluster endpoint access](https://docs.aws.amazon.com/eks/latest/userguide/cluster-endpoint.html).

Run operations on an approved host with stable private connectivity when
possible. The following Session Manager tunnel is an option when an operator's
workstation cannot reach the endpoint directly. It requires AWS CLI and the
Session Manager plugin on the workstation, an authorized SSM-managed instance
that can resolve and reach the private EKS endpoint on port 443, and permission
to start this session. Its SSM Agent needs the
[remote-host port-forwarding prerequisites](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-remote-port-forwarding).
The operator's AWS identity must also be authorized for the EKS cluster and the
intended Kubernetes operations. A working tunnel does not grant Kubernetes
permissions. Do not expose the API publicly to work around connectivity.

## Open a tunnel

First create the dedicated kubeconfig and export `AWS_REGION`, `EKS_CLUSTER`,
`KUBECONFIG_FILE`, and `CONTEXT` as in [Select the cluster](eks.md#select-the-cluster).
Confirm the AWS account and cluster, and choose the approved instance and an
unused local port. `describe-cluster` must report the intended private endpoint:

```bash
aws sts get-caller-identity
aws eks describe-cluster --region "$AWS_REGION" --name "$EKS_CLUSTER" \
  --query 'cluster.{name:name,endpoint:endpoint,private:resourcesVpcConfig.endpointPrivateAccess}'
export EKS_ENDPOINT="$(aws eks describe-cluster --region "$AWS_REGION" --name "$EKS_CLUSTER" --query cluster.endpoint --output text)"
export EKS_HOST="${EKS_ENDPOINT#https://}"
export EKS_LOCAL_PORT='18443'
export SSM_TARGET='<approved-managed-instance-id>'
```

In a separate terminal with the same AWS profile and exports, start the tunnel
and keep it running for the operation:

```bash
aws ssm start-session --region "$AWS_REGION" --target "$SSM_TARGET" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$EKS_HOST,portNumber=443,localPortNumber=$EKS_LOCAL_PORT"
```

Wait for the session to report that it is listening. In the original shell,
change only the dedicated kubeconfig to use loopback while retaining TLS
verification against the real EKS hostname and the cluster CA installed by
`update-kubeconfig`:

```bash
export KUBE_CLUSTER="$(kubectl --kubeconfig "$KUBECONFIG_FILE" config view --context "$CONTEXT" --minify -o jsonpath='{.contexts[0].context.cluster}')"
: "${KUBE_CLUSTER:?Selected context has no cluster}"
kubectl --kubeconfig "$KUBECONFIG_FILE" config set-cluster "$KUBE_CLUSTER" \
  --server="https://127.0.0.1:$EKS_LOCAL_PORT" --tls-server-name="$EKS_HOST"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" --request-timeout=15s get nodes
```

Ensure local proxy settings bypass `127.0.0.1`. Keep certificate verification
enabled. If the check fails, inspect the SSM session, instance DNS and route,
cluster security group, AWS credentials, and cluster authorization; a tunnel
listening locally alone does not prove endpoint access. Reconnect an expired or
interrupted session and rerun the read-only check. The dedicated kubeconfig
continues to point at loopback; regenerate it with `aws eks update-kubeconfig`
when returning to direct private access. Preserve the default kubeconfig.

## Read back before retrying

A timeout can mean the client lost its connection while the server continued
working. Restore the connection and check the exact cluster, namespace,
release, and operation before repeating a mutation. For the production example:

```bash
helm status oce --namespace openclaw-system \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT"
helm history oce --namespace openclaw-system \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace openclaw-system get jobs,pods
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace openclaw-system get events --sort-by=.lastTimestamp
```

Choose a Pod for your intended release from `get jobs,pods` above, replace
`<pod-name>` once, and use the chosen kubeconfig, context, and namespace.
JSON Lines show that Pod's returned namespace/name/UID and declared containers
only; release ownership, other replicas, traffic, and data remain unverified.
Check the exit status before using the output. A nonzero status means the snapshot failed.

```bash
(
set -o pipefail
pod='<pod-name>'; namespace='openclaw-system'
kubectl --kubeconfig "${KUBECONFIG_FILE:?Set a kubeconfig}" \
  --context "${CONTEXT:?Set a context}" --namespace "${namespace:?Set a namespace}" \
  --request-timeout=15s get "pod/${pod:?Set a Pod name}" -o json 2>/dev/null |
jq -ce --arg pod "$pod" --arg ns "$namespace" '
  def rows($kind; $declared; $statuses): $declared[]? as $c |
    ([$statuses[]? | select(.name == $c.name)][0] // {}) as $s |
    {kind: $kind, name: $c.name, restartPolicy: $c.restartPolicy,
     ready: $s.ready, restartCount: $s.restartCount, waitingReason: $s.state.waiting.reason,
     currentExit: $s.state.terminated.exitCode, previousReason: $s.lastState.terminated.reason,
     previousExit: $s.lastState.terminated.exitCode};
  select(.metadata.name == $pod and .metadata.namespace == $ns) |
  {namespace: .metadata.namespace, name: .metadata.name, uid: .metadata.uid},
  rows("ordinary"; .spec.containers; .status.containerStatuses),
  rows("init"; .spec.initContainers; .status.initContainerStatuses)' 2>/dev/null
)
```

`null` means absent or unknown; `false` and numeric `0` are actual values,
including `previousExit: 0`.
An `init` with `restartPolicy: "Always"` is a restartable sidecar whose false
readiness is not setup completion; other init containers with `currentExit: 0`
have completed setup even if not ready.

Compare the release revision and status, hook Jobs and their logs, and observed
workload images with the intended operation. Check the Installation Secret's
metadata and the intended configuration through an approved protected path;
do not print its contents. A missing release or Job is not by itself proof that
no migration or bootstrap ran. For database mutations, use a read-only query or
the database owner's transaction and audit evidence to establish the exact
outcome. If the outcome is unknown, stop and investigate rather than retrying,
rolling back, or deleting resources. For an interrupted upgrade, follow the
[production upgrade recovery procedure](production-upgrade.md) and its migration
checklist before choosing the next action. Readiness and Helm success do not
replace the installation's authenticated API and Agent checks.
