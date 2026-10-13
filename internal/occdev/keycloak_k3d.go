package occdev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// OCC_DEVELOPMENT_SIGN_IN=keycloak runs a persistent Keycloak beside the
// routing-enabled Kubernetes-only profile (RFC-0019). This file owns the
// Keycloak workload, its name, TLS and host publication, and the second Helm
// pass that signs the development administrator in through it.
const (
	developmentSignInKeycloak = "keycloak"

	developmentKeycloakNamespace = "occ-development-keycloak"
	developmentKeycloakGateway   = "keycloak"
	// The Envoy Service of the dedicated Gateway. A fixed name lets CoreDNS
	// rewrite the Keycloak host to it.
	developmentKeycloakEnvoyService = "occ-development-keycloak"
	// k3d publishes 127.0.0.1:443 to this NodePort of the Envoy Service.
	developmentKeycloakNodePort = 30443
	developmentKeycloakHostPort = 443
	// Envoy Gateway listens on 10443 for a 443 listener; NetworkPolicy matches
	// the Pod port after DNAT, not the Service port (dogfood finding D82).
	developmentKeycloakEnvoyTargetPort = 10443
	developmentKeycloakTLSSecret       = "occ-development-keycloak-tls"
	developmentKeycloakRealm           = "oce"
	developmentKeycloakClientID        = "oce-console"
	developmentKeycloakRealmFile       = "tests/fixtures/keycloak/realm-oce.json"
	developmentKeycloakImageFile       = "tests/fixtures/keycloak/image.json"
	developmentKeycloakRealmHashKey    = "openclaw.dev/realm-sha256"
	// The chart's Gateway name for release openclaw-enterprise; the routing CA
	// Issuer and root Secret derive from it.
	developmentChartGatewayName = "openclaw-enterprise-agent-gateways"
)

// The realm file reads these placeholders; the launcher sets every one.
var developmentKeycloakPlaceholder = regexp.MustCompile(`\$\{([A-Z0-9_]+)\}`)

// developmentSignIn validates OCC_DEVELOPMENT_SIGN_IN. Keycloak is accepted only
// in the routing-enabled Kubernetes-only profile: the only one with Envoy
// Gateway, cert-manager and the HTTPS auth.baseUrl that OIDC sign-in requires.
func developmentSignIn(env map[string]string) (string, error) {
	value := env["OCC_DEVELOPMENT_SIGN_IN"]
	switch value {
	case "":
		return "", nil
	case developmentSignInKeycloak:
	default:
		return "", fmt.Errorf("OCC_DEVELOPMENT_SIGN_IN must be keycloak or unset")
	}
	if env["OCC_DEVELOPMENT_COMPUTE_DRIVER"] != "kubernetes" || env["OCC_DEVELOPMENT_CONTROL_PLANE"] != "kubernetes" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes and OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes: only the Kubernetes-only profile installs the gateway routing and HTTPS Console that OIDC sign-in needs")
	}
	if sandbox := env["OCC_DEVELOPMENT_SANDBOX_DRIVER"]; sandbox != "" && sandbox != "none" {
		return "", fmt.Errorf("OCC_DEVELOPMENT_SIGN_IN=keycloak requires OCC_DEVELOPMENT_SANDBOX_DRIVER=none: the %s sandbox profile installs no gateway routing or HTTPS Console", sandbox)
	}
	return value, nil
}

// CheckDevelopmentSignIn refuses OCC_DEVELOPMENT_SIGN_IN for the Docker Compute
// profile, whose startup script does not read it.
func CheckDevelopmentSignIn(getenv func(string) string) error {
	env := map[string]string{}
	for _, key := range []string{"OCC_DEVELOPMENT_SIGN_IN", "OCC_DEVELOPMENT_COMPUTE_DRIVER", "OCC_DEVELOPMENT_CONTROL_PLANE", "OCC_DEVELOPMENT_SANDBOX_DRIVER"} {
		env[key] = getenv(key)
	}
	_, err := developmentSignIn(env)
	return err
}

func developmentKeycloakHost(cluster string) string {
	return "keycloak." + cluster + ".oce.test"
}

func developmentKeycloakIssuer(cluster string) string {
	return "https://" + developmentKeycloakHost(cluster) + "/realms/" + developmentKeycloakRealm
}

// developmentKeycloakPortArgs publishes host loopback 443 to the Keycloak
// Gateway. k3d fixes port maps at creation, so the profile cannot be added to
// a running cluster.
func developmentKeycloakPortArgs() []string {
	return []string{"--port", fmt.Sprintf("127.0.0.1:%d:%d@loadbalancer", developmentKeycloakHostPort, developmentKeycloakNodePort)}
}

// developmentRoutingCA names the chart's private gateway-routing CA: the
// namespaced Issuer and the root Secret, both derived from the release
// namespace and Gateway name exactly as _helpers.tpl does.
func developmentRoutingCA(namespace string) (issuer, rootSecret string) {
	sum := sha256.Sum256([]byte(namespace + "/" + developmentChartGatewayName))
	service := "occ-gateway-" + hex.EncodeToString(sum[:])[:12]
	return service + "-ca", service + "-root"
}

// checkDevelopmentKeycloakHostPort fails fast when something already accepts
// connections on the host port k3d is about to publish.
func checkDevelopmentKeycloakHostPort(address string) error {
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		return nil
	}
	connection.Close()
	return fmt.Errorf("OCC_DEVELOPMENT_SIGN_IN=keycloak publishes Keycloak on %s, which another process already serves; stop it (or a running Keycloak CI lane) and run occ dev up again", address)
}

// developmentKeycloakPublished reports whether `<engine> port` output for the
// k3d load balancer's Keycloak port includes the host loopback 443 binding.
func developmentKeycloakPublished(output []byte) bool {
	want := fmt.Sprintf("127.0.0.1:%d", developmentKeycloakHostPort)
	for _, line := range strings.Split(string(output), "\n") {
		if strings.TrimSpace(line) == want {
			return true
		}
	}
	return false
}

