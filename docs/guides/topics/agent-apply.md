# Apply an Agent from a file

Use `occ agent apply` to keep one Agent in a file, for example in Git. Set up
the [CLI](../../reference/cli.md) first, then run:

```sh
occ --namespace NAMESPACE_ID agent apply --file agent.json
```

The result is `created`, `updated` or `unchanged`. The file is the
[provision](../../reference/api.md) request body without `requestId`. It holds
references to Secrets, never Secret values. `name` selects the Agent.

- **No Agent has the name:** `apply` queues first-time provisioning with a
  `requestId` derived from the file, so repeating the same file is safe. The
  result is `created`. Check progress with the work ID it prints. Provisioning needs Installation `administer`, and it needs dedicated
  execution on Kubernetes Compute.
- **An Agent has the name:** `apply` compares the file with the saved
  Configuration and Agent. It saves each change and deploys once. The result is
  `updated`. If nothing changed, it makes no write or deployment, and the result
  is `unchanged`. A `secretBindings` list that the file omits keeps its saved value.

`apply` refuses a file with an unknown field or without `configuration.values`
before any write. It changes only `configuration` and these Agent fields: `backendId`,
`harnessAuth`, `executionMode`, `gatewayManagedMode`, `plugins` and
`pluginApprovers`. For an existing Agent, `initialWorkspaceFiles`,
`workspaceDefaultsId`, `nativeAdmin`, `repositoryBindings` and `repositoryAccess`
fail the command before any write. Use `occ agent update` for the repository
settings. The other three apply only when the Agent is created.

Deployment checks the saved Configuration against the Agent. If the deploy fails
after the save, the error names the cause and the command `occ agent deploy ID`.
Fix the cause, then run that command. If the reply was lost or was a server
error, the error says the result is unknown. Check `occ agent revisions ID` for
a revision with the saved generation before you deploy again. A second `apply`
reports `unchanged`, because the values are saved.

See the [CLI apply flow](../../flows/cli-agent-apply.md).
