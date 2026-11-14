# Set up local k3d with OpenShell

Use [Set up OCE locally with OpenShell and Codex](../../../../docs/guides/deploy/local-setup.md)
from the matching checkout. Choose the section for the requested scenario.

## Main

Use a fresh cluster, private state directory and unused ports. Complete the local
guide's Kubernetes and OpenShell setup, including authenticated Gateway
bootstrap, trusted browser access and the Credential Gateway configuration.
Finish the installation reload in the matching guide and verify Namespace
readiness. Where **Prepare the operator session** performs the reload, complete
that step; editing the configuration file alone does not apply it.

Stop before the quickstart registers a model credential or creates its first
Agent. In the ready Namespace, use [main's Standard Codex preset](./main.md#dedicated-codex-setup)
in Console. Keep this installation's operator context separate from any
previous quickstart Agent or session.

Use a separate fresh [Kubernetes-only local installation](../../../../docs/guides/deploy/local-kubernetes-development.md)
with the matching runtime and Plugin Driver for Standard OpenClaw. A local
profile without OpenShell does not prove the dedicated OpenShell Codex case.

## Quickstart

Follow the full local guide in order:

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

## Retain or dispose

For `main`, follow [main's completion steps](./runtime-acceptance.md#completion)
using its own Agent and installation records. For `quickstart`:

Honor [the selected scenario's retention](./runtime-acceptance.md#completion).
Keep running Agents and their required claims, forwards and services when
requested. For disposal, follow [Delete Agent](../../../../docs/guides/deploy/quickstart-delete-agent.md)
then [local cleanup](../../../../docs/guides/deploy/local-cleanup.md) with the
original state directory and engine. Verify only owned resources were removed.
Record any retained credentials, public browser trust entry, state directory
and remaining access processes. No EKS result may be inferred from this proof.