func (r *runner) requireDevelopmentKeycloakPublication(ctx context.Context, state *developmentState) error {
	balancer := "k3d-" + state.Cluster + "-serverlb"
	output, err := r.output(ctx, r.engine, "port", balancer, fmt.Sprintf("%d/tcp", developmentKeycloakNodePort))
	if err != nil || !developmentKeycloakPublished(output) {
		return fmt.Errorf("OCC_DEVELOPMENT_SIGN_IN=keycloak needs 127.0.0.1:%d published to the k3d load balancer, and cluster %s was created without it; k3d fixes port maps at creation, so run occ dev down and occ dev up again", developmentKeycloakHostPort, state.Cluster)
	}
	return nil
}

type developmentKeycloakImage struct {
	Image string `json:"image"`
}

// readDevelopmentKeycloakFixtures loads the digest-pinned image and the realm
// the CI lane imports, so one bump changes both.
func readDevelopmentKeycloakFixtures(repository string) (image string, realm []byte, err error) {
	data, err := os.ReadFile(filepath.Join(repository, developmentKeycloakImageFile))
	if err != nil {
		return "", nil, err
	}
	var pinned developmentKeycloakImage
	if err := json.Unmarshal(data, &pinned, json.RejectUnknownMembers(true)); err != nil {
		return "", nil, fmt.Errorf("invalid %s: %w", developmentKeycloakImageFile, err)
	}
	name, digest, found := strings.Cut(pinned.Image, "@")
	if !found || name == "" || !imageDigest.MatchString(digest) {
		return "", nil, fmt.Errorf("%s must name a sha256-pinned image", developmentKeycloakImageFile)
	}
	realm, err = os.ReadFile(filepath.Join(repository, developmentKeycloakRealmFile))
	if err != nil {
		return "", nil, err
	}
	var parsed struct {
		Realm string `json:"realm"`
	}
	if err := json.Unmarshal(realm, &parsed); err != nil || parsed.Realm != developmentKeycloakRealm {
		return "", nil, fmt.Errorf("%s must be a Keycloak realm export for realm %s", developmentKeycloakRealmFile, developmentKeycloakRealm)
	}
	return pinned.Image, realm, nil
}

type developmentKeycloakSecrets struct {
	AdminPassword string
	ClientSecret  string
	AlicePassword string
	CarolPassword string
}

// realmEnvironment returns the values the realm placeholders resolve to. An
// unset placeholder imports as literal text, so every one the realm names must
// be set and non-empty.
func (s developmentKeycloakSecrets) realmEnvironment(realm []byte, redirectURI string) (map[string]string, error) {
	values := map[string]string{
		"OCE_KEYCLOAK_CLIENT_SECRET":  s.ClientSecret,
		"OCE_KEYCLOAK_REDIRECT_URI":   redirectURI,
		"OCE_KEYCLOAK_ALICE_PASSWORD": s.AlicePassword,
		"OCE_KEYCLOAK_CAROL_PASSWORD": s.CarolPassword,
	}
	for _, match := range developmentKeycloakPlaceholder.FindAllSubmatch(realm, -1) {
		name := string(match[1])
		if values[name] == "" {
			return nil, fmt.Errorf("realm placeholder ${%s} has no value; refusing to import it as literal text", name)
		}
	}
	return values, nil
}

func newDevelopmentKeycloakSecrets() (developmentKeycloakSecrets, error) {
	var s developmentKeycloakSecrets
	for _, field := range []*string{&s.AdminPassword, &s.ClientSecret, &s.AlicePassword, &s.CarolPassword} {
		value, err := randomDevelopmentSecret()
		if err != nil {
			return s, err
		}
		*field = value
	}
	return s, nil
}

// write stores each secret in the state directory, readable only by its owner.
func (s developmentKeycloakSecrets) write(directory string) error {
	for name, value := range map[string]string{
		"keycloak-admin-password": s.AdminPassword,
		"keycloak-client-secret":  s.ClientSecret,
		"keycloak-alice-password": s.AlicePassword,
		"keycloak-carol-password": s.CarolPassword,
	} {
		if err := exclusiveWrite(filepath.Join(directory, name), []byte(value), 0600); err != nil {
			return err
		}
	}
	return nil
}

func developmentRealmHash(realm []byte) string {
	sum := sha256.Sum256(realm)
	return hex.EncodeToString(sum[:])
}

// developmentRealmHashWarning explains that Keycloak imports the realm only
// when it is absent, so a changed realm file does not reach an existing
// database until its volume is removed.
func developmentRealmHashWarning(previous, current string) string {
	if previous == "" || previous == current {
		return ""
	}
	return fmt.Sprintf("Warning: the Keycloak realm file changed (sha256 %.12s, imported %.12s). Keycloak imports the realm only when it is absent, so the running realm keeps the old settings; run occ dev down and occ dev up to import the new one.\n", current, previous)
}

type developmentKeycloakInput struct {
	Cluster           string
	PlatformNamespace string
	Image             string
	Realm             []byte
	RedirectURI       string
	Environment       map[string]string
}

