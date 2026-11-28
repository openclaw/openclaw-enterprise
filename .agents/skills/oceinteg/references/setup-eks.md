# Set up OpenShell on Amazon EKS

Use [Run a dedicated OpenShell Agent on EKS](../../../../docs/guides/deploy/eks-openshell-setup.md)
from the matching checkout. Resolve the target, then follow the section for
the requested scenario. Record deviations against that scenario.

## Resolve the target

Record the authorized AWS account/role, region, fresh cluster/VPC and database,
node pools, private kubeconfig/context, release names, source/chart/image
versions, cost scope and retention decision. Cloud creation and deletion require
explicit scope. Helm does not create the AWS foundation. Transfer only the
approved short-lived AWS session using [Supply credentials](./credentials.md);
confirm account/role and expiry on the execution host before cloud operations.

## Main

Complete the EKS guide's installation and **Authenticate and prepare the
Namespace**. Keep private browser access, verified Envoy peers, worker startup
and tenant RoleBindings. Once the Namespace is ready, keep its operator shell
open. Switch to [main's Console workflow](./main.md#dedicated-codex-setup)
before the quickstart registers a model credential or creates its first Agent.
Use the named preset, including when the first-Agent guide offers **Start
without Preset**.

For each dedicated Agent, including Standard Codex and the separate SWE Agent:

1. Run `deployment_preflight` before submitting from Console. While creation
   is pending, open **Agents** in a second tab in the same Namespace. Open the
   run's uniquely named Agent and set `agent` in the operator shell to the ID
   after `/agents/` in that tab's URL.
2. Run `deployment_network` as soon as the Agent ID is known. It waits for that
   Agent's Gateway Service and applies its network policies. Do not wait for
   activation or reuse another Agent's policies.
3. Under **Viewing version**, select the first saved version and read its
   deployment ID from `revision=`. As in the guide's `wait_deployment` check,
   use read-only inspection to verify that deployment succeeded and the same
   Agent's `activeRevisionId` matches it. For later deployments verify the
   specific version submitted. If the IDs or state cannot be established,
   record the blocked case without submitting another deployment.

Complete the EKS guide's [workspace routing checks](../../../../docs/guides/deploy/eks-openshell-setup.md#verify-workspace-routing).

Use a separate fresh [production installation](../../../../docs/guides/deploy/production-installation.md)
with the matching Driver for Standard OpenClaw.

## Quickstart

Follow the full EKS guide in order:

1. Complete the EKS infrastructure, registry, network and storage prerequisites.
   Verify eligible nodes, sandbox requirements, CSI readiness, encrypted storage
   and reviewed network rules. Do not inherit an earlier installation's proof.
2. Follow [private EKS access](../../../../docs/guides/deploy/eks-private-access.md)
   if required. Preserve TLS/SNI checks and the default kubeconfig. Record owned
   tunnels. An API tunnel does not provide general VPC DNS.
3. Complete the setup guide's shared OpenShell and OCC installation, browser TLS
   access, Namespace bindings and exact Agent model grant. Its deployment
   helpers must retain the Gateway Service wait and network-policy application;
   a renamed local helper is not equivalent network preparation.
4. Complete Control UI onboarding, reopen the same conversation, and save the
   private [operator session](../../../../docs/guides/deploy/quickstart-session.md).
   Use that session for shared [Add Git](../../../../docs/guides/repository-credentials/openshell-git-push.md)
   and [Add Plugin](../../../../docs/guides/integrations/codex-plugins.md).

## Retain or dispose

For `main`, follow [main's completion steps](./runtime-acceptance.md#completion)
using its own Agent and installation records. For `quickstart`:

Honor the selected scenario's retention decision. Leave requested Agents,
claims and required services running, with Git read-only after the push.
For disposal, follow [Delete Agent](../../../../docs/guides/deploy/quickstart-delete-agent.md)
then [EKS cleanup](../../../../docs/guides/deploy/eks-cleanup.md). Verify owned
AWS resource deletion or intentional retention and ongoing charges. Preserve
shared clusters, database resources, credentials and other installations.
