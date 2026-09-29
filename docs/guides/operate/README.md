# Operate OpenClaw Enterprise

Use these guides to install and run OpenClaw Enterprise on Kubernetes. They are
for operators responsible for the OpenClaw Control Plane (OCC), tenant
Namespaces, networking, and runtime credentials. If you want to try the platform
on your own machine, start with [Local Setup](../quickstart.md).

## Install the platform

1. Choose [standard Kubernetes](../deploy/kubernetes.md) or
   [Amazon EKS](../deploy/eks.md) to prepare the cluster, storage, and network.
2. [Install the control plane](../deploy/production-installation.md) and make an
   authenticated API request. Helm readiness alone does not verify API access.
3. [Deploy a production Agent](../deploy/production-agents.md) and verify the
   selected runtime. An active revision alone does not prove a model can answer;
   use the [model response verification](model-verification.md) for trusted-proxy gateways.
4. [Prepare the production handoff](../deploy/production-handoff.md) to record
   who responds to failures and who owns credentials and access.

The [installation overview](../deploy.md) lists shared prerequisites and explains
which resources Helm leaves behind when you uninstall it.

## Run the platform

| Task                                                                            | Start here                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Diagnose a failed installation, blocked Namespace, or unavailable control plane | [Troubleshoot the platform](troubleshooting.md)                                                  |
| Configure or verify operational logs                                            | [Observability](../observability.md)                                                             |
| Scrape application metrics                                                      | [OCC metrics](../../reference/metrics.md) and [production scraping](../observability/metrics.md) |
| Connect the control plane to private Agent workspace files                      | [Agent workspace routing](../deploy/workspace-routing.md)                                        |
| Set up and verify the trusted-operator native admin pilot                       | [Agent native admin UI](../deploy/native-admin.md)                                               |
| Renew or revoke a credential                                                    | [Credential rotation](../deploy/credential-lifecycle.md)                                         |
| Issue or revoke keys for scripts and services                                   | [Service API Keys](../../reference/authentication/service-api-keys.md)                           |

For a failure isolated to one Agent, start with [Agent troubleshooting](../topics/agent-troubleshoot.md).
