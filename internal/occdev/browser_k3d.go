package occdev

// Each owned cluster has a separate cookie scope and native Agent host suffix.
func developmentBrowserHosts(cluster string) (console, agentDomain, cookieDomain string) {
	cookieDomain = cluster + ".oce.localhost"
	return "console." + cookieDomain, "agents." + cookieDomain, cookieDomain
}
