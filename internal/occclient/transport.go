package occclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
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
	serviceKey serviceKey
	caBundle   string
	http       *http.Client
}

type serviceKey struct {
	key       string
	namespace string
	// file is the service-key file path, named when OCC rejects the key.
	file string
}

type serviceKeyEnvelope struct {
	Data struct {
		Key         string         `json:"key"`
		NamespaceID jsontext.Value `json:"namespaceId"`
	} `json:"data"`
}

type responseEnvelope struct {
	Data jsontext.Value `json:"data"`
	Meta jsontext.Value `json:"meta"`
}

// ConfigurationErrorDetail identifies a rejected configuration field without its value.
type ConfigurationErrorDetail struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

// APIError is an OCC error response. RetryAfter is set when OCC sent Retry-After.
// Location is the absolute redirect target of a 3xx response, without userinfo,
// query, or fragment; occ never follows redirects, so the service key is only
// ever sent to the configured origin.
type APIError struct {
	Details    []ConfigurationErrorDetail
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
	Location   string
	// ServiceKeyNamespace is local metadata recorded with the key for this request.
	// It is not an assertion by the server or a source of authorization.
	ServiceKeyNamespace string
	// serviceKeyFile is the local key file path, named when OCC answers 401.
	serviceKeyFile string
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
	if err.Status == http.StatusUnauthorized && err.serviceKeyFile != "" {
		// occ always sends the key file's key, so OCC's cookie and header advice
		// does not apply: the key itself was refused (finding D745).
		return fmt.Sprintf(
			"OCC rejected the service key in %s: it is invalid, expired or revoked. Ask an Installation administrator for a new key.",
			err.serviceKeyFile,
		)
	}
	message := fmt.Sprintf("OCC operation failed (HTTP %d)", err.Status)
	if err.Code != "" {
		message = fmt.Sprintf("%s: %s: %s", message, err.Code, err.Message)
	}
	if err.RetryAfter > 0 {
		// OCC's rate-limit messages say to wait for Retry-After; name the delay.
		message = fmt.Sprintf("%s. Retry after %ds.", strings.TrimSuffix(message, "."), int(math.Ceil(err.RetryAfter.Seconds())))
	}
	// Render only bounded public diagnostic fields. Reject all Unicode control characters,
	// including DEL and C1 controls that JSON encoding does not escape.
	for index, detail := range err.Details {
		if index == 32 {
			break
		}
		if strings.ContainsFunc(detail.Path, unicode.IsControl) || strings.ContainsFunc(detail.Message, unicode.IsControl) || strings.ContainsFunc(detail.Code, unicode.IsControl) {
			continue
		}
		if utf8.RuneCountInString(detail.Path) > 512 || utf8.RuneCountInString(detail.Message) > 512 || len(detail.Code) > 64 {
			continue
		}
		encoded, encodeErr := json.Marshal(detail)
		if encodeErr == nil {
			message += "\n  " + string(encoded)
		}
	}

	return message
}

type errorEnvelope struct {
	Error struct {
		Code    string                     `json:"code"`
		Message string                     `json:"message"`
		Details []ConfigurationErrorDetail `json:"details,omitempty"`
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
		caBundle:   config.CABundle,
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
	return decodeResponseData(status, responseBody)
}

func decodeResponseData(status int, responseBody []byte) (any, error) {
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
	request.Header.Set("x-api-key", client.serviceKey.key)
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}

	response, err := client.http.Do(request)
	if err != nil {
		return 0, nil, nil, client.transportError(err)
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

// transportError explains a request that got no HTTP answer. TLS verification
// failures are matched on their types and get a plain cause and next step
// instead of the raw x509 text; everything else keeps the cause.
func (client *Client) transportError(err error) error {
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		if client.caBundle != "" {
			return fmt.Errorf("the OCC endpoint's certificate is not trusted by the CA bundle %s. Set OCC_CA_BUNDLE (or --ca-bundle) to your Installation's CA bundle.", client.caBundle)
		}
		return errors.New("the OCC endpoint's certificate is not trusted. Set OCC_CA_BUNDLE (or --ca-bundle) to your Installation's CA bundle.")
	}
	var hostname x509.HostnameError
	if errors.As(err, &hostname) {
		return fmt.Errorf("OCC operation failed: the OCC endpoint's certificate is not valid for %s; check OCC_URL: %w", client.baseURL.Hostname(), err)
	}
	var verification *tls.CertificateVerificationError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &verification) || errors.As(err, &invalid) {
		return fmt.Errorf("OCC operation failed: the OCC endpoint's certificate could not be verified: %w", err)
	}
	return fmt.Errorf("OCC operation failed: %w", err)
}

