package occcli

// Help examples for the create commands that read a JSON document. Each shows
// the smallest body the API accepts; TestCreateCommandsShowAJSONExample keeps
// every body parseable.

const iamRoleCreateExample = `  cat > role.json <<'JSON'
  {"name": "Read Agents", "permissions": [{"action": "read", "resourceKind": "agent"}]}
JSON
  occ iam role create --file role.json

  Permissions pair an action with a resource kind. See
  https://docs-enterprise.openclaw.org/reference/authorization/`

const iamAccessBindingCreateExample = `  cat > binding.json <<'JSON'
  {"subjectKind": "identity", "subjectId": "<principal-id>", "roleId": "<role-id>",
   "resourceKind": "agent", "resourceId": "<agent-id>"}
JSON
  occ iam access-binding create --file binding.json

  subjectId is a human Principal or a ServicePrincipal in the Namespace. The Role
  and the exact target must exist in the Namespace. See
  https://docs-enterprise.openclaw.org/reference/authorization/`

const configurationCreateExample = `  cat > configuration.json <<'JSON'
  {"kind": "agent", "values": {"agents": {"defaults": {"model": "<provider>/<model>"}}}}
JSON
  occ configuration create --file configuration.json

  values is a native OpenClaw configuration document. This minimal one is accepted
  at create; a deployable Agent also needs gateway and Harness runtime settings.
  For a complete example, see
  https://docs-enterprise.openclaw.org/guides/deploy/production-agents/`

const secretCreateExample = `  (umask 077; tr -d '\n' < /path/to/key | jq -Rs '{name: "openai-model-key", value: .}' > secret.json)
  occ secret create --file secret.json
  rm secret.json

  The body is {"name": "<name>", "value": "<secret value>"}. Keep the value off the
  command line and delete the file after use.`

const agentCreateExample = `  cat > agent.json <<'JSON'
  {"name": "example-agent", "configurationId": "<configuration-id>", "executionMode": "embedded"}
JSON
  occ agent create --file agent.json

  Add harnessAuth to select model authentication. See
  https://docs-enterprise.openclaw.org/reference/agents/`

const credentialSourceCreateExample = `  cat > credential-source.json <<'JSON'
  {"name": "openai", "type": "openai",
   "secrets": {"api_key": {"kind": "secret", "namespaceId": "<namespace-id>", "id": "<secret-id>"}}}
JSON
  occ credential-source create --file credential-source.json

  Each secrets field is the ref that occ secret create -o json returns. The gateway
  keeps its own copy of the value; see
  https://docs-enterprise.openclaw.org/reference/credential-sources/`

const iamServicePrincipalCreateExample = `  occ iam service-principal create --namespace <namespace-id>

  The ServicePrincipal holds no grant. Bind a Role to it with
  occ iam access-binding create, then issue its key with occ service-key create.`

const serviceKeyCreateExample = `  occ service-key create --namespace <namespace-id> \
    --service-principal <service-principal-id> --name nora-laptop --out nora.json
  OCC_SERVICE_KEY_FILE=nora.json occ --namespace <namespace-id> agent list

  Pass --namespace for a Namespace ServicePrincipal; for an Installation one, omit
  it and unset OCC_NAMESPACE. You must already hold every grant of the ServicePrincipal. The key file is
  the only copy of the key: hand it over privately and revoke it when unused.`
