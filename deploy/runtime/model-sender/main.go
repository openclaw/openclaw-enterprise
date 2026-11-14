// The Dedicated OpenClaw worker uses this sender for its admitted Responses route.
// OpenShell owns request authorization and adds any credential after interception.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	responsesPath   = "/v1/responses"
	publicBearer    = "Bearer oce:request-authorized:model"
	maxRequestBytes = 1024 * 1024 // OCC online credential proxy request limit.
)

var (
	dnsName  = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$`)
	jsonType = regexp.MustCompile(`(?i)^application/json(?:;[ \t]*charset=utf-8)?$`)
)

func responsesURL(raw string) (string, error) {
	origin, err := url.Parse(raw)
	if err != nil || origin.Scheme != "https" || origin.User != nil ||
		(raw != "https://"+origin.Host && raw != "https://"+origin.Host+"/") {
		return "", errors.New("invalid HTTPS model origin")
	}
	host := origin.Hostname()
	if len(host) > 253 || !dnsName.MatchString(host) || net.ParseIP(host) != nil {
		return "", errors.New("invalid HTTPS model host")
	}
	if origin.Host != host {
		port, err := strconv.ParseUint(origin.Port(), 10, 16)
		if err != nil || port == 0 {
			return "", errors.New("invalid HTTPS model port")
		}
	}
	return "https://" + origin.Host + responsesPath, nil
}

type sender struct {
	listenerAddress string
	target          string
	transport       *http.Transport
}

func (s sender) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.RequestURI != responsesPath || r.Host != s.listenerAddress {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "expected POST", http.StatusMethodNotAllowed)
		return
	}
	auth := r.Header.Values("Authorization")
	if len(auth) != 1 || auth[0] != publicBearer {
		http.Error(w, "invalid model request marker", http.StatusUnauthorized)
		return
	}
	if !acceptedHeaders(r.Header) || len(r.Trailer) != 0 {
		http.Error(w, "unsupported model request headers", http.StatusBadRequest)
		return
	}
	types := r.Header.Values("Content-Type")
	if len(types) != 1 || !jsonType.MatchString(types[0]) {
		http.Error(w, "expected JSON", http.StatusUnsupportedMediaType)
		return
	}
	if r.ContentLength > maxRequestBytes {
		http.Error(w, "model request too large", http.StatusRequestEntityTooLarge)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		http.Error(w, "model request too large", http.StatusRequestEntityTooLarge)
		return
	case err != nil || len(body) == 0 || len(r.Trailer) != 0:
		http.Error(w, "invalid model request body", http.StatusBadRequest)
		return
	}

	// Buffering gives the supervisor fixed-length JSON and bounds it before
	// any dispatch. Omit GetBody so the transport cannot replay a sent POST.
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.target, io.NopCloser(bytes.NewReader(body)))
	if err != nil {
		http.Error(w, "invalid model request", http.StatusBadGateway)
		return
	}
	req.ContentLength = int64(len(body))
	req.Header.Set("Authorization", publicBearer)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "")
	// RoundTrip has no redirect handling and uses the original client context
	// for both the request and stream, including cancellation on disconnect.
	resp, err := s.transport.RoundTrip(req)
	if err != nil {
		http.Error(w, "model transport unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	encodings := resp.Header.Values("Content-Encoding")
	if resp.StatusCode < 200 || (resp.StatusCode >= 300 && resp.StatusCode < 400) ||
		(len(encodings) != 0 && (len(encodings) != 1 || !strings.EqualFold(encodings[0], "identity"))) {
		http.Error(w, "unsupported model response", http.StatusBadGateway)
		return
	}
	if contentType := resp.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(resp.StatusCode)
	streamResponse(w, resp.Body)
}

func acceptedHeaders(headers http.Header) bool {
	for name, values := range headers {
		switch name {
		case "Authorization", "Content-Type", "Accept", "Accept-Encoding", "Accept-Language",
			"User-Agent", "Traceparent", "Sec-Fetch-Mode", "Content-Length", "Session_id", "X-Client-Request-Id":
		case "Connection":
			if len(values) != 1 || !(strings.EqualFold(values[0], "keep-alive") || strings.EqualFold(values[0], "close")) {
				return false
			}
		default:
			// The native SDK may send Stainless telemetry. It stays on loopback.
			if !strings.HasPrefix(name, "X-Stainless-") {
				return false
			}
		}
	}
	return true
}

func streamResponse(w http.ResponseWriter, body io.Reader) {
	controller := http.NewResponseController(w)
	if err := controller.Flush(); err != nil {
		return
	}
	buffer := make([]byte, 32*1024)
	for {
		n, err := body.Read(buffer)
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return
			}
			if flushErr := controller.Flush(); flushErr != nil {
				return
			}
		}
		if err == io.EOF {
			return
		}
		if err != nil {
			// Close a truncated response without sending a clean stream terminator.
			panic(http.ErrAbortHandler)
		}
	}
}

func run(args []string, ready io.Writer) error {
	if len(args) != 2 || args[0] != "--origin" {
		return errors.New("usage: openclaw-model-sender --origin <HTTPS origin>")
	}
	target, err := responsesURL(args[1])
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return errors.New("could not bind model sender")
	}
	defer listener.Close()

	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		// OpenShell mediates the direct connection. The standard TLS verifier
		// reads the mounted root bundle via SSL_CERT_FILE.
		DialContext:            dialer.DialContext,
		Protocols:              protocols,
		DisableCompression:     true,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  2 * time.Minute,
		IdleConnTimeout:        30 * time.Second,
		MaxResponseHeaderBytes: 64 * 1024,
	}
	defer transport.CloseIdleConnections()
	server := &http.Server{
		Handler:        sender{listener.Addr().String(), target, transport},
		ReadTimeout:    30 * time.Second,
		IdleTimeout:    30 * time.Second,
		MaxHeaderBytes: 16 * 1024,
		ErrorLog:       log.New(io.Discard, "", 0),
	}
	if err := json.NewEncoder(ready).Encode(struct {
		Port int `json:"port"`
	}{listener.Addr().(*net.TCPAddr).Port}); err != nil {
		return errors.New("could not report model sender readiness")
	}
	if err := server.Serve(listener); err != nil {
		return errors.New("model sender listener stopped")
	}
	return nil
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
