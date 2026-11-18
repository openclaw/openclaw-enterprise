# Set up the control plane

Choose a setup path for the OpenClaw Control Plane (OCC). Local setup creates a
development installation. The Kubernetes path uses the shared Helm procedure
for a cluster you operate.

| Environment                             | Start here                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Local Linux or macOS                    | [Local setup without OpenShell](../quickstart.md)                                                                           |
| Existing Kubernetes cluster             | [Prepare the cluster](kubernetes.md), then [install the control plane](production-installation.md)                          |
| OpenShift                               | [Prepare the cluster](kubernetes.md), apply [OpenShift networking settings](openshift.md), then use the shared installation |
| Azure PostgreSQL with workload identity | Prepare [database authentication](azure-postgresql.md) before the shared Kubernetes installation                            |

Azure workload identity is an optional database authentication mode, not a
requirement for Kubernetes. Cloud and distribution-specific pages add only their
required settings; the shared installation owns image selection, configuration,
bootstrap, and API access verification.

For OpenShell evaluation, use the Getting Started installation paths:
[local k3d](local-setup.md), [Kubernetes](kubernetes-setup.md), or
[Amazon EKS](eks-openshell-setup.md). These workflows are not production-qualified.

After the shared installation, [deploy an Agent](production-agents.md) and
[prepare the operational handoff](production-handoff.md).
