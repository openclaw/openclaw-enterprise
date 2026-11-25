package occcli

import (
	"bytes"
	"encoding/json/v2"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
)

var githubRepository = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]{0,99}$`)
var githubFineGrainedToken = regexp.MustCompile(`^github_pat_[A-Za-z0-9_]+$`)

func (app *application) createGitHubSource(repo string, input io.Reader) error {
	if !githubRepository.MatchString(repo) || strings.HasSuffix(repo, ".git") || strings.Contains(repo, "..") || strings.Contains(repo, "github_pat_") {
		return errors.New("--github-repo requires one lowercase owner/name without a .git suffix or access level")
	}
	endpoint, err := url.Parse(app.url)
	if err != nil || strings.Contains(app.url, "github_pat_") ||
		(endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && net.ParseIP(endpoint.Hostname()).IsLoopback())) {
		return errors.New("set OCC_URL or --url to an HTTPS origin or HTTP on a loopback IP")
	}
	namespace, client, err := app.namespaceClient()
	if err != nil {
		return err
	}
	if file, ok := input.(*os.File); ok {
		info, err := file.Stat()
		if err != nil || (!info.Mode().IsRegular() && info.Mode()&os.ModeNamedPipe == 0) {
			return errors.New("redirect a private token file or pipe the token to stdin")
		}
		if runtime.GOOS != "windows" && info.Mode().IsRegular() && info.Mode().Perm()&0077 != 0 {
			return errors.New("the token file must be readable only by its owner")
		}
	}

	const maxToken = 16384
	// Allow one CRLF and read one extra byte to detect truncation.
	token, err := io.ReadAll(io.LimitReader(input, maxToken+3))
	if err != nil {
		return errors.New("could not read the GitHub token from stdin")
	}
	if bytes.HasSuffix(token, []byte("\n")) {
		token = bytes.TrimSuffix(token[:len(token)-1], []byte("\r"))
	}
	if len(token) > maxToken || !githubFineGrainedToken.Match(token) {
		return errors.New("stdin must contain a single GitHub fine-grained personal access token of at most 16384 bytes")
	}
	body, err := json.Marshal(map[string]any{
		"name":   "GitHub " + repo,
		"type":   "static",
		"config": map[string]string{"provider_preset": "github", "repositories": repo + ":read"},
		"secret": map[string]string{"token": string(token)},
	})
	if err != nil {
		return errors.New("could not encode the GitHub Source")
	}
	source, err := client.CreateCredentialSource(namespace, body)
	// Refuse a server or proxy response that echoes the submitted credential.
	if err != nil {
		if strings.Contains(err.Error(), "github_pat_") {
			return errors.New("unsafe OCC error response. Check credential-source list before retrying")
		}
		return err
	}
	metadata, err := json.Marshal(source)
	if err != nil || bytes.Contains(metadata, token) {
		return errors.New("unsafe OCC response. Check credential-source list before retrying")
	}
	return app.printCredentialSource(source, false)
}