// developmentKeycloakManifests renders everything the profile applies before
// the TLS Secret mirror: the Keycloak workload and Gateway in their own
// Namespace, the listener Certificate and API egress in the release
// Namespace, and the CoreDNS rewrite.
func developmentKeycloakManifests(in developmentKeycloakInput) []any {
	host := developmentKeycloakHost(in.Cluster)
	labels := map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}
	appLabels := map[string]string{"app": "keycloak", "app.kubernetes.io/managed-by": "openclaw-development"}
	namespace := developmentKeycloakNamespace
	issuer, _ := developmentRoutingCA(in.PlatformNamespace)
	secretRef := func(name, key string) map[string]any {
		return map[string]any{"name": name, "valueFrom": map[string]any{"secretKeyRef": map[string]string{"name": "keycloak", "key": key}}}
	}
	env := []any{
		map[string]string{"name": "KC_DB", "value": "dev-file"},
		map[string]string{"name": "KC_HOSTNAME", "value": "https://" + host},
		map[string]string{"name": "KC_PROXY_HEADERS", "value": "xforwarded"},
		map[string]string{"name": "KC_HTTP_ENABLED", "value": "true"},
		map[string]string{"name": "KC_HEALTH_ENABLED", "value": "true"},
		map[string]string{"name": "KC_BOOTSTRAP_ADMIN_USERNAME", "value": "admin"},
		secretRef("KC_BOOTSTRAP_ADMIN_PASSWORD", "admin-password"),
		map[string]string{"name": "OCE_KEYCLOAK_REDIRECT_URI", "value": in.RedirectURI},
		secretRef("OCE_KEYCLOAK_CLIENT_SECRET", "client-secret"),
		secretRef("OCE_KEYCLOAK_ALICE_PASSWORD", "alice-password"),
		secretRef("OCE_KEYCLOAK_CAROL_PASSWORD", "carol-password"),
	}
	return []any{
		map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": namespace, "labels": labels}},
		map[string]any{
			"apiVersion": "v1", "kind": "Secret", "metadata": kubernetesMetadata("keycloak", namespace, labels),
			"stringData": map[string]string{
				"admin-password": in.Environment["KC_BOOTSTRAP_ADMIN_PASSWORD"],
				"client-secret":  in.Environment["OCE_KEYCLOAK_CLIENT_SECRET"],
				"alice-password": in.Environment["OCE_KEYCLOAK_ALICE_PASSWORD"],
				"carol-password": in.Environment["OCE_KEYCLOAK_CAROL_PASSWORD"],
			},
		},
		map[string]any{
			"apiVersion": "v1", "kind": "ConfigMap",
			"metadata": map[string]any{"name": "keycloak-realm", "namespace": namespace, "labels": labels, "annotations": map[string]string{developmentKeycloakRealmHashKey: developmentRealmHash(in.Realm)}},
			"data":     map[string]string{"realm-oce.json": string(in.Realm)},
		},
		// dev-file keeps the realm in H2 files on this claim, so a Pod restart
		// keeps it; occ dev down removes the claim with the Namespace.
		map[string]any{
			"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": kubernetesMetadata("keycloak-data", namespace, labels),
			"spec": map[string]any{"accessModes": []string{"ReadWriteOnce"}, "storageClassName": "local-path", "resources": map[string]any{"requests": map[string]string{"storage": "1Gi"}}},
		},
		map[string]any{
			"apiVersion": "apps/v1", "kind": "Deployment", "metadata": kubernetesMetadata("keycloak", namespace, labels),
			"spec": map[string]any{
				"replicas": 1, "strategy": map[string]string{"type": "Recreate"},
				"selector": map[string]any{"matchLabels": map[string]string{"app": "keycloak"}},
				"template": map[string]any{"metadata": map[string]any{"labels": appLabels}, "spec": map[string]any{
					"automountServiceAccountToken": false,
					"securityContext":              map[string]any{"runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 0, "seccompProfile": map[string]string{"type": "RuntimeDefault"}},
					"containers": []any{map[string]any{
						"name": "keycloak", "image": in.Image, "imagePullPolicy": "IfNotPresent",
						// --import-realm skips a realm that already exists, so the
						// import runs only on an empty database.
						"args":            []string{"start-dev", "--import-realm"},
						"env":             env,
						"ports":           []any{map[string]any{"name": "http", "containerPort": 8080}, map[string]any{"name": "management", "containerPort": 9000}},
						"startupProbe":    map[string]any{"httpGet": map[string]any{"path": "/health/started", "port": "management"}, "periodSeconds": 5, "failureThreshold": 60},
						"readinessProbe":  map[string]any{"httpGet": map[string]any{"path": "/health/ready", "port": "management"}, "periodSeconds": 5},
						"securityContext": map[string]any{"allowPrivilegeEscalation": false, "capabilities": map[string]any{"drop": []string{"ALL"}}},
						"resources":       map[string]any{"requests": map[string]string{"cpu": "250m", "memory": "512Mi"}, "limits": map[string]string{"cpu": "2", "memory": "1Gi"}},
						"volumeMounts": []any{
							map[string]any{"name": "data", "mountPath": "/opt/keycloak/data/h2"},
							map[string]any{"name": "realm", "mountPath": "/opt/keycloak/data/import", "readOnly": true},
						},
					}},
					"volumes": []any{
						map[string]any{"name": "data", "persistentVolumeClaim": map[string]string{"claimName": "keycloak-data"}},
						map[string]any{"name": "realm", "configMap": map[string]any{"name": "keycloak-realm"}},
					},
				}},
			},
		},
		map[string]any{
			"apiVersion": "v1", "kind": "Service", "metadata": kubernetesMetadata("keycloak", namespace, labels),
			"spec": map[string]any{"selector": map[string]string{"app": "keycloak"}, "ports": []any{map[string]any{"name": "http", "port": 8080, "targetPort": "http"}}},
		},
		// A dedicated Gateway leaves the chart's Gateway untouched. Its Envoy
		// Service is a fixed-name NodePort so k3d and CoreDNS can reach it.
		map[string]any{
			"apiVersion": "gateway.envoyproxy.io/v1alpha1", "kind": "EnvoyProxy", "metadata": kubernetesMetadata(developmentKeycloakGateway, namespace, labels),
			"spec": map[string]any{"provider": map[string]any{"type": "Kubernetes", "kubernetes": map[string]any{"envoyService": map[string]any{
				"name": developmentKeycloakEnvoyService, "type": "NodePort",
				"patch": map[string]any{"type": "StrategicMerge", "value": map[string]any{"spec": map[string]any{"ports": []any{map[string]any{"port": 443, "nodePort": developmentKeycloakNodePort}}}}},
			}}}},
		},
		map[string]any{
			"apiVersion": "gateway.networking.k8s.io/v1", "kind": "Gateway", "metadata": kubernetesMetadata(developmentKeycloakGateway, namespace, labels),
			"spec": map[string]any{
				"gatewayClassName": "eg",
				"infrastructure":   map[string]any{"parametersRef": map[string]string{"group": "gateway.envoyproxy.io", "kind": "EnvoyProxy", "name": developmentKeycloakGateway}},
				"listeners": []any{map[string]any{
					"name": "https", "hostname": host, "port": 443, "protocol": "HTTPS",
					"tls":           map[string]any{"mode": "Terminate", "certificateRefs": []any{map[string]string{"group": "", "kind": "Secret", "name": developmentKeycloakTLSSecret}}},
					"allowedRoutes": map[string]any{"namespaces": map[string]string{"from": "Same"}},
				}},
			},
		},
		map[string]any{
			"apiVersion": "gateway.networking.k8s.io/v1", "kind": "HTTPRoute", "metadata": kubernetesMetadata("keycloak", namespace, labels),
			"spec": map[string]any{
				"parentRefs": []any{map[string]string{"name": developmentKeycloakGateway, "sectionName": "https"}},
				"hostnames":  []string{host},
				"rules":      []any{map[string]any{"backendRefs": []any{map[string]any{"name": "keycloak", "port": 8080}}}},
			},
		},
		// Issued in the release Namespace from the chart's private routing CA,
		// which the API already trusts through NODE_EXTRA_CA_CERTS; the Secret
		// is mirrored to the Keycloak Namespace for the listener.
		map[string]any{
			"apiVersion": "cert-manager.io/v1", "kind": "Certificate", "metadata": kubernetesMetadata(developmentKeycloakTLSSecret, in.PlatformNamespace, labels),
			"spec": map[string]any{
				"secretName": developmentKeycloakTLSSecret, "dnsNames": []string{host}, "duration": "8760h",
				"privateKey": map[string]any{"algorithm": "ECDSA", "size": 256},
				"issuerRef":  map[string]string{"group": "cert-manager.io", "kind": "Issuer", "name": issuer},
			},
		},
		map[string]any{
			"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": kubernetesMetadata("openclaw-development-api-keycloak-egress", in.PlatformNamespace, labels),
			"spec": map[string]any{
				"podSelector": map[string]any{"matchLabels": map[string]string{"app.kubernetes.io/name": "openclaw-enterprise", "app.kubernetes.io/instance": "openclaw-enterprise", "app.kubernetes.io/component": "api"}},
				"policyTypes": []string{"Egress"},
				"egress": []any{map[string]any{
					"to": []any{map[string]any{
						"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": "envoy-gateway-system"}},
						"podSelector":       map[string]any{"matchLabels": map[string]string{"gateway.envoyproxy.io/owning-gateway-name": developmentKeycloakGateway, "gateway.envoyproxy.io/owning-gateway-namespace": namespace}},
					}},
					"ports": []any{map[string]any{"protocol": "TCP", "port": developmentKeycloakEnvoyTargetPort}},
				}},
			},
		},
		developmentKeycloakDNS(in.Cluster),
	}
}

