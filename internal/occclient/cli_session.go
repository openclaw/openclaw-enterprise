package occclient

import (
	"encoding/json/v2"
	"fmt"
	"net/http"
)

// CLISignInStart is the device authorization that occ login starts (RFC-0019).
type CLISignInStart struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURI string `json:"verificationUri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expiresIn"`
}

// CLISessionUser is the account a CLI session acts for.
type CLISessionUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// CLISession describes a CLI session without its token.
type CLISession struct {
	ID          string          `json:"id"`
	ClientLabel string          `json:"clientLabel"`
	CreatedAt   string          `json:"createdAt"`
	ExpiresAt   string          `json:"expiresAt"`
	NamespaceID string          `json:"namespaceId,omitempty"`
	User        *CLISessionUser `json:"user,omitempty"`
}

// CLISignInResult is the approved exchange: the token is returned only once.
type CLISignInResult struct {
	Token   string         `json:"token"`
	Session CLISession     `json:"session"`
	User    CLISessionUser `json:"user"`
}

// StartCLISignIn starts a device authorization. It sends no credential.
func (client *Client) StartCLISignIn(clientLabel, namespaceID string) (*CLISignInStart, error) {
	body := map[string]any{"clientLabel": clientLabel}
	if namespaceID != "" {
		body["namespaceId"] = namespaceID
	}
	var started CLISignInStart
	if err := client.sendInto(
		http.MethodPost,
		[]string{"api", "auth", "cli", "device-authorizations"},
		body,
		&started,
	); err != nil {
		return nil, err
	}
	if started.DeviceCode == "" || started.UserCode == "" || started.Interval <= 0 || started.ExpiresIn <= 0 {
		return nil, fmt.Errorf("OCC returned an invalid sign-in request")
	}
	return &started, nil
}

// PollCLISignIn exchanges an approved device code for a CLI session. Until approval
// it returns an *APIError whose Code is AUTHORIZATION_PENDING or SLOW_DOWN.
func (client *Client) PollCLISignIn(deviceCode string) (*CLISignInResult, error) {
	var result CLISignInResult
	if err := client.sendInto(
		http.MethodPost,
		[]string{"api", "auth", "cli", "token"},
		map[string]any{"deviceCode": deviceCode},
		&result,
	); err != nil {
		return nil, err
	}
	if result.Token == "" || result.Session.ID == "" || result.Session.ExpiresAt == "" {
		return nil, fmt.Errorf("OCC returned an invalid CLI session")
	}
	return &result, nil
}

// CurrentCLISession describes the CLI session this client sends.
func (client *Client) CurrentCLISession() (*CLISession, error) {
	var session CLISession
	if err := client.sendInto(
		http.MethodGet,
		[]string{"api", "auth", "cli-sessions", "current"},
		nil,
		&session,
	); err != nil {
		return nil, err
	}
	return &session, nil
}

// LogoutCLISession ends the CLI session this client sends.
func (client *Client) LogoutCLISession() error {
	var revoked struct {
		Revoked bool `json:"revoked"`
	}
	return client.sendInto(
		http.MethodDelete,
		[]string{"api", "auth", "cli-sessions", "current"},
		nil,
		&revoked,
	)
}

func (client *Client) sendInto(method string, segments []string, body any, out any) error {
	status, header, responseBody, err := client.execute(method, segments, body)
	if err != nil {
		return err
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return client.apiError(status, header, responseBody)
	}
	var envelope responseEnvelope
	if err := json.Unmarshal(responseBody, &envelope); err != nil || len(envelope.Data) == 0 {
		return fmt.Errorf("OCC returned an invalid response (HTTP %d)", status)
	}
	if err := json.Unmarshal(envelope.Data, out); err != nil {
		return fmt.Errorf("OCC returned an invalid response (HTTP %d)", status)
	}
	return nil
}
