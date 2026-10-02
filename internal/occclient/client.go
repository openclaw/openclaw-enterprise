package occclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config contains connection, authentication, and TLS settings for an OCC client.
type Config struct {
	URL            string
	ServiceKeyFile string
	CABundle       string
	Timeout        time.Duration
	// Context cancels in-flight requests, for example on Ctrl-C. Nil means no cancellation.
	Context context.Context
}

// Client exposes supported OpenClaw Control Plane resource operations.
type Client struct {
	ctx        context.Context
	baseURL    *url.URL
	serviceKey string
	http       *http.Client
}

type serviceKeyEnvelope struct {
	Data struct {
		Key string `json:"key"`
	} `json:"data"`
}

type responseEnvelope struct {
	Data jsontext.Value `json:"data"`
	Meta jsontext.Value `json:"meta"`
}

// APIError is an OCC error response. RetryAfter is set when OCC sent Retry-After.
type APIError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (err *APIError) Error() string {
	if err.Code == "" {
		return fmt.Sprintf("OCC operation failed (HTTP %d)", err.Status)
	}
	return fmt.Sprintf("OCC operation failed (HTTP %d): %s: %s", err.Status, err.Code, err.Message)
}

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

type errorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// New validates the client configuration and prepares authenticated transport.
func New(config Config) (*Client, error) {
	baseURL, err := parseOrigin(config.URL)
	if err != nil {
		return nil, err
	}
	if config.Timeout <= 0 {
		return nil, fmt.Errorf("OCC timeout must be positive")
	}

	serviceKey, err := readServiceKey(config.ServiceKeyFile)
	if err != nil {
		return nil, err
	}
	transport, err := httpTransport(config.CABundle)
	if err != nil {
		return nil, err
	}

	ctx := config.Context
	if ctx == nil {
		ctx = context.Background()
	}

	return &Client{
		ctx:        ctx,
		baseURL:    baseURL,
		serviceKey: serviceKey,
		http: &http.Client{
			Transport: transport,
			Timeout:   config.Timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
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
		return nil, apiErrorWithHeader(status, header, responseBody)
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

func (client *Client) get(segments ...string) (any, error) {
	return client.send(http.MethodGet, segments, nil)
}

func (client *Client) send(method string, segments []string, body any) (any, error) {
	status, responseBody, err := client.execute(method, segments, body)
	if err != nil {
		return nil, err
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return nil, apiError(status, responseBody)
	}

	var envelope responseEnvelope
	if err := json.Unmarshal(responseBody, &envelope); err != nil || len(envelope.Data) == 0 || len(envelope.Meta) == 0 {
		return nil, fmt.Errorf("OCC returned an invalid response (HTTP %d)", status)
	}
	var data any
	if err := json.Unmarshal(envelope.Data, &data); err != nil {
		return nil, fmt.Errorf("OCC returned an invalid response (HTTP %d)", status)
	}
	return data, nil
}

func (client *Client) sendEmpty(method string, segments []string) error {
	status, responseBody, err := client.execute(method, segments, nil)
	if err != nil {
		return err
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return apiError(status, responseBody)
	}
	if status != http.StatusNoContent || len(responseBody) != 0 {
		return fmt.Errorf("OCC returned an invalid empty response (HTTP %d)", status)
	}
	return nil
}

func (client *Client) execute(method string, segments []string, body any) (int, []byte, error) {
	status, _, responseBody, err := client.executeQuery(method, segments, nil, body)
	return status, responseBody, err
}

func (client *Client) executeQuery(
	method string,
	segments []string,
	query url.Values,
	body any,
) (int, http.Header, []byte, error) {
	resourceURL, err := resourceURL(client.baseURL, segments)
	if err != nil {
		return 0, nil, nil, err
	}
	if len(query) > 0 {
		resourceURL.RawQuery = query.Encode()
	}

	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, nil, fmt.Errorf("failed to encode OCC request: %w", err)
		}
		requestBody = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(client.ctx, method, resourceURL.String(), requestBody)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("failed to create OCC request: %w", err)
	}
	request.Header.Set("x-api-key", client.serviceKey)
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}

	response, err := client.http.Do(request)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("OCC operation failed: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("failed to read the OCC response: %w", err)
	}
	return response.StatusCode, response.Header, responseBody, nil
}

func parseOrigin(value string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("OCC URL must use http or https")
	}
	if parsed.Opaque != "" || parsed.User != nil || parsed.Hostname() == "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, fmt.Errorf("OCC URL must be an origin without credentials, a path, a query, or a fragment")
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return parsed, nil
}

func resourceURL(baseURL *url.URL, segments []string) (*url.URL, error) {
	path := make([]string, len(segments))
	escapedPath := make([]string, len(segments))
	for index, segment := range segments {
		if segment == "" {
			return nil, fmt.Errorf("OCC resource identifier cannot be empty")
		}
		path[index] = segment
		escapedPath[index] = url.PathEscape(segment)
	}
	resource := baseURL.Clone()
	resource.Path = "/" + strings.Join(path, "/")
	resource.RawPath = "/" + strings.Join(escapedPath, "/")
	return resource, nil
}

func apiError(status int, body []byte) error {
	return apiErrorWithHeader(status, nil, body)
}

func apiErrorWithHeader(status int, header http.Header, body []byte) error {
	result := &APIError{Status: status}
	var envelope errorEnvelope
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Code != "" {
		result.Code = envelope.Error.Code
		result.Message = envelope.Error.Message
	}
	if seconds, err := strconv.Atoi(header.Get("retry-after")); err == nil && seconds > 0 && seconds <= 3600 {
		result.RetryAfter = time.Duration(seconds) * time.Second
	}
	return result
}

func readServiceKey(path string) (string, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("failed to read service-key file %s: %w", path, err)
	}
	var envelope serviceKeyEnvelope
	if err := json.Unmarshal(contents, &envelope); err != nil {
		return "", fmt.Errorf("invalid service-key file %s: %w", path, err)
	}
	key := envelope.Data.Key
	if strings.TrimSpace(key) == "" || strings.ContainsAny(key, "\r\n") {
		return "", fmt.Errorf("invalid service-key file %s", path)
	}
	return key, nil
}

func httpTransport(caBundle string) (*http.Transport, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if caBundle == "" {
		return transport, nil
	}

	pem, err := os.ReadFile(caBundle)
	if err != nil {
		return nil, fmt.Errorf("failed to read CA bundle %s: %w", caBundle, err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		return nil, fmt.Errorf("failed to load system CA certificates: %w", err)
	}
	if !roots.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("CA bundle %s contains no certificates", caBundle)
	}
	tlsConfig := &tls.Config{RootCAs: roots}
	if transport.TLSClientConfig != nil {
		tlsConfig = transport.TLSClientConfig.Clone()
		tlsConfig.RootCAs = roots
	}
	transport.TLSClientConfig = tlsConfig
	return transport, nil
}