// developmentKeycloakDNS rewrites the Keycloak host to its Envoy Service for
// Pods. k3s CoreDNS imports *.override keys of kube-system/coredns-custom.
func developmentKeycloakDNS(cluster string) map[string]any {
	return map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": kubernetesMetadata("coredns-custom", "kube-system", map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}),
		"data": map[string]string{
			"occ-development-keycloak.override": fmt.Sprintf("rewrite name exact %s %s.envoy-gateway-system.svc.cluster.local\n", developmentKeycloakHost(cluster), developmentKeycloakEnvoyService),
		},
	}
}

// developmentKeycloakTLSMirror copies the issued listener Secret into the
// Keycloak Namespace and returns its CA certificate for export.
func developmentKeycloakTLSMirror(source []byte) (map[string]any, []byte, error) {
	var secret struct {
		Data map[string][]byte `json:"data"`
	}
	if err := json.Unmarshal(source, &secret); err != nil {
		return nil, nil, fmt.Errorf("invalid Keycloak TLS Secret")
	}
	for _, key := range []string{"tls.crt", "tls.key", "ca.crt"} {
		if len(secret.Data[key]) == 0 {
			return nil, nil, fmt.Errorf("Keycloak TLS Secret has no %s", key)
		}
	}
	if !x509.NewCertPool().AppendCertsFromPEM(secret.Data["ca.crt"]) {
		return nil, nil, fmt.Errorf("Keycloak TLS Secret has an invalid ca.crt")
	}
	mirror := map[string]any{
		"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/tls",
		"metadata": kubernetesMetadata(developmentKeycloakTLSSecret, developmentKeycloakNamespace, map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}),
		"data":     map[string][]byte{"tls.crt": secret.Data["tls.crt"], "tls.key": secret.Data["tls.key"]},
	}
	return mirror, secret.Data["ca.crt"], nil
}

func developmentKeycloakRedirectURI(cluster string, browserPort int) string {
	console, _, _ := developmentBrowserHosts(cluster)
	return fmt.Sprintf("https://%s:%d/api/auth/providers/oidc/callback", console, browserPort)
}

