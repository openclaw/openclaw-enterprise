# Continue an EKS owner session

Complete [EKS installation setup](eks-openshell-setup.md) through browser onboarding and reopening the same conversation. Keep its private `session.sh` and the laptop port-forward. The same [operator session](quickstart-session.md) now supports every quickstart platform.

## Choose a Console deployment action

<Snippet file="../../snippets/openshell-quickstart/console-deployment-actions.md" />

Run `deployment_preflight` before a Console deployment and `wait_deployment <deployment-id>` afterward. This checks the recorded Envoy peers and prepares the new Agent Service's network rules.

## Complete onboarding in the browser

Follow [setup's onboarding check](eks-openshell-setup.md#7-complete-onboarding-in-the-control-ui). Use the same Agent and conversation after each deployment. Keep the workspace and private listener available.

## Temporarily grant one push

Follow the shared [Add Git](../repository-credentials/openshell-git-push.md) instructions. They enroll the repository, preserve model authentication, prepare read/write maps, deploy the binding, and verify one empty commit independently.

## Restore read-only access

Use [Restore read-only Git](../repository-credentials/openshell-read-only.md). It retains this guide's worker-based custody audit, accepts recorded expiry, verifies the read-only registry mount, updates cluster network rules, and checks authenticated read receipts on the final revision.

Add the managed Linear plugin through [Add Plugin](../integrations/codex-plugins.md). When finished, [delete the Agent](quickstart-delete-agent.md) and [clean up the EKS installation](eks-cleanup.md). Closing the laptop forward disconnects the browser but does not stop AWS charges.
