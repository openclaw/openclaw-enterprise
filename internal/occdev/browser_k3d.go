package occdev

import "fmt"

// Each owned cluster has a separate cookie scope and native Agent host suffix.
func developmentBrowserHosts(cluster string) (console, agentDomain, cookieDomain string) {
	cookieDomain = cluster + ".oce.localhost"
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
