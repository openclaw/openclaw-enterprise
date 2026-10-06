package occclient

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"net/http"
	"net/url"
)

// RuntimeLogPage is one page of sanitized runtime log records. Records keep the
// server's JSON so callers can re-emit them unchanged.
type RuntimeLogPage struct {
	RevisionID string           `json:"revisionId"`
	Source     string           `json:"source"`
	Stream     jsontext.Value   `json:"stream"`
	ObservedAt string           `json:"observedAt"`
	Records    []jsontext.Value `json:"records"`
	Withheld   int              `json:"withheld"`
	Truncated  bool             `json:"truncated"`
	Cursor     *string          `json:"cursor"`
}

// GetInstallation fetches the singleton Installation.
func (client *Client) GetInstallation() (any, error) {
	return client.get("installation")
}

// GetInstallationDeploymentInventory fetches the complete authorized Agent deployment inventory.
func (client *Client) GetInstallationDeploymentInventory() (any, error) {
	return client.get("installation", "deployment-inventory")
}

// CreateNamespace creates a Namespace.
func (client *Client) CreateNamespace(name, existingNamespace string) (any, error) {
	body := map[string]any{"name": name}
	if existingNamespace != "" {
		body["existingNamespace"] = existingNamespace
	}
	return client.send(http.MethodPost, []string{"namespaces"}, body)
}

// ListNamespaces lists Namespaces visible to the caller.
func (client *Client) ListNamespaces() (any, error) {
	return client.get("namespaces")
}

// GetNamespace fetches a Namespace.
func (client *Client) GetNamespace(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID)
}

// DeleteNamespace begins deletion of an empty Namespace.
func (client *Client) DeleteNamespace(namespaceID string) (any, error) {
	return client.send(http.MethodDelete, []string{"namespaces", namespaceID}, nil)
}

// ListIAMRoles lists Namespace IAM Roles.
func (client *Client) ListIAMRoles(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID, "iam", "roles")
}

// CreateIAMRole creates an immutable Namespace IAM Role.
func (client *Client) CreateIAMRole(namespaceID string, body jsontext.Value) (any, error) {
	return client.send(http.MethodPost, []string{"namespaces", namespaceID, "iam", "roles"}, body)
}

// GetIAMRole fetches a Namespace IAM Role.
func (client *Client) GetIAMRole(namespaceID, roleID string) (any, error) {
	return client.get("namespaces", namespaceID, "iam", "roles", roleID)
}

// DeleteIAMRole deletes an unreferenced Namespace IAM Role.
func (client *Client) DeleteIAMRole(namespaceID, roleID string) error {
	return client.sendEmpty(http.MethodDelete, []string{"namespaces", namespaceID, "iam", "roles", roleID})
}

// ListIAMAccessBindings lists Namespace IAM AccessBindings.
func (client *Client) ListIAMAccessBindings(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID, "iam", "access-bindings")
}

// CreateIAMAccessBinding creates an immutable Namespace IAM AccessBinding.
func (client *Client) CreateIAMAccessBinding(namespaceID string, body jsontext.Value) (any, error) {
	return client.send(http.MethodPost, []string{"namespaces", namespaceID, "iam", "access-bindings"}, body)
}

// GetIAMAccessBinding fetches a Namespace IAM AccessBinding.
func (client *Client) GetIAMAccessBinding(namespaceID, bindingID string) (any, error) {
	return client.get("namespaces", namespaceID, "iam", "access-bindings", bindingID)
}

// DeleteIAMAccessBinding deletes one exact Namespace IAM AccessBinding.
func (client *Client) DeleteIAMAccessBinding(namespaceID, bindingID string) error {
	return client.sendEmpty(
		http.MethodDelete,
		[]string{"namespaces", namespaceID, "iam", "access-bindings", bindingID},
	)
}

// CreateConfiguration creates a Configuration in a Namespace.
func (client *Client) CreateConfiguration(namespaceID string, body jsontext.Value) (any, error) {
	return client.send(
		http.MethodPost,
		[]string{"namespaces", namespaceID, "configurations"},
		body,
	)
}

// GetConfiguration fetches a Configuration.
func (client *Client) GetConfiguration(namespaceID, configurationID string) (any, error) {
	return client.get("namespaces", namespaceID, "configurations", configurationID)
}