// installDevelopmentKeycloak runs after the chart, whose routing CA Issuer
// signs the listener certificate. It returns the generated secrets and the
// realm, which the sign-in pass needs.
func (r *runner) installDevelopmentKeycloak(ctx context.Context, state *developmentState, timeout time.Duration) (secrets developmentKeycloakSecrets, realm []byte, err error) {
	if err := r.requireDevelopmentKeycloakPublication(ctx, state); err != nil {
		return secrets, nil, err
	}
	image, realm, err := readDevelopmentKeycloakFixtures(state.Repository)
	if err != nil {
		return secrets, nil, err
	}
	secrets, err = newDevelopmentKeycloakSecrets()
	if err != nil {
		return secrets, nil, err
	}
	redirectURI := developmentKeycloakRedirectURI(state.Cluster, state.BrowserPort)
	environment, err := secrets.realmEnvironment(realm, redirectURI)
	if err != nil {
		return secrets, nil, err
	}
	environment["KC_BOOTSTRAP_ADMIN_PASSWORD"] = secrets.AdminPassword
	if err := secrets.write(state.directory); err != nil {
		return secrets, nil, err
	}
	if previous, err := r.output(ctx, "kubectl", "-n", developmentKeycloakNamespace, "get", "configmap", "keycloak-realm", "-o", "jsonpath={.metadata.annotations.openclaw\\.dev/realm-sha256}"); err == nil {
		fmt.Fprint(r.opts.Err, developmentRealmHashWarning(string(previous), developmentRealmHash(realm)))
	}
	fmt.Fprintf(r.opts.Out, "Installing Keycloak in Namespace %s...\n", developmentKeycloakNamespace)
	manifests := map[string]any{"apiVersion": "v1", "kind": "List", "items": developmentKeycloakManifests(developmentKeycloakInput{
		Cluster: state.Cluster, PlatformNamespace: state.PlatformNamespace, Image: image, Realm: realm, RedirectURI: redirectURI, Environment: environment,
	})}
	if err := r.writeAndApply(ctx, state, "keycloak", manifests); err != nil {
		return secrets, nil, err
	}
	// CoreDNS reads the imported file at start; restart it so Pods resolve
	// the Keycloak host now rather than on the next reload.
	if err := r.run(ctx, "kubectl", "-n", "kube-system", "rollout", "restart", "deployment/coredns"); err != nil {
		return secrets, nil, err
	}
	if err := r.run(ctx, "kubectl", "-n", state.PlatformNamespace, "wait", "--for=condition=Ready", "certificate/"+developmentKeycloakTLSSecret, "--timeout", timeout.String()); err != nil {
		return secrets, nil, err
	}
	source, err := r.output(ctx, "kubectl", "-n", state.PlatformNamespace, "get", "secret", developmentKeycloakTLSSecret, "-o", "json")
	if err != nil {
		return secrets, nil, err
	}
	mirror, ca, err := developmentKeycloakTLSMirror(source)
	if err != nil {
		return secrets, nil, err
	}
	if err := r.writeAndApply(ctx, state, "keycloak-tls", mirror); err != nil {
		return secrets, nil, err
	}
	caPath := filepath.Join(state.directory, "gateway-ca.crt")
	if err := exclusiveWrite(caPath, ca, 0600); err != nil {
		return secrets, nil, err
	}
	for _, args := range [][]string{
		{"-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout", timeout.String()},
		{"-n", developmentKeycloakNamespace, "rollout", "status", "deployment/keycloak", "--timeout", timeout.String()},
	} {
		if err := r.run(ctx, "kubectl", args...); err != nil {
			return secrets, nil, err
		}
	}
	client, err := developmentKeycloakHostClient(state.Cluster, ca)
	if err != nil {
		return secrets, nil, err
	}
	// Discovery through the host publication proves the whole chain: k3d port,
	// NodePort, Envoy listener and certificate, route and Keycloak.
	fmt.Fprintln(r.opts.Out, "Waiting for Keycloak discovery through 127.0.0.1:443...")
	if err := waitDevelopmentKeycloakDiscovery(ctx, client, state.Cluster, timeout); err != nil {
		return secrets, nil, err
	}
	return secrets, realm, verifyDevelopmentKeycloakClient(ctx, client, state.Cluster, secrets, redirectURI)
}

// developmentKeycloakHostClient reaches the Keycloak host through the host
// publication, trusting only the exported gateway CA. It needs no /etc/hosts
// entry because it dials the loopback address directly.
func developmentKeycloakHostClient(cluster string, ca []byte) (*http.Client, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("invalid gateway CA certificate")
	}
	address := fmt.Sprintf("127.0.0.1:%d", developmentKeycloakHostPort)
	host := developmentKeycloakHost(cluster)
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: host, MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, target string) (net.Conn, error) {
			if target != host+":443" {
				return nil, fmt.Errorf("unexpected Keycloak address %s", target)
			}
			return dialer.DialContext(ctx, network, address)
		},
	}
	return &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func waitDevelopmentKeycloakDiscovery(ctx context.Context, client *http.Client, cluster string, timeout time.Duration) error {
	issuer := developmentKeycloakIssuer(cluster)
	var last error
	err := poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		var document struct {
			Issuer string `json:"issuer"`
		}
		if err := developmentKeycloakGet(ctx, client, issuer+"/.well-known/openid-configuration", "", &document); err != nil {
			last = err
			return false, nil
		}
		if document.Issuer != issuer {
			return false, fmt.Errorf("Keycloak discovery reports issuer %q, want %q", document.Issuer, issuer)
		}
		return true, nil
	})
	if err != nil && last != nil {
		return fmt.Errorf("%w (last error: %v)", err, last)
	}
	return err
}

