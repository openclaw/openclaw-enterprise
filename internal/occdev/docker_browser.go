package occdev

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DockerBrowserEnvironment prepares the existing loopback TLS proxy for a checkout.
// Its private certificates survive stop/start so browser trust remains stable.
func DockerBrowserEnvironment(repository string, create bool) (map[string]string, error) {
	port := os.Getenv("OCC_DEVELOPMENT_BROWSER_PORT")
	if port == "" {
		port = "8443"
	}
	value, err := strconv.Atoi(port)
	if err != nil || value < 1 || value > 65535 || strconv.Itoa(value) != port {
		return nil, fmt.Errorf("OCC_DEVELOPMENT_BROWSER_PORT must be a TCP port")
	}
	root, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(root))
	name := fmt.Sprintf("occ-docker-%x", digest[:8])
	temporary, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return nil, err
	}
	directory := filepath.Join(temporary, name)
	console, agents, _ := developmentBrowserHosts(name)
	if create {
		err := os.Mkdir(directory, 0700)
		if err == nil {
			if err := writeDevelopmentTLS(directory, "browser", "OCC development browser CA", []string{console, "*." + agents}); err != nil {
				return nil, err
			}
		} else if !os.IsExist(err) {
			return nil, err
		}
		if err := privateOwned(directory, true); err != nil {
			return nil, err
		}
		for _, name := range []string{"browser-ca.crt", "browser-tls.crt", "browser-tls.key"} {
			if err := privateOwned(filepath.Join(directory, name), false); err != nil {
				return nil, err
			}
		}
	}
	return map[string]string{
		"OCC_DEVELOPMENT_BROWSER_ORIGIN":            developmentBrowserOrigin(console, value),
		"OCC_DEVELOPMENT_AGENT_NATIVE_ADMIN_DOMAIN": agents,
		"OCC_DEVELOPMENT_BROWSER_PORT":              port,
		"OCC_DEVELOPMENT_BROWSER_TLS_CERT":          filepath.Join(directory, "browser-tls.crt"),
		"OCC_DEVELOPMENT_BROWSER_TLS_KEY":           filepath.Join(directory, "browser-tls.key"),
		"OCC_AGENT_NATIVE_ADMIN_ENABLED":            "false",
	}, nil
}

func dockerBrowserComposeArgs(args []string, repository, selectedFiles, separator string) []string {
	selected := false
	for _, arg := range args {
		if arg == "-f" || strings.HasPrefix(arg, "-f") || arg == "--file" || strings.HasPrefix(arg, "--file=") {
			selected = true
		}
	}
	if !selected {
		if selectedFiles == "" {
			args = append(args, "-f", filepath.Join(repository, "compose.yaml"))
		} else {
			if separator == "" {
				separator = ":"
			}
			for _, file := range strings.Split(selectedFiles, separator) {
				args = append(args, "-f", file)
			}
		}
	}
	return append(args, "-f", filepath.Join(repository, "compose.native-admin.yaml"))
}