// UpdateConfiguration updates a Configuration from a JSON document.
func (client *Client) UpdateConfiguration(
	namespaceID string,
	configurationID string,
	body jsontext.Value,
) (any, error) {
	return client.send(
		http.MethodPatch,
		[]string{"namespaces", namespaceID, "configurations", configurationID},
		body,
	)
}

// DeleteConfiguration deletes an unreferenced Configuration.
func (client *Client) DeleteConfiguration(namespaceID, configurationID string) error {
	return client.sendEmpty(
		http.MethodDelete,
		[]string{"namespaces", namespaceID, "configurations", configurationID},
	)
}

// CreateSecret creates a Secret in a Namespace and returns metadata only.
func (client *Client) CreateSecret(namespaceID string, body jsontext.Value) (any, error) {
	return client.send(http.MethodPost, []string{"namespaces", namespaceID, "secrets"}, body)
}

// ListSecrets lists Secret metadata in a Namespace without material.
func (client *Client) ListSecrets(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID, "secrets")
}

// GetSecret fetches Secret metadata without material.
func (client *Client) GetSecret(namespaceID, secretID string) (any, error) {
	return client.get("namespaces", namespaceID, "secrets", secretID)
}

// UpdateSecret replaces Secret material and returns stable metadata.
func (client *Client) UpdateSecret(namespaceID, secretID string, body jsontext.Value) (any, error) {
	return client.send(http.MethodPatch, []string{"namespaces", namespaceID, "secrets", secretID}, body)
}

// DeleteSecret deletes an unbound Secret.
func (client *Client) DeleteSecret(namespaceID, secretID string) error {
	return client.sendEmpty(http.MethodDelete, []string{"namespaces", namespaceID, "secrets", secretID})
}

// ListPresets lists the Presets in a Namespace that the caller can read.
func (client *Client) ListPresets(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID, "presets")
}

// GetPreset fetches a Preset with its template.
func (client *Client) GetPreset(namespaceID, presetID string) (any, error) {
	return client.get("namespaces", namespaceID, "presets", presetID)
}

// DeletePreset deletes a Preset and its exact-resource AccessBindings.
func (client *Client) DeletePreset(namespaceID, presetID string) error {
	return client.sendEmpty(http.MethodDelete, []string{"namespaces", namespaceID, "presets", presetID})
}

// CreateCredentialSource registers a Namespace Secret with the selected Credential Gateway.
func (client *Client) CreateCredentialSource(namespaceID string, body jsontext.Value) (any, error) {
	return client.send(
		http.MethodPost,
		[]string{"namespaces", namespaceID, "credential-sources"},
		body,
	)
}

// ListCredentialSources lists credential sources without live gateway status.
func (client *Client) ListCredentialSources(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID, "credential-sources")
}

// GetCredentialSource fetches a credential source with its live gateway status.
func (client *Client) GetCredentialSource(namespaceID, sourceID string) (any, error) {
	return client.get("namespaces", namespaceID, "credential-sources", sourceID)
}

// UpdateCredentialSource pushes current or replacement Secret values to the gateway copy.
func (client *Client) UpdateCredentialSource(
	namespaceID string,
	sourceID string,
	body jsontext.Value,
) (any, error) {
	return client.send(
		http.MethodPatch,
		[]string{"namespaces", namespaceID, "credential-sources", sourceID},
		body,
	)
}

// WithdrawAgentCredentialSource revokes a credential source from an Agent's active revision.
func (client *Client) WithdrawAgentCredentialSource(namespaceID, agentID, sourceID string) (any, error) {
	return client.send(
		http.MethodPost,
		[]string{"namespaces", namespaceID, "agents", agentID, "credential-sources", sourceID, "withdraw"},
		nil,
	)
}

// GetAgentCredentialWithdrawal reads a withdrawal of a credential source from an Agent.
func (client *Client) GetAgentCredentialWithdrawal(namespaceID, agentID, sourceID string) (any, error) {
	return client.get(
		"namespaces", namespaceID, "agents", agentID, "credential-sources", sourceID, "withdrawal",
	)
}

// DeleteCredentialSource removes an unreferenced credential source and its gateway copy.
func (client *Client) DeleteCredentialSource(namespaceID, sourceID string) error {
	return client.sendEmpty(
		http.MethodDelete,
		[]string{"namespaces", namespaceID, "credential-sources", sourceID},
	)
}

