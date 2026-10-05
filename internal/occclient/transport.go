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
// Location is the absolute redirect target of a 3xx response, without userinfo,
// query, or fragment; occ never follows redirects, so the service key is only
// ever sent to the configured origin.
type APIError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
	Location   string
	// redirectOrigin is the Location's scheme://host when it differs from OCC_URL.
	redirectOrigin string
}

func (err *APIError) Error() string {
	if err.Location != "" {
		if err.redirectOrigin == "" {
			return fmt.Sprintf(
				"OCC operation failed (HTTP %d): the server redirected to %s; occ does not follow redirects, and OCC_URL must be the origin that serves the OCC API directly, without a path prefix",
				err.Status, err.Location,
			)
		}
		return fmt.Sprintf(
			"OCC operation failed (HTTP %d): the server redirected to %s; occ does not follow redirects, so set OCC_URL (or --url) to %s if that is the OCC endpoint",
			err.Status, err.Location, err.redirectOrigin,
		)
	}
	message := fmt.Sprintf("OCC operation failed (HTTP %d)", err.Status)
	if err.Code != "" {
		message = fmt.Sprintf("%s: %s: %s", message, err.Code, err.Message)
	}
	if err.RetryAfter > 0 {
		// OCC's rate-limit messages say to wait for Retry-After; name the delay.
		message = fmt.Sprintf("%s. Retry after %ds.", strings.TrimSuffix(message, "."), int(err.RetryAfter/time.Second))
	}
	return message
}

type errorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// WithContext returns a client sharing transport and credentials whose requests
// use ctx. The original client remains unchanged.
func (client *Client) WithContext(ctx context.Context) *Client {
	clone := *client
	clone.ctx = ctx
	return &clone
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

func (client *Client) get(segments ...string) (any, error) {
	return client.send(http.MethodGet, segments, nil)
}

func (client *Client) send(method string, segments []string, body any) (any, error) {
	status, header, responseBody, err := client.execute(method, segments, body)
	if err != nil {
		return nil, err
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return nil, client.apiError(status, header, responseBody)
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
	status, header, responseBody, err := client.execute(method, segments, nil)
	if err != nil {
		return err
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return client.apiError(status, header, responseBody)
	}
	if status != http.StatusNoContent || len(responseBody) != 0 {
		return fmt.Errorf("OCC returned an invalid empty response (HTTP %d)", status)
	}
	return nil
}

func (client *Client) execute(method string, segments []string, body any) (int, http.Header, []byte, error) {
	return client.executeQuery(method, segments, nil, body)
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
	header := response.Header
	if location, err := response.Location(); err == nil {
		// Resolve a relative Location against the request so the error names an absolute URL.
		header = header.Clone()
		header.Set("location", location.String())
	}
	return response.StatusCode, header, responseBody, nil
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

func (client *Client) apiError(status int, header http.Header, body []byte) error {
	result := &APIError{Status: status}
	var envelope errorEnvelope
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Code != "" {
		result.Code = envelope.Error.Code
		result.Message = envelope.Error.Message
	}
	if seconds, err := strconv.Atoi(header.Get("retry-after")); err == nil && seconds > 0 && seconds <= 3600 {
		result.RetryAfter = time.Duration(seconds) * time.Second
	}
	if status >= http.StatusMultipleChoices && status < http.StatusBadRequest {
		// Drop userinfo, query, and fragment: a sign-in redirect can carry tokens there.
		if target, err := url.Parse(header.Get("location")); err == nil && target.Scheme != "" && target.Host != "" {
			target.User = nil
			target.RawQuery = ""
			target.ForceQuery = false
			target.Fragment = ""
			target.RawFragment = ""
			result.Location = target.String()
			if target.Scheme != client.baseURL.Scheme || target.Host != client.baseURL.Host {
				result.redirectOrigin = target.Scheme + "://" + target.Host
			}
		}
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
