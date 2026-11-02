# Set up OpenClaw Enterprise on Kubernetes

The complete [Kubernetes quickstart](deploy/kubernetes-setup.md) installs OpenShell, deploys one dedicated Codex Agent, and verifies onboarding in its Control UI. Choose the platform once, then use the shared Add Git and Add Plugin guides.

## What the install creates

See [Kubernetes setup](deploy/kubernetes-setup.md) for the control plane, OpenShell and dedicated Agent workflow.

## Before you start

Use the [Kubernetes prerequisites](deploy/kubernetes-setup.md#before-you-start).

## 1. Check the cluster

Follow [Prepare the cluster and images](deploy/kubernetes-setup.md#1-prepare-the-cluster-and-images).

## 2. Prepare the inputs and install OCC

Continue with [Install OpenShell and bootstrap OCC](deploy/kubernetes-setup.md#2-install-openshell-and-bootstrap-occ).

## 3. Deploy and verify an Agent

Complete [Agent setup](deploy/kubernetes-setup.md#4-connect-to-the-api-and-register-the-model-credential) and [browser onboarding](deploy/kubernetes-setup.md#7-complete-onboarding-in-the-control-ui).

## Next steps

[Add Git](repository-credentials/openshell-git-push.md) and [Add Plugin](integrations/codex-plugins.md) use the saved operator session from setup.