// CreateAgent creates an Agent in a Namespace.
func (client *Client) CreateAgent(namespaceID string, body jsontext.Value) (any, error) {
	return client.send(http.MethodPost, []string{"namespaces", namespaceID, "agents"}, body)
}

// ListAgents lists Agents in a Namespace.
func (client *Client) ListAgents(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID, "agents")
}

// ListRepositoryOptions lists repositories admitted for Agent creation.
func (client *Client) ListRepositoryOptions(namespaceID string) (any, error) {
	return client.get("namespaces", namespaceID, "agents", "repository-options")
}

// GetAgent fetches an Agent.
func (client *Client) GetAgent(namespaceID, agentID string) (any, error) {
	return client.get("namespaces", namespaceID, "agents", agentID)
}

// UpdateAgent updates an Agent from a JSON document.
func (client *Client) UpdateAgent(namespaceID, agentID string, body jsontext.Value) (any, error) {
	return client.send(http.MethodPatch, []string{"namespaces", namespaceID, "agents", agentID}, body)
}

// GetAgentRuntimeCredentials fetches runtime credential metadata for an Agent.
func (client *Client) GetAgentRuntimeCredentials(namespaceID, agentID string) (any, error) {
	return client.get("namespaces", namespaceID, "agents", agentID, "runtime-credentials")
}

// ProvisionAgentRuntimeCredentials provisions initial runtime credentials for an Agent.
func (client *Client) ProvisionAgentRuntimeCredentials(namespaceID, agentID string) (any, error) {
	return client.send(
		http.MethodPost,
		[]string{"namespaces", namespaceID, "agents", agentID, "runtime-credentials"},
		map[string]any{},
	)
}

// DeployAgent deploys an Agent and creates an immutable revision.
func (client *Client) DeployAgent(namespaceID, agentID string) (any, error) {
	return client.send(
		http.MethodPost,
		[]string{"namespaces", namespaceID, "agents", agentID, "deploy"},
		nil,
	)
}

// ListAgentRevisions lists the readable immutable revisions of an Agent.
func (client *Client) ListAgentRevisions(namespaceID, agentID string) (any, error) {
	return client.get("namespaces", namespaceID, "agents", agentID, "revisions")
}

// GetAgentDeployment fetches durable deployment status for one Agent revision.
func (client *Client) GetAgentDeployment(namespaceID, agentID, deploymentID string) (any, error) {
	return client.get(
		"namespaces",
		namespaceID,
		"agents",
		agentID,
		"deployments",
		deploymentID,
	)
}

// GetAgentRuntime fetches Pod status, restarts, Events and log sources for one revision.
func (client *Client) GetAgentRuntime(namespaceID, agentID, deploymentID string) (any, error) {
	return client.get(
		"namespaces",
		namespaceID,
		"agents",
		agentID,
		"deployments",
		deploymentID,
		"runtime",
	)
}

// GetAgentRuntimeLogs fetches one bounded, redacted page of container output.
func (client *Client) GetAgentRuntimeLogs(
	namespaceID, agentID, deploymentID string,
	query url.Values,
) (*RuntimeLogPage, error) {
	status, header, responseBody, err := client.executeQuery(
		http.MethodGet,
		[]string{"namespaces", namespaceID, "agents", agentID, "deployments", deploymentID, "runtime", "logs"},
		query,
		nil,
	)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, client.apiError(status, header, responseBody)
	}
	var envelope responseEnvelope
	if err := json.Unmarshal(responseBody, &envelope); err != nil || len(envelope.Data) == 0 {
		return nil, fmt.Errorf("OCC returned an invalid response (HTTP %d)", status)
	}
	var page RuntimeLogPage
	if err := json.Unmarshal(envelope.Data, &page); err != nil {
		return nil, fmt.Errorf("OCC returned an invalid response (HTTP %d)", status)
	}
	return &page, nil
}

// StopAgent stops an Agent while retaining its revision history and persistent state.
func (client *Client) StopAgent(namespaceID, agentID string) (any, error) {
	return client.send(
		http.MethodPost,
		[]string{"namespaces", namespaceID, "agents", agentID, "stop"},
		nil,
	)
}

// DeleteAgent begins asynchronous Agent deletion.
func (client *Client) DeleteAgent(namespaceID, agentID string) (any, error) {
	return client.send(
		http.MethodDelete,
		[]string{"namespaces", namespaceID, "agents", agentID},
		nil,
	)
}
