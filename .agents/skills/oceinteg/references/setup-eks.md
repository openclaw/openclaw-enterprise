# Set up OpenShell on Amazon EKS

Use [Run a dedicated OpenShell Agent on EKS](../../../../docs/guides/deploy/eks-openshell-setup.md)
for `quickstart` and the dedicated OpenShell Codex baseline of `main`. The guide
owns AWS prerequisites, images, OpenShell, Helm, private browser access,
Namespace preparation, model authentication and onboarding. Record instruction
gaps and workarounds in the scenario's deviation log.

## Resolve the target

Record the authorized AWS account/role, region, fresh cluster/VPC and database,
node pools, private kubeconfig/context, release names, source/chart/image
versions, cost scope and retention decision. Cloud creation and deletion require
explicit scope. Helm does not create the AWS foundation. Transfer only the
approved short-lived AWS session using [Supply credentials](./credentials.md);
confirm account/role and expiry on the execution host before cloud operations.

## Follow the guide in order

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

For `main`, continue its additional preset, Slack, approval, permission and
lifecycle cases. Prepare a separate fresh installation through the
[production installation guide](../../../../docs/guides/deploy/production-installation.md)
and matching Driver configuration for its Standard OpenClaw branch. The
OpenShell Codex quickstart alone does not satisfy that broader scenario.

## Retain or dispose

Honor the selected scenario's retention decision. Leave requested Agents,
claims and required services running, with Git read-only after the push.
For disposal, follow [Delete Agent](../../../../docs/guides/deploy/quickstart-delete-agent.md)
then [EKS cleanup](../../../../docs/guides/deploy/eks-cleanup.md). Verify owned
AWS resource deletion or intentional retention and ongoing charges. Preserve
shared clusters, database resources, credentials and other installations.
