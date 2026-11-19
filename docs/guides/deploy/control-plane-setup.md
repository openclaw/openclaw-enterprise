---
tags: [human_verified]
last_verified: "2026-11-18"
---

# Set up the control plane

Set up the OpenClaw Control Plane (OCC) on a Kubernetes cluster you operate.
Use the shared Helm procedure and any preparation required by your platform.

| Environment                             | Start here                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
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
