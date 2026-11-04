package occdev

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// routingManifestRetry bounds the retries of a routing controller manifest
// download from GitHub releases.
type routingManifestRetry struct {
	attempts       int
	firstDelay     time.Duration
	maxDelay       time.Duration
	budget         time.Duration
	attemptTimeout time.Duration
}

// The same rule as scripts/ci/routing.mjs (fetchPinnedBytes) and
// scripts/ci/download-pinned.sh: eight attempts, backoff doubling from 2 s to a
// 20 s cap, and no retry starts more than 120 s after the first attempt.
var developmentRoutingManifestRetry = routingManifestRetry{
	attempts:       8,
	firstDelay:     2 * time.Second,
	maxDelay:       20 * time.Second,
	budget:         120 * time.Second,
	attemptTimeout: 60 * time.Second,
}

const developmentRoutingManifestLimit = 32 * 1024 * 1024

// downloadDevelopmentRoutingManifest fetches a pinned manifest and verifies its
// checksum. Network failures and HTTP 408, 429 and 5xx are retried; any other
// status, a refused certificate, an oversized body and a checksum mismatch fail
// at once.
func downloadDevelopmentRoutingManifest(
	ctx context.Context,
	log io.Writer,
	name, url, expected string,
	policy routingManifestRetry,
) ([]byte, error) {
	client := &http.Client{}
	started := time.Now()
	delay := min(policy.firstDelay, policy.maxDelay)
	for attempt := 1; ; attempt++ {
		data, transient, err := fetchDevelopmentRoutingManifest(ctx, client, url, policy.attemptTimeout)
		if err == nil {
			digest := sha256.Sum256(data)
			if hex.EncodeToString(digest[:]) != expected {
				return nil, fmt.Errorf("routing controller manifest checksum does not match the pinned version")
			}
			return data, nil
		}
		if !transient || attempt >= policy.attempts || time.Since(started)+delay > policy.budget {
			return nil, fmt.Errorf("%w (after %d attempt(s))", err, attempt)
		}
		fmt.Fprintf(log, "%s: %v; retrying in %s (attempt %d/%d)\n", name, err, delay, attempt+1, policy.attempts)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("download routing controller manifest: %w (after %d attempt(s), last error: %v)", context.Cause(ctx), attempt, err)
		case <-timer.C:
		}
		delay = min(delay*2, policy.maxDelay)
	}
}

func fetchDevelopmentRoutingManifest(
	ctx context.Context,
	client *http.Client,
	url string,
	timeout time.Duration,
) (data []byte, transient bool, err error) {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, transientRoutingManifestError(ctx, err), fmt.Errorf("download routing controller manifest: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		status := response.StatusCode
		transient := status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500 && status <= 599
		return nil, transient, fmt.Errorf("download routing controller manifest: HTTP %d", status)
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, developmentRoutingManifestLimit+1))
	if err != nil {
		return nil, transientRoutingManifestError(ctx, err), fmt.Errorf("read routing controller manifest: %w", err)
	}
	if len(data) > developmentRoutingManifestLimit {
		return nil, false, fmt.Errorf("routing controller manifest exceeds its size limit")
	}
	return data, false, nil
}

// Any failure of one attempt may pass on the next: its own timeout, a DNS
// failure, a refused, reset or aborted connection, an HTTP/2 stream reset or
// GOAWAY, a transfer cut short. So everything is retried except the caller's
// cancellation or deadline and a certificate the client refuses, which another
// attempt would only repeat. The attempt and time budget bound the rest.
func transientRoutingManifestError(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	var verification *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	return !errors.As(err, &verification) &&
		!errors.As(err, &unknownAuthority) &&
		!errors.As(err, &hostname) &&
		!errors.As(err, &invalid)
}
