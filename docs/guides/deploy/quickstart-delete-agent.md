# Delete the quickstart Agent

Use the saved operator session from your installation setup. These steps are identical on local k3d, Kubernetes and Amazon EKS. They delete the selected Agent's execution, workspace and version history; the installation remains available.

```bash
source /path/to/private/run/session.sh
request DELETE "$base/agents/$agent"
```

The API accepts deletion with HTTP `202` and an Agent in `deleting` state. Repeat this read until it prints `404`:

```bash
request_status GET "$base/agents/$agent"
```

HTTP `200` means the Agent still exists; inspect it with `request GET "$base/agents/$agent"`. Authentication errors and transport failures do not confirm deletion. For failed deletion, use [Agent deletion recovery](../../reference/agents.md#deletion). If DELETE times out, read the Agent before retrying.

You do not need to stop the Agent separately, withdraw repository approvals, or wait for Git credential retirement before deleting it. Immediate installation teardown can leave issued GitHub tokens valid until expiry because its worker can no longer revoke them. Deletion does not revoke the service-account PAT.

## Clean up the installation

After the Agent is gone, use the cleanup page for the platform already recorded in the session:

```bash
case "$PLATFORM" in
  local-k3d) printf '%s\n' '/guides/deploy/local-cleanup/' ;;
  kubernetes) printf '%s\n' '/guides/deploy/kubernetes-cleanup/' ;;
  eks) printf '%s\n' '/guides/deploy/eks-cleanup/' ;;
  *) printf 'Unknown session platform: %s\n' "$PLATFORM" >&2; exit 1 ;;
esac
```

[Local k3d cleanup](local-cleanup.md) · [Kubernetes cleanup](kubernetes-cleanup.md) · [Amazon EKS cleanup](eks-cleanup.md)