// verifyDevelopmentKeycloakClient reads the imported client back through the
// admin API, proving the placeholders resolved to the generated values.
func verifyDevelopmentKeycloakClient(ctx context.Context, client *http.Client, cluster string, secrets developmentKeycloakSecrets, redirectURI string) error {
	base := "https://" + developmentKeycloakHost(cluster)
	form := url.Values{"grant_type": {"password"}, "client_id": {"admin-cli"}, "username": {"admin"}, "password": {secrets.AdminPassword}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/realms/master/protocol/openid-connect/token", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := developmentKeycloakDo(client, request, &token); err != nil || token.AccessToken == "" {
		return fmt.Errorf("Keycloak administrator sign-in failed: %v", err)
	}
	var clients []struct {
		ID           string   `json:"id"`
		RedirectURIs []string `json:"redirectUris"`
	}
	if err := developmentKeycloakGet(ctx, client, base+"/admin/realms/"+developmentKeycloakRealm+"/clients?clientId="+developmentKeycloakClientID, token.AccessToken, &clients); err != nil {
		return fmt.Errorf("read Keycloak client: %w", err)
	}
	if len(clients) != 1 || len(clients[0].RedirectURIs) != 1 || clients[0].RedirectURIs[0] != redirectURI {
		return fmt.Errorf("Keycloak client %s does not have the expected single redirect URI; the realm import did not resolve its placeholders", developmentKeycloakClientID)
	}
	var secret struct {
		Value string `json:"value"`
	}
	if err := developmentKeycloakGet(ctx, client, base+"/admin/realms/"+developmentKeycloakRealm+"/clients/"+url.PathEscape(clients[0].ID)+"/client-secret", token.AccessToken, &secret); err != nil {
		return fmt.Errorf("read Keycloak client secret: %w", err)
	}
	if secret.Value != secrets.ClientSecret {
		return fmt.Errorf("Keycloak client %s secret is not the generated value; the realm import did not resolve its placeholders", developmentKeycloakClientID)
	}
	return nil
}

func developmentKeycloakGet(ctx context.Context, client *http.Client, target, bearer string, out any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	return developmentKeycloakDo(client, request, out)
}

func developmentKeycloakDo(client *http.Client, request *http.Request, out any) error {
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK {
		// Never echo the body: admin responses can carry credentials.
		return fmt.Errorf("%s %s returned HTTP %d", request.Method, request.URL.Path, response.StatusCode)
	}
	return json.Unmarshal(bytes.TrimSpace(body), out)
}

// removeDevelopmentKeycloak deletes the Keycloak Namespace and with it the
// realm volume before the cluster goes. It uses the state directory's own
// kubeconfig and context explicitly so it can never touch another cluster,
// and only warns: deleting the cluster removes everything regardless.
func (r *runner) removeDevelopmentKeycloak(ctx context.Context, state *developmentState) {
	kubeconfig := filepath.Join(state.directory, "kubeconfig")
	if _, err := os.Stat(kubeconfig); err != nil {
		return
	}
	deleteCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	err := r.run(deleteCtx, "kubectl", "--kubeconfig", kubeconfig, "--context", "k3d-"+state.Cluster, "delete", "namespace", developmentKeycloakNamespace, "--ignore-not-found=true", "--wait=true", "--timeout=90s")
	if err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(r.opts.Err, "Warning: could not delete Namespace %s before removing the cluster: %v\n", developmentKeycloakNamespace, err)
	}
}

const (
	developmentAdministratorEmail = "admin@development.openclaw.invalid"
	// The realm user whose subject the launcher attaches to the administrator.
	developmentKeycloakSignInUser = "alice"
	developmentKeycloakOIDCSecret = "occ-oidc-login"
	developmentKeycloakSignInName = "Keycloak"
)

// The chart's auth.recoveryUserId rule, checked here for a clear error.
var developmentRecoveryUserID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// developmentKeycloakSubject returns the fixed Keycloak user ID, the ID token's
// sub, of one realm user.
func developmentKeycloakSubject(realm []byte, username string) (string, error) {
	var parsed struct {
		Users []struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		} `json:"users"`
	}
	if err := json.Unmarshal(realm, &parsed); err != nil {
		return "", fmt.Errorf("invalid %s", developmentKeycloakRealmFile)
	}
	for _, user := range parsed.Users {
		if user.Username == username && user.ID != "" {
			return user.ID, nil
		}
	}
	return "", fmt.Errorf("%s has no user %s with a fixed ID", developmentKeycloakRealmFile, username)
}