func (client *Client) apiError(status int, header http.Header, body []byte) error {
	result := &APIError{Status: status, ServiceKeyNamespace: client.serviceKey.namespace, serviceKeyFile: client.serviceKey.file}
	var envelope errorEnvelope
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Code != "" {
		result.Code = envelope.Error.Code
		result.Message = envelope.Error.Message
		result.Details = envelope.Error.Details
	}
	if seconds, err := strconv.ParseUint(header.Get("retry-after"), 10, 64); err == nil && seconds > 0 && seconds <= 3600 {
		result.RetryAfter = time.Duration(seconds) * time.Second
	} else if until, err := http.ParseTime(header.Get("retry-after")); err == nil {
		if remaining := time.Until(until); remaining > 0 && remaining <= time.Hour {
			result.RetryAfter = (remaining + time.Second - 1).Truncate(time.Second)
		}
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
			if target.Scheme != client.baseURL.Scheme || !strings.EqualFold(target.Host, client.baseURL.Host) {
				result.redirectOrigin = target.Scheme + "://" + target.Host
			}
		}
	}
	return result
}

// serviceKeyFileAdvice ends every key-file refusal: the file must be the
// complete JSON answer of "occ service-key create" (or of bootstrap).
const serviceKeyFileAdvice = "Use the complete JSON file from \"occ service-key create\"."

func readServiceKey(path string) (serviceKey, error) {
	contents, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return serviceKey{}, fmt.Errorf("service-key file %s does not exist. Set OCC_SERVICE_KEY_FILE (or --service-key-file) to the key file you were issued.", path)
	}
	if err != nil {
		cause := err
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			cause = pathErr.Err
		}
		return serviceKey{}, fmt.Errorf("failed to read service-key file %s: %w", path, cause)
	}
	if !jsontext.Value(contents).IsValid() {
		// The parser's own text (offsets, expected tokens) does not help here.
		return serviceKey{}, fmt.Errorf("service-key file %s is not JSON. %s", path, serviceKeyFileAdvice)
	}
	var envelope serviceKeyEnvelope
	if err := json.Unmarshal(contents, &envelope); err != nil {
		return serviceKey{}, fmt.Errorf("service-key file %s has no usable data.key (it must be a JSON string). %s", path, serviceKeyFileAdvice)
	}
	key := envelope.Data.Key
	switch {
	case key == "":
		return serviceKey{}, fmt.Errorf("service-key file %s has no data.key. %s", path, serviceKeyFileAdvice)
	case strings.ContainsAny(key, "\r\n"):
		return serviceKey{}, fmt.Errorf("service-key file %s has a data.key split over lines. %s", path, serviceKeyFileAdvice)
	case strings.TrimSpace(key) == "":
		return serviceKey{}, fmt.Errorf("service-key file %s has an empty data.key. %s", path, serviceKeyFileAdvice)
	}
	// Optional display metadata must not make an otherwise usable key unreadable.
	var namespace string
	_ = json.Unmarshal(envelope.Data.NamespaceID, &namespace)
	return serviceKey{key: key, namespace: namespace, file: path}, nil
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
