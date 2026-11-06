# Set up local k3d with OpenShell

Use [Set up OCE locally with OpenShell and Codex](../../../../docs/guides/deploy/local-setup.md)
for `quickstart` and the dedicated OpenShell Codex baseline of `main`. Its guide
owns tool installation, compatible image selection, gateway bootstrap,
installation settings, model authentication, Agent creation, onboarding and
session persistence. Follow the guide in order from its matching checkout.

## Follow the guides in order

1. Resolve a fresh run directory, cluster name, unused API/browser/Kubernetes
   ports, immutable images and retention choice. Preserve unrelated clusters,
   engine state and the default kubeconfig/context.
2. Use the guide's Kubernetes control plane and OpenShell sandbox selection.
   Do not replace it with `OCC_DEVELOPMENT_SANDBOX_DRIVER=none` for this baseline.
   Wait for the launcher to complete Gateway TLS, mTLS and authentication
   bootstrap and print the ready message before continuing.
3. Register the Gateway-owned Codex model source before enabling repository
   credentials. Complete first-Agent creation and Control UI onboarding. Trust
   only the generated public browser CA and keep its private key on the host.
4. Save and resume the private [operator session](../../../../docs/guides/deploy/quickstart-session.md)
   in a fresh Bash shell, then follow the shared Git and plugin guides selected
   by the scenario. Keep the same Agent and installation throughout.

For `main`, this establishes only its dedicated Codex baseline. Continue with
main's additional preset, Slack, approval, permission and lifecycle cases.
Its separate Standard OpenClaw branch needs a fresh installation using the
supported [Kubernetes-only local profile](../../../../docs/guides/deploy/local-kubernetes-development.md)
and matching runtime/Plugin Driver. A profile without OpenShell is a separate
runtime result. A Codex quickstart pass does not prove that branch.

## Retain or dispose

Honor [the selected scenario's retention](./runtime-acceptance.md#completion).
Keep running Agents and their required claims, forwards and services when
requested. For disposal, follow [Delete Agent](../../../../docs/guides/deploy/quickstart-delete-agent.md)
then [local cleanup](../../../../docs/guides/deploy/local-cleanup.md) with the
original state directory and engine. Verify only owned resources were removed.
Record any retained credentials, public browser trust entry, state directory
and remaining access processes. No EKS result may be inferred from this proof.
