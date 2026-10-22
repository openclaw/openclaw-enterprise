package occdev

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"time"
)

var developmentBrowserDomainPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// developmentBrowserDomain validates OCC_DEVELOPMENT_BROWSER_DOMAIN. OAuth
// providers such as Google refuse redirect URIs under .localhost, so a
// connection callback needs a registrable domain that resolves to loopback. The
// Compose controller runs in development mode, which admits only .localhost
// browser origins, so only the Kubernetes control plane accepts another domain.
func developmentBrowserDomain(env map[string]string) (string, error) {
	value := env["OCC_DEVELOPMENT_BROWSER_DOMAIN"]
	if value == "" {
		return "", nil
	}
	if len(value) > 160 || !developmentBrowserDomainPattern.MatchString(value) {
		return "", fmt.Errorf("OCC_DEVELOPMENT_BROWSER_DOMAIN must be a lowercase DNS domain such as localtest.me")
	}
	if env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "kubernetes" || env["OCC_DEVELOPMENT_CONTROL_PLANE"] != "kubernetes" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_BROWSER_DOMAIN requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes and OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes: the Compose controller admits only .localhost browser origins")
	}
	if env["OCC_DEVELOPMENT_SIGN_IN"] != "" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_BROWSER_DOMAIN cannot be combined with OCC_DEVELOPMENT_SIGN_IN")
	}
	return value, nil
}

// CheckDevelopmentBrowserDomain refuses OCC_DEVELOPMENT_BROWSER_DOMAIN for the
// Docker Compute profile, whose startup script does not read it.
func CheckDevelopmentBrowserDomain(getenv func(string) string) error {
	env := map[string]string{}
	for _, key := range []string{"OCC_DEVELOPMENT_BROWSER_DOMAIN", "OCC_DEVELOPMENT_COMPUTE_DRIVER", "OCC_DEVELOPMENT_CONTROL_PLANE", "OCC_DEVELOPMENT_SIGN_IN"} {
		env[key] = getenv(key)
	}
	_, err := developmentBrowserDomain(env)
	return err
}

// checkDevelopmentBrowserDomain requires the console and native admin hosts to
// resolve only to loopback before startup claims any resources, so the browser
// never sends development cookies or OAuth callbacks off the host.
func checkDevelopmentBrowserDomain(ctx context.Context, state *developmentState) error {
	console, agentDomain, _ := state.browserHosts()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for _, host := range []string{console, "agent." + agentDomain} {
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return fmt.Errorf("OCC_DEVELOPMENT_BROWSER_DOMAIN: resolve %s: %w", host, err)
		}
		for _, address := range addresses {
			if !address.IP.IsLoopback() {
				return fmt.Errorf("OCC_DEVELOPMENT_BROWSER_DOMAIN: %s resolves to %s; every address must be loopback", host, address.IP)
			}
		}
	}
	return nil
}

// Each owned cluster has a separate cookie scope and native Agent host suffix.
func developmentBrowserHosts(cluster string) (console, agentDomain, cookieDomain string) {
	cookieDomain = cluster + ".oce.localhost"
	return "console." + cookieDomain, "agents." + cookieDomain, cookieDomain
}

// browserHosts applies the recorded browser domain, which replaces oce.localhost
// in the Kubernetes-only profile when OCC_DEVELOPMENT_BROWSER_DOMAIN is set.
func (s *developmentState) browserHosts() (console, agentDomain, cookieDomain string) {
	if s.BrowserDomain == "" {
		return developmentBrowserHosts(s.Cluster)
	}
	cookieDomain = s.Cluster + "." + s.BrowserDomain
	return "console." + cookieDomain, "agents." + cookieDomain, cookieDomain
}

// developmentBrowserOrigin is the console's HTTPS origin in canonical form:
// WHATWG URL and the controller's development origin check drop the default
// port, so 443 must not appear in the recorded origin.
func developmentBrowserOrigin(consoleHost string, port int) string {
	if port == 443 {
		return "https://" + consoleHost
	}
	return fmt.Sprintf("https://%s:%d", consoleHost, port)
}