// developmentKeycloakEgressCIDRs accepts only the dedicated Gateway's Service.
// These pre-DNAT hosts complement the selector-scoped post-DNAT 10443 policy.
func developmentKeycloakEgressCIDRs(data []byte) ([]string, error) {
	var service struct {
		Metadata struct {
			Name      string            `json:"name"`
			Namespace string            `json:"namespace"`
			Labels    map[string]string `json:"labels"`
		} `json:"metadata"`
		Spec struct {
			Type       string            `json:"type"`
			ClusterIP  string            `json:"clusterIP"`
			ClusterIPs []string          `json:"clusterIPs"`
			Selector   map[string]string `json:"selector"`
			Ports      []struct {
				Protocol   string `json:"protocol"`
				Port       int    `json:"port"`
				TargetPort int    `json:"targetPort"`
				NodePort   int    `json:"nodePort"`
			} `json:"ports"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(data, &service); err != nil {
		return nil, fmt.Errorf("read Keycloak Envoy Service: %w", err)
	}
	if service.Metadata.Name != developmentKeycloakEnvoyService || service.Metadata.Namespace != "envoy-gateway-system" || service.Spec.Type != "NodePort" {
		return nil, fmt.Errorf("Keycloak Envoy Service identity does not match the owned publication")
	}
	for key, want := range map[string]string{
		"gateway.envoyproxy.io/owning-gateway-name":      developmentKeycloakGateway,
		"gateway.envoyproxy.io/owning-gateway-namespace": developmentKeycloakNamespace,
	} {
		if service.Metadata.Labels[key] != want || service.Spec.Selector[key] != want {
			return nil, fmt.Errorf("Keycloak Envoy Service is not owned by the dedicated Gateway")
		}
	}
	if len(service.Spec.Ports) != 1 || service.Spec.Ports[0].Protocol != "TCP" || service.Spec.Ports[0].Port != 443 || service.Spec.Ports[0].TargetPort != developmentKeycloakEnvoyTargetPort || service.Spec.Ports[0].NodePort != developmentKeycloakNodePort {
		return nil, fmt.Errorf("Keycloak Envoy Service does not expose the expected TLS listener")
	}
	if len(service.Spec.ClusterIPs) == 0 || service.Spec.ClusterIP != service.Spec.ClusterIPs[0] {
		return nil, fmt.Errorf("Keycloak Envoy Service has no consistent ClusterIP addresses")
	}
	cidrs := make([]string, 0, len(service.Spec.ClusterIPs))
	for _, value := range service.Spec.ClusterIPs {
		address, err := netip.ParseAddr(value)
		if err != nil || !address.IsGlobalUnicast() || !address.Is4() || address.Zone() != "" {
			return nil, fmt.Errorf("Keycloak Envoy Service requires a unicast IPv4 ClusterIP supported by auth.oidc.egressCidrs")
		}
		cidrs = append(cidrs, netip.PrefixFrom(address, address.BitLen()).String())
	}
	return cidrs, nil
}

// developmentKeycloakSignInValues derives the second Helm pass from the first:
// OIDC sign-in against the development Keycloak, the bootstrap administrator as
// the recovery account, and passwords for that account only. OIDC supports
// host-only cookies only, so the chart requires native Agent administration,
// and its shared cookie domain, to be off. Every key is an existing chart value.
func developmentKeycloakSignInValues(first []byte, cluster, recoveryUserID string, service []byte) ([]byte, error) {
	if !developmentRecoveryUserID.MatchString(recoveryUserID) {
		return nil, fmt.Errorf("the development administrator's user ID is not a valid auth.recoveryUserId")
	}
	var values map[string]any
	if err := json.Unmarshal(first, &values); err != nil {
		return nil, fmt.Errorf("invalid first-pass Helm values: %w", err)
	}
	auth, _ := values["auth"].(map[string]any)
	if baseURL, _ := auth["baseUrl"].(string); !strings.HasPrefix(baseURL, "https://") {
		return nil, fmt.Errorf("Keycloak sign-in needs the first Helm pass's HTTPS auth.baseUrl")
	}
	cidrs, err := developmentKeycloakEgressCIDRs(service)
	if err != nil {
		return nil, err
	}
	issuer := developmentKeycloakIssuer(cluster)
	endpoints := issuer + "/protocol/openid-connect/"
	auth["recoveryUserId"] = recoveryUserID
	auth["passwordSignIn"] = "recovery-only"
	auth["oidc"] = map[string]any{
		"enabled":          true,
		"issuer":           issuer,
		"authorizationUrl": endpoints + "auth",
		"tokenUrl":         endpoints + "token",
		"jwksUrl":          endpoints + "certs",
		"secretName":       developmentKeycloakOIDCSecret,
		"clientIdKey":      "client-id",
		"clientSecretKey":  "client-secret",
		"displayName":      developmentKeycloakSignInName,
		"egressCidrs":      cidrs,
	}
	values["agentNativeAdmin"] = map[string]any{"enabled": false}
	return json.Marshal(values)
}

// developmentKeycloakOIDCSecretManifest is the dedicated Secret auth.oidc reads.
func developmentKeycloakOIDCSecretManifest(namespace, clientSecret string) map[string]any {
	return map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata":   kubernetesMetadata(developmentKeycloakOIDCSecret, namespace, map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}),
		"stringData": map[string]string{"client-id": developmentKeycloakClientID, "client-secret": clientSecret},
	}
}

// signInDevelopmentKeycloak runs the second Helm pass and attaches alice's
// Keycloak subject to the bootstrap administrator. It runs only once the API
// serves the first pass: the attach route answers 409 while OIDC is off.
func (r *runner) signInDevelopmentKeycloak(ctx context.Context, state *developmentState, secrets developmentKeycloakSecrets, realm []byte, timeout time.Duration) error {
	subject, err := developmentKeycloakSubject(realm, developmentKeycloakSignInUser)
	if err != nil {
		return err
	}
	password, err := os.ReadFile(filepath.Join(state.directory, "initial-admin-password"))
	if err != nil {
		return err
	}
	ca, err := os.ReadFile(filepath.Join(state.directory, "browser-ca.crt"))
	if err != nil {
		return err
	}
	consoleHost, _, _ := developmentBrowserHosts(state.Cluster)
	origin := fmt.Sprintf("https://%s:%d", consoleHost, state.BrowserPort)
	address := fmt.Sprintf("127.0.0.1:%d", state.BrowserPort)

	// The password-only first pass: read the administrator's user ID.
	console, err := newDevelopmentConsole(origin, address, ca)
	if err != nil {
		return err
	}
	if err := console.signIn(ctx, developmentAdministratorEmail, string(password)); err != nil {
		return fmt.Errorf("administrator password sign-in: %w", err)
	}
	userID, err := console.sessionUserID(ctx)
	if err != nil {
		return err
	}
	// helm-values.json stays the one complete record of what the chart runs.
	valuesPath := filepath.Join(state.directory, "helm-values.json")
	first, err := os.ReadFile(valuesPath)
	if err != nil {
		return err
	}
	service, err := r.output(ctx, "kubectl", "--kubeconfig", filepath.Join(state.directory, "kubeconfig"), "--context", "k3d-"+state.Cluster, "-n", "envoy-gateway-system", "get", "service", developmentKeycloakEnvoyService, "-o", "json")
	if err != nil {
		return fmt.Errorf("read owned Keycloak Envoy Service: %w", err)
	}
	values, err := developmentKeycloakSignInValues(first, state.Cluster, userID, service)
	if err != nil {
		return err
	}
	if err := replaceDevelopmentFile(valuesPath, values); err != nil {
		return err
	}
	if err := r.writeAndApply(ctx, state, "oidc-login", developmentKeycloakOIDCSecretManifest(state.PlatformNamespace, secrets.ClientSecret)); err != nil {
		return err
	}
	fmt.Fprintln(r.opts.Out, "Enabling Keycloak sign-in (second Helm pass)...")
	if err := r.helmUpgrade(ctx, state, valuesPath, timeout); err != nil {
		return err
	}

	// Recovery-only now: only the administrator's password still signs in.
	console, err = newDevelopmentConsole(origin, address, ca)
	if err != nil {
		return err
	}
	if err := console.waitOIDC(ctx, timeout); err != nil {
		return err
	}
	if err := console.signIn(ctx, developmentAdministratorEmail, string(password)); err != nil {
		return fmt.Errorf("recovery administrator password sign-in: %w", err)
	}
	version, err := console.accountVersion(ctx, userID)
	if err != nil {
		return err
	}
	fmt.Fprintf(r.opts.Out, "Attaching Keycloak user %s to %s...\n", developmentKeycloakSignInUser, developmentAdministratorEmail)
	return console.attachOIDC(ctx, userID, subject, version)
}

// developmentConsole calls the API as a browser would: through the Console's
// HTTPS host publication, with its exact Origin and a cookie session.
type developmentConsole struct {
	origin string
	client *http.Client
}

// newDevelopmentConsole dials address for the origin's host and port, trusting
// only ca. It needs no name resolution, so *.localhost names work everywhere.
func newDevelopmentConsole(origin, address string, ca []byte) (*developmentConsole, error) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" || parsed.Port() == "" {
		return nil, fmt.Errorf("invalid Console origin %q", origin)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("invalid browser CA certificate")
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: parsed.Hostname(), MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, target string) (net.Conn, error) {
			if target != parsed.Host {
				return nil, fmt.Errorf("unexpected Console address %s", target)
			}
			return dialer.DialContext(ctx, network, address)
		},
	}
	client := &http.Client{Transport: transport, Jar: jar, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &developmentConsole{origin: origin, client: client}, nil
}

// call sends one JSON request and decodes the response envelope's data. It
// never echoes a response body: sign-in responses can carry credentials.
func (c *developmentConsole) call(ctx context.Context, method, path string, body, data any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.origin+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Origin", c.origin)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(payload, &failure)
		return fmt.Errorf("%s %s returned HTTP %d %s", method, path, response.StatusCode, failure.Error.Code)
	}
	if data == nil {
		return nil
	}
	var envelope struct {
		Data jsontext.Value `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil || len(envelope.Data) == 0 {
		return fmt.Errorf("%s %s returned an invalid response", method, path)
	}
	return json.Unmarshal(envelope.Data, data)
}

func (c *developmentConsole) signIn(ctx context.Context, email, password string) error {
	return c.call(ctx, http.MethodPost, "/api/auth/sign-in/email", map[string]string{"email": email, "password": password}, nil)
}

func (c *developmentConsole) sessionUserID(ctx context.Context) (string, error) {
	var session struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := c.call(ctx, http.MethodGet, "/api/auth/session", nil, &session); err != nil {
		return "", err
	}
	if session.User.ID == "" {
		return "", fmt.Errorf("the administrator sign-in returned no session")
	}
	return session.User.ID, nil
}

// waitOIDC waits for an API that serves the second pass: OIDC on and password
// sign-in for the recovery account only.
func (c *developmentConsole) waitOIDC(ctx context.Context, timeout time.Duration) error {
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		var providers struct {
			OIDC     bool `json:"oidc"`
			Password bool `json:"password"`
		}
		if err := c.call(ctx, http.MethodGet, "/api/auth/providers", nil, &providers); err != nil {
			return false, nil
		}
		return providers.OIDC && !providers.Password, nil
	})
}

