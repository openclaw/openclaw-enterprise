# Set up OpenShell on an existing Kubernetes cluster

Use [Set up an OpenShell Codex Agent on Kubernetes](../../../../docs/guides/deploy/kubernetes-setup.md)
for the generic Kubernetes `quickstart` target. Resolve the approved existing
cluster/context, storage class, external database, image versions, run ownership
and retention choice before changing resources.

Follow the guide's infrastructure preflight, private OpenShell/OCC installation,
browser access, Namespace grants and Agent onboarding in order. Keep the
Gateway Service wait and network-policy hooks supplied by this setup. Save and
resume the private [operator session](../../../../docs/guides/deploy/quickstart-session.md)
then return to [quickstart verification](./quickstart.md).

For disposal, follow [Delete Agent](../../../../docs/guides/deploy/quickstart-delete-agent.md)
and [Kubernetes cleanup](../../../../docs/guides/deploy/kubernetes-cleanup.md).
Record retained infrastructure and credentials. Preserve the existing cluster
and resources outside this run's recorded ownership.