func (c *developmentConsole) accountVersion(ctx context.Context, userID string) (int, error) {
	var account struct {
		Version int `json:"version"`
	}
	if err := c.call(ctx, http.MethodGet, "/api/auth/accounts/"+url.PathEscape(userID), nil, &account); err != nil {
		return 0, err
	}
	if account.Version < 1 {
		return 0, fmt.Errorf("the administrator account has no version")
	}
	return account.Version, nil
}

func (c *developmentConsole) attachOIDC(ctx context.Context, userID, subject string, version int) error {
	body := map[string]any{"subject": subject, "expectedVersion": version}
	if err := c.call(ctx, http.MethodPost, "/api/auth/accounts/"+url.PathEscape(userID)+"/providers/oidc", body, nil); err != nil {
		return fmt.Errorf("attach the Keycloak identity: %w", err)
	}
	return nil
}

// developmentKeycloakInstructions tells the developer how to sign in as alice:
// the two CAs a browser must trust and the host name it must resolve.
func developmentKeycloakInstructions(state *developmentState) string {
	consoleHost, _, _ := developmentBrowserHosts(state.Cluster)
	return fmt.Sprintf(`Keycloak sign-in: open https://%s:%d/console/ and choose Continue with %s.
  Keycloak user: %s
  Keycloak password file: %s
  Trust in the browser: %s (Console) and %s (Keycloak)
  Add to /etc/hosts: 127.0.0.1 %s
  Keycloak issuer: %s
  Keycloak administrator password file: %s
  Password sign-in is for the recovery account (the administrator) only.
`, consoleHost, state.BrowserPort, developmentKeycloakSignInName, developmentKeycloakSignInUser,
		filepath.Join(state.directory, "keycloak-alice-password"),
		filepath.Join(state.directory, "browser-ca.crt"), filepath.Join(state.directory, "gateway-ca.crt"),
		developmentKeycloakHost(state.Cluster), developmentKeycloakIssuer(state.Cluster),
		filepath.Join(state.directory, "keycloak-admin-password"))
}
