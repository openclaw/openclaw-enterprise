package occdev

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json/v2"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

func keycloakProfileEnv() map[string]string {
	return map[string]string{
		"OCC_DEVELOPMENT_SIGN_IN":        "keycloak",
		"OCC_DEVELOPMENT_COMPUTE_DRIVER": "kubernetes",
		"OCC_DEVELOPMENT_CONTROL_PLANE":  "kubernetes",
	}
}

func TestDevelopmentSignInAcceptsKeycloakOnlyInTheRoutingProfile(t *testing.T) {
	for _, sandbox := range []string{"", "none"} {
		env := keycloakProfileEnv()
		env["OCC_DEVELOPMENT_SANDBOX_DRIVER"] = sandbox
		if value, err := developmentSignIn(env); err != nil || value != "keycloak" {
			t.Fatalf("sandbox %q: developmentSignIn = %q, %v", sandbox, value, err)
		}
	}
	if value, err := developmentSignIn(map[string]string{}); err != nil || value != "" {
		t.Fatalf("unset: developmentSignIn = %q, %v", value, err)
	}
}

func TestDevelopmentSignInRefusesEveryOtherProfile(t *testing.T) {
	cases := map[string]struct {
		key, value, want string
	}{
		"docker compute":   {"OCC_DEVELOPMENT_COMPUTE_DRIVER", "docker", "OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes"},
		"unset compute":    {"OCC_DEVELOPMENT_COMPUTE_DRIVER", "", "OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes"},
		"compose plane":    {"OCC_DEVELOPMENT_CONTROL_PLANE", "compose", "Kubernetes-only profile"},
		"unset plane":      {"OCC_DEVELOPMENT_CONTROL_PLANE", "", "Kubernetes-only profile"},
		"openshell":        {"OCC_DEVELOPMENT_SANDBOX_DRIVER", "openshell", "OCC_DEVELOPMENT_SANDBOX_DRIVER=none"},
		"unknown provider": {"OCC_DEVELOPMENT_SIGN_IN", "github", "must be keycloak or unset"},
	}
	for name, test := range cases {
		env := keycloakProfileEnv()
		env[test.key] = test.value
		_, err := developmentSignIn(env)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v does not mention %q", name, err, test.want)
		}
	}
}

func TestDockerComputeStartupRefusesKeycloakSignIn(t *testing.T) {
	env := map[string]string{"OCC_DEVELOPMENT_SIGN_IN": "keycloak"}
	if err := CheckDevelopmentSignIn(func(key string) string { return env[key] }); err == nil {
		t.Fatal("the Docker Compute profile accepted OCC_DEVELOPMENT_SIGN_IN=keycloak")
	}
	if err := CheckDevelopmentSignIn(func(string) string { return "" }); err != nil {
		t.Fatalf("unset sign-in was refused: %v", err)
	}
}

func TestUpRefusesKeycloakWithTheComposeControlPlane(t *testing.T) {
	t.Setenv("OCC_DEVELOPMENT_SIGN_IN", "keycloak")
	t.Setenv("OCC_DEVELOPMENT_COMPUTE_DRIVER", "kubernetes")
	t.Setenv("OCC_DEVELOPMENT_CONTROL_PLANE", "compose")
	t.Setenv("PATH", t.TempDir()) // any external command would fail differently
	err := Up(context.Background(), Options{Repository: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "OCC_DEVELOPMENT_SIGN_IN=keycloak") {
		t.Fatalf("Up error = %v", err)
	}
}

func TestUpRefusesKeycloakReservedPortConflictsBeforeCreatingState(t *testing.T) {
	for _, setting := range []string{"OCC_DEVELOPMENT_BROWSER_PORT", "OPENCLAW_DEV_PORT", "OCC_DEVELOPMENT_KUBERNETES_API_PORT"} {
		t.Run(setting, func(t *testing.T) {
			for key, value := range keycloakProfileEnv() {
				t.Setenv(key, value)
			}
			t.Setenv("OCC_DEVELOPMENT_SANDBOX_DRIVER", "none")
			t.Setenv("OCC_DEVELOPMENT_BROWSER_PORT", "8443")
			t.Setenv("OPENCLAW_DEV_PORT", "3000")
			t.Setenv("OCC_DEVELOPMENT_KUBERNETES_API_PORT", "6443")
			t.Setenv(setting, "443")
			t.Setenv("OCC_DEVELOPMENT_CONTROLLER_IMAGE", "")
			t.Setenv("OCC_KUBERNETES_RUNTIME_IMAGE", "")
			t.Setenv("OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY", "")
			state := filepath.Join(t.TempDir(), "state")
			t.Setenv("OCC_DEVELOPMENT_STATE_DIRECTORY", state)
			t.Setenv("PATH", t.TempDir()) // No engine or provisioning command may run.
			err := Up(context.Background(), Options{Repository: repositoryRoot(t)})
			if err == nil || !strings.Contains(err.Error(), "port 443 is reserved for Keycloak") {
				t.Fatalf("Up error = %v", err)
			}
			if _, err := os.Stat(state); !os.IsNotExist(err) {
				t.Fatalf("invalid configuration created state: %v", err)
			}
		})
	}
}

func TestKeycloakPublicationRequiresTheLoopback443Binding(t *testing.T) {
	for output, want := range map[string]bool{
		"127.0.0.1:443\n":            true,
		"0.0.0.0:443\n127.0.0.1:443": true,
		"":                           false,
		"127.0.0.1:8443":             false,
		"0.0.0.0:443":                false,
	} {
		if got := developmentKeycloakPublished([]byte(output)); got != want {
			t.Errorf("developmentKeycloakPublished(%q) = %v, want %v", output, got, want)
		}
	}
}

// keycloakPortEngine answers only the load-balancer port query.
func keycloakPortEngine(t *testing.T, answer string) *runner {
	t.Helper()
	fakeEngine(t, "docker", `"port k3d-occ-dev-test-serverlb 30443/tcp") `+answer+" ;;\n")
	r := newRunner(Options{Repository: t.TempDir()})
	r.engine = "docker"
	return r
}

func TestKeycloakRefusesAClusterCreatedWithoutThe443Publication(t *testing.T) {
	state := &developmentState{Cluster: "occ-dev-test"}
	for _, answer := range []string{"echo 'Error: no public port' >&2; exit 1", "echo 127.0.0.1:8443"} {
		err := keycloakPortEngine(t, answer).requireDevelopmentKeycloakPublication(context.Background(), state)
		if err == nil || !strings.Contains(err.Error(), "occ dev down") || !strings.Contains(err.Error(), "occ-dev-test") {
			t.Fatalf("%s: error = %v", answer, err)
		}
	}
	if err := keycloakPortEngine(t, "echo 0.0.0.0:443; echo 127.0.0.1:443").requireDevelopmentKeycloakPublication(context.Background(), state); err != nil {
		t.Fatalf("published cluster refused: %v", err)
	}
}

func TestKeycloakHostPortCheckFailsWhenSomethingListens(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := checkDevelopmentKeycloakHostPort(address); err == nil {
		t.Fatal("a busy port was accepted")
	}
	listener.Close()
	if err := checkDevelopmentKeycloakHostPort(address); err != nil {
		t.Fatalf("a free port was refused: %v", err)
	}
}

func TestRoutingCANamesMatchTheChartDerivation(t *testing.T) {
	// The dogfood install (release Namespace oce-system) issued its Keycloak
	// certificate from Issuer occ-gateway-acce0c8a7f22-ca.
	issuer, root := developmentRoutingCA("oce-system")
	if issuer != "occ-gateway-acce0c8a7f22-ca" || root != "occ-gateway-acce0c8a7f22-root" {
		t.Fatalf("routing CA = %s, %s", issuer, root)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func TestKeycloakFixturesArePinnedAndEveryPlaceholderIsSet(t *testing.T) {
	image, realm, err := readDevelopmentKeycloakFixtures(repositoryRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(image, "@sha256:") {
		t.Fatalf("image %s is not digest-pinned", image)
	}
	secrets := developmentKeycloakSecrets{AdminPassword: "a", ClientSecret: "c", AlicePassword: "p1", CarolPassword: "p2"}
	environment, err := secrets.realmEnvironment(realm, "https://console.example/api/auth/providers/oidc/callback")
	if err != nil {
		t.Fatalf("the launcher leaves a realm placeholder unset: %v", err)
	}
	for _, match := range developmentKeycloakPlaceholder.FindAllSubmatch(realm, -1) {
		if environment[string(match[1])] == "" {
			t.Errorf("placeholder %s has no value", match[1])
		}
	}
	secrets.CarolPassword = ""
	if _, err := secrets.realmEnvironment(realm, "https://console.example/cb"); err == nil || !strings.Contains(err.Error(), "OCE_KEYCLOAK_CAROL_PASSWORD") {
		t.Fatalf("an empty placeholder value was accepted: %v", err)
	}
}

func TestKeycloakSecretsAreWrittenOwnerOnly(t *testing.T) {
	directory := t.TempDir()
	secrets, err := newDevelopmentKeycloakSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if err := secrets.write(directory); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"keycloak-admin-password", "keycloak-client-secret", "keycloak-alice-password", "keycloak-carol-password"} {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 || info.Size() == 0 {
			t.Errorf("%s: mode %v size %d", name, info.Mode().Perm(), info.Size())
		}
	}
}

func TestRealmHashWarningOnlyForAChangedRealm(t *testing.T) {
	if developmentRealmHashWarning("", "abc") != "" || developmentRealmHash([]byte("x")) == "" {
		t.Fatal("a fresh import warned")
	}
	current := developmentRealmHash([]byte("new"))
	if developmentRealmHashWarning(current, current) != "" {
		t.Fatal("an unchanged realm warned")
	}
	warning := developmentRealmHashWarning(developmentRealmHash([]byte("old")), current)
	if !strings.Contains(warning, "occ dev down") || !strings.Contains(warning, current[:12]) {
		t.Fatalf("warning = %q", warning)
	}
}

// manifestByKind returns the rendered resource of a kind (and name, if given).
func manifestByKind(t *testing.T, items []any, kind, name string) map[string]any {
	t.Helper()
	data, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, item := range decoded {
		metadata := item["metadata"].(map[string]any)
		if item["kind"] == kind && (name == "" || metadata["name"] == name) {
			return item
		}
	}
	t.Fatalf("no %s %s rendered", kind, name)
	return nil
}

func field(t *testing.T, value any, path ...any) any {
	t.Helper()
	for _, step := range path {
		switch key := step.(type) {
		case string:
			value = value.(map[string]any)[key]
		case int:
			value = value.([]any)[key]
		}
	}
	return value
}

func TestKeycloakManifests(t *testing.T) {
	realm := []byte(`{"realm":"oce"}`)
	items := developmentKeycloakManifests(developmentKeycloakInput{
		Cluster: "occ-dev-test", PlatformNamespace: "oce-system", Image: "quay.io/keycloak/keycloak:26@sha256:" + strings.Repeat("a", 64),
		Realm: realm, RedirectURI: developmentKeycloakRedirectURI("occ-dev-test", 8443),
		Environment: map[string]string{"KC_BOOTSTRAP_ADMIN_PASSWORD": "admin", "OCE_KEYCLOAK_CLIENT_SECRET": "client", "OCE_KEYCLOAK_ALICE_PASSWORD": "alice", "OCE_KEYCLOAK_CAROL_PASSWORD": "carol"},
	})
	host := "keycloak.occ-dev-test.oce.test"

	manifestByKind(t, items, "Namespace", "occ-development-keycloak")
	deployment := manifestByKind(t, items, "Deployment", "keycloak")
	pod := field(t, deployment, "spec", "template", "spec")
	container := field(t, pod, "containers", 0).(map[string]any)
	if !strings.HasSuffix(container["image"].(string), "@sha256:"+strings.Repeat("a", 64)) {
		t.Errorf("image = %v", container["image"])
	}
	if got := field(t, container, "args"); got.([]any)[0] != "start-dev" || got.([]any)[1] != "--import-realm" {
		t.Errorf("args = %v", got)
	}
	env := map[string]any{}
	for _, entry := range container["env"].([]any) {
		entry := entry.(map[string]any)
		env[entry["name"].(string)] = entry
	}
	if field(t, env, "KC_DB", "value") != "dev-file" || field(t, env, "KC_HOSTNAME", "value") != "https://"+host {
		t.Errorf("KC_DB/KC_HOSTNAME = %v", env)
	}
	if field(t, env, "OCE_KEYCLOAK_REDIRECT_URI", "value") != "https://console.occ-dev-test.oce.localhost:8443/api/auth/providers/oidc/callback" {
		t.Errorf("redirect URI = %v", env["OCE_KEYCLOAK_REDIRECT_URI"])
	}
	for _, name := range []string{"KC_BOOTSTRAP_ADMIN_PASSWORD", "OCE_KEYCLOAK_CLIENT_SECRET", "OCE_KEYCLOAK_ALICE_PASSWORD", "OCE_KEYCLOAK_CAROL_PASSWORD"} {
		if _, ok := field(t, env, name).(map[string]any)["valueFrom"]; !ok {
			t.Errorf("%s is not read from the Secret", name)
		}
	}
	if field(t, deployment, "spec", "strategy", "type") != "Recreate" {
		t.Error("a rolling update would start two Keycloaks on one ReadWriteOnce claim")
	}
	mounts := map[string]any{}
	for _, mount := range container["volumeMounts"].([]any) {
		mount := mount.(map[string]any)
		mounts[mount["mountPath"].(string)] = mount["name"]
	}
	if mounts["/opt/keycloak/data/h2"] != "data" || mounts["/opt/keycloak/data/import"] != "realm" {
		t.Errorf("mounts = %v", mounts)
	}
	if field(t, pod, "volumes", 0, "persistentVolumeClaim", "claimName") != "keycloak-data" {
		t.Error("the dev-file database is not on the claim")
	}
	manifestByKind(t, items, "PersistentVolumeClaim", "keycloak-data")

	realmMap := manifestByKind(t, items, "ConfigMap", "keycloak-realm")
	if field(t, realmMap, "data", "realm-oce.json") != string(realm) || field(t, realmMap, "metadata", "annotations", "openclaw.dev/realm-sha256") != developmentRealmHash(realm) {
		t.Errorf("realm ConfigMap = %v", realmMap)
	}
	secret := manifestByKind(t, items, "Secret", "keycloak")
	if field(t, secret, "stringData", "client-secret") != "client" || field(t, secret, "stringData", "admin-password") != "admin" {
		t.Errorf("secret = %v", secret)
	}

	proxy := manifestByKind(t, items, "EnvoyProxy", "keycloak")
	service := field(t, proxy, "spec", "provider", "kubernetes", "envoyService")
	if field(t, service, "name") != "occ-development-keycloak" || field(t, service, "type") != "NodePort" || field(t, service, "patch", "value", "spec", "ports", 0, "nodePort") != float64(30443) {
		t.Errorf("Envoy Service = %v", service)
	}
	gateway := manifestByKind(t, items, "Gateway", "keycloak")
	listener := field(t, gateway, "spec", "listeners", 0)
	if field(t, listener, "hostname") != host || field(t, listener, "port") != float64(443) || field(t, listener, "tls", "certificateRefs", 0, "name") != "occ-development-keycloak-tls" {
		t.Errorf("listener = %v", listener)
	}
	if field(t, gateway, "metadata", "namespace") != "occ-development-keycloak" {
		t.Error("the Keycloak Gateway must not live in the release Namespace")
	}

	certificate := manifestByKind(t, items, "Certificate", "occ-development-keycloak-tls")
	if field(t, certificate, "metadata", "namespace") != "oce-system" || field(t, certificate, "spec", "issuerRef", "name") != "occ-gateway-acce0c8a7f22-ca" || field(t, certificate, "spec", "dnsNames", 0) != host {
		t.Errorf("certificate = %v", certificate)
	}

	policy := manifestByKind(t, items, "NetworkPolicy", "openclaw-development-api-keycloak-egress")
	egress := field(t, policy, "spec", "egress", 0)
	if field(t, egress, "ports", 0, "port") != float64(10443) || field(t, egress, "to", 0, "podSelector", "matchLabels", "gateway.envoyproxy.io/owning-gateway-namespace") != "occ-development-keycloak" || field(t, policy, "spec", "podSelector", "matchLabels", "app.kubernetes.io/component") != "api" {
		t.Errorf("egress policy = %v", policy)
	}

	dns := manifestByKind(t, items, "ConfigMap", "coredns-custom")
	if field(t, dns, "metadata", "namespace") != "kube-system" || field(t, dns, "data", "occ-development-keycloak.override") != "rewrite name exact "+host+" occ-development-keycloak.envoy-gateway-system.svc.cluster.local\n" {
		t.Errorf("CoreDNS rewrite = %v", dns)
	}
}

func TestKeycloakTLSMirrorCopiesOnlyTheListenerPair(t *testing.T) {
	directory := t.TempDir()
	if err := writeDevelopmentTLS(directory, "kc", "test CA", []string{"keycloak.occ-dev-test.oce.test"}); err != nil {
		t.Fatal(err)
	}
	read := func(name string) []byte {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	source, err := json.Marshal(map[string]any{"data": map[string][]byte{"tls.crt": read("kc-tls.crt"), "tls.key": read("kc-tls.key"), "ca.crt": read("kc-ca.crt")}})
	if err != nil {
		t.Fatal(err)
	}
	mirror, ca, err := developmentKeycloakTLSMirror(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(ca) != string(read("kc-ca.crt")) {
		t.Error("exported CA differs from the issued ca.crt")
	}
	data := mirror["data"].(map[string][]byte)
	if len(data) != 2 || mirror["type"] != "kubernetes.io/tls" || field(t, map[string]any{"m": mirror["metadata"]}, "m", "namespace") != "occ-development-keycloak" {
		t.Errorf("mirror = %v", mirror)
	}
	broken, _ := json.Marshal(map[string]any{"data": map[string][]byte{"tls.crt": read("kc-tls.crt"), "tls.key": read("kc-tls.key")}})
	if _, _, err := developmentKeycloakTLSMirror(broken); err == nil {
		t.Error("a Secret without ca.crt was mirrored")
	}
}

func writePrivateState(t *testing.T, state map[string]any) string {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string][]byte{".openclaw-development": []byte(stateMarker), "state.json": data} {
		if err := os.WriteFile(filepath.Join(directory, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func TestStateRecordsKeycloakOnlyForTheRoutingProfile(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{
			"version": 3, "repository": "/repo", "computeDriver": "kubernetes", "sandboxDriver": "none", "deploymentMode": "k3d",
			"platformNamespace": "oce-system", "apiPort": 3000, "browserPort": 8443, "containerEngine": "docker", "composeProject": "",
			"cluster": "occ-dev-test", "dockerHost": "unix:///run/docker.sock", "keyPath": "/key.json", "keyOwned": false, "signIn": "keycloak",
		}
	}
	state, err := readState(writePrivateState(t, base()))
	if err != nil || state.SignIn != "keycloak" {
		t.Fatalf("readState = %+v, %v", state, err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"no browser port": func(s map[string]any) { s["browserPort"] = 0 },
		"openshell":       func(s map[string]any) { s["sandboxDriver"] = "openshell" },
		"unknown":         func(s map[string]any) { s["signIn"] = "github" },
	} {
		state := base()
		mutate(state)
		if _, err := readState(writePrivateState(t, state)); err == nil {
			t.Errorf("%s: readState accepted sign-in state", name)
		}
	}
}

func TestKeycloakSubjectIsTheRealmUsersFixedID(t *testing.T) {
	_, realm, err := readDevelopmentKeycloakFixtures(repositoryRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	subject, err := developmentKeycloakSubject(realm, "alice")
	if err != nil || subject != "6f1c1e9a-3d4b-4c55-9a2e-0a11ce000001" {
		t.Fatalf("alice subject = %q, %v", subject, err)
	}
	if _, err := developmentKeycloakSubject(realm, "mallory"); err == nil {
		t.Fatal("a user missing from the realm resolved to a subject")
	}
}

// firstPassValues is the shape the first Helm pass writes in the routing
// profile, plus a later edit (repository credentials) the second pass keeps.
func firstPassValues(t *testing.T) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]any{
		"images":                map[string]string{"controller": "controller:dev"},
		"auth":                  map[string]string{"baseUrl": "https://console.occ-dev-test.oce.localhost:8443"},
		"agentNativeAdmin":      map[string]any{"enabled": true, "domain": "agents.occ-dev-test.oce.localhost", "sharedCookieDomain": "occ-dev-test.oce.localhost"},
		"gatewayRouting":        map[string]any{"enabled": true, "gatewayClassName": "eg", "apiKeySecretName": "occ-private-gateway-key"},
		"repositoryCredentials": map[string]any{"enabled": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestKeycloakSignInValuesEnableOIDCForTheRecoveryAdministrator(t *testing.T) {
	data, err := developmentKeycloakSignInValues(firstPassValues(t), "occ-dev-test", "user_Admin-1", keycloakServiceJSON(t))
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]any
	if err := json.Unmarshal(data, &values); err != nil {
		t.Fatal(err)
	}
	issuer := "https://keycloak.occ-dev-test.oce.test/realms/oce"
	want := map[string]any{
		"baseUrl":        "https://console.occ-dev-test.oce.localhost:8443",
		"recoveryUserId": "user_Admin-1",
		"passwordSignIn": "recovery-only",
		"oidc": map[string]any{
			"enabled":          true,
			"issuer":           issuer,
			"authorizationUrl": issuer + "/protocol/openid-connect/auth",
			"tokenUrl":         issuer + "/protocol/openid-connect/token",
			"jwksUrl":          issuer + "/protocol/openid-connect/certs",
			"secretName":       "occ-oidc-login",
			"clientIdKey":      "client-id",
			"clientSecretKey":  "client-secret",
			"displayName":      "Keycloak",
			"egressCidrs":      []string{"10.43.0.42/32"},
		},
	}
	if got := mustJSON(t, values["auth"]); string(got) != string(mustJSON(t, want)) {
		t.Fatalf("auth = %s\nwant %s", got, mustJSON(t, want))
	}
	// The chart refuses OIDC beside native administration; a leftover shared
	// cookie domain would not render either.
	if got, _ := json.Marshal(values["agentNativeAdmin"]); string(got) != `{"enabled":false}` {
		t.Fatalf("agentNativeAdmin = %s", got)
	}
	for _, key := range []string{"images", "gatewayRouting", "repositoryCredentials"} {
		if values[key] == nil {
			t.Errorf("the second pass dropped %s", key)
		}
	}
	assertChartValues(t, values, "auth")
	assertChartValues(t, values, "agentNativeAdmin")
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value, json.Deterministic(true))
	if err != nil {
		t.Fatal(err)
	}
	var normalized any
	if err := json.Unmarshal(data, &normalized); err != nil {
		t.Fatal(err)
	}
	data, err = json.Marshal(normalized, json.Deterministic(true))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// assertChartValues proves the launcher sets only values the chart already
// declares: RFC-0019 adds no chart surface.
func assertChartValues(t *testing.T, values map[string]any, key string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repositoryRoot(t), "deploy", "helm", "openclaw-enterprise", "values.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var chart map[string]any
	if err := yaml.Unmarshal(data, &chart); err != nil {
		t.Fatal(err)
	}
	var walk func(path string, set, declared any)
	walk = func(path string, set, declared any) {
		setMap, ok := set.(map[string]any)
		if !ok {
			return
		}
		declaredMap, ok := declared.(map[string]any)
		if !ok {
			t.Errorf("%s is not a map in the chart values", path)
			return
		}
		for name, value := range setMap {
			child, found := declaredMap[name]
			if !found {
				t.Errorf("%s.%s is not a chart value", path, name)
				continue
			}
			walk(path+"."+name, value, child)
		}
	}
	walk(key, values[key], chart[key])
}

func TestKeycloakSignInValuesRefuseAnHTTPConsoleOrAnInvalidUserID(t *testing.T) {
	if _, err := developmentKeycloakSignInValues(firstPassValues(t), "occ-dev-test", "-bad id", keycloakServiceJSON(t)); err == nil {
		t.Fatal("an invalid recovery user ID was accepted")
	}
	plain, _ := json.Marshal(map[string]any{"auth": map[string]string{"baseUrl": "http://127.0.0.1:3000"}})
	if _, err := developmentKeycloakSignInValues(plain, "occ-dev-test", "user1", keycloakServiceJSON(t)); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("an HTTP base URL was accepted: %v", err)
	}
}

func TestKeycloakInstructionsNameTheConsoleUserCAsAndHostsLine(t *testing.T) {
	state := &developmentState{Cluster: "occ-dev-test", BrowserPort: 8443, directory: "/state"}
	text := developmentKeycloakInstructions(state)
	for _, want := range []string{
		"https://console.occ-dev-test.oce.localhost:8443/console/",
		"Continue with Keycloak",
		"/state/keycloak-alice-password",
		"/state/browser-ca.crt",
		"/state/gateway-ca.crt",
		"127.0.0.1 keycloak.occ-dev-test.oce.test",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("instructions lack %q:\n%s", want, text)
		}
	}
}

// fakeConsoleAPI imitates the API routes the sign-in pass uses, switching to
// OIDC with recovery-only passwords once the fake helm has run.
type fakeConsoleAPI struct {
	t        *testing.T
	origin   string
	upgraded string
	password string
	sessions int
	// attach records the attach request.
	attachPath, attachOrigin, attachCookie string
	attachBody                             map[string]any
	accountReads                           int
}

func (f *fakeConsoleAPI) oidc() bool {
	_, err := os.Stat(f.upgraded)
	return err == nil
}

func (f *fakeConsoleAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	reply := func(status int, body string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}
	session, _ := r.Cookie("__Host-occ.session")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/auth/providers":
		on := f.oidc()
		reply(200, fmt.Sprintf(`{"data":{"github":false,"google":false,"oidc":%t,"password":%t,"sessionBinding":%t}}`, on, !on, on))
	case r.Method == http.MethodPost && r.URL.Path == "/api/auth/sign-in/email":
		var body map[string]string
		if err := json.UnmarshalRead(r.Body, &body); err != nil || r.Header.Get("Origin") != f.origin || body["email"] != "admin@development.openclaw.invalid" || body["password"] != f.password {
			reply(401, `{"error":{"code":"UNAUTHENTICATED"}}`)
			return
		}
		f.sessions++
		http.SetCookie(w, &http.Cookie{Name: "__Host-occ.session", Value: fmt.Sprintf("s%d-oidc-%t", f.sessions, f.oidc()), Path: "/", Secure: true, HttpOnly: true})
		reply(200, `{"data":{"authenticated":true,"sessionKey":"k"}}`)
	case r.Method == http.MethodGet && r.URL.Path == "/api/auth/session":
		if session == nil {
			reply(200, `{"data":null}`)
			return
		}
		reply(200, `{"data":{"authenticated":true,"sessionKey":"k","user":{"id":"user_admin1","email":"admin@development.openclaw.invalid","name":"Admin"}}}`)
	case r.Method == http.MethodGet && r.URL.Path == "/api/auth/accounts/user_admin1":
		// Account controls exist only once OIDC is on, and need the exact Origin.
		if !f.oidc() || session == nil || r.Header.Get("Origin") != f.origin {
			reply(409, `{"error":{"code":"RESOURCE_CONFLICT"}}`)
			return
		}
		f.accountReads++
		reply(200, `{"data":{"userId":"user_admin1","principalId":"p1","version":3,"disabled":false,"methods":[]}}`)
	case r.Method == http.MethodPost && r.URL.Path == "/api/auth/accounts/user_admin1/providers/oidc":
		f.attachPath, f.attachOrigin = r.URL.Path, r.Header.Get("Origin")
		if session != nil {
			f.attachCookie = session.Value
		}
		if err := json.UnmarshalRead(r.Body, &f.attachBody); err != nil {
			f.t.Errorf("attach body: %v", err)
		}
		reply(200, `{"data":{"methodId":"m1","providerId":"oidc:abc"}}`)
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		reply(404, `{"error":{"code":"NOT_FOUND"}}`)
	}
}

func TestKeycloakSignInRunsTheSecondPassAndAttachesAlice(t *testing.T) {
	directory := t.TempDir()
	record := t.TempDir()
	consoleHost, _, _ := developmentBrowserHosts("occ-dev-test")
	if err := writeDevelopmentTLS(directory, "browser", "test browser CA", []string{consoleHost}); err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.LoadX509KeyPair(filepath.Join(directory, "browser-tls.crt"), filepath.Join(directory, "browser-tls.key"))
	if err != nil {
		t.Fatal(err)
	}
	api := &fakeConsoleAPI{t: t, upgraded: filepath.Join(record, "upgraded"), password: "admin-password"}
	server := httptest.NewUnstartedServer(api)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
	server.StartTLS()
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	api.origin = fmt.Sprintf("https://%s:%d", consoleHost, port)

	if err := os.WriteFile(filepath.Join(directory, "initial-admin-password"), []byte(api.password), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "helm-values.json"), firstPassValues(t), 0600); err != nil {
		t.Fatal(err)
	}
	fakeEngine(t, "kubectl", `"--kubeconfig "*" get service occ-development-keycloak -o json") printf '%s\n' `+shellQuote(string(keycloakServiceJSON(t)))+` ;;
"apply -f "*) cp "$3" "`+record+`/applied-$(basename "$3")" ;;
`)
	fakeEngine(t, "helm", `"upgrade --install openclaw-enterprise "*) while [ $# -gt 0 ]; do [ "$1" = -f ] && cp "$2" "`+record+`/helm-values.json"; shift; done; touch "`+record+`/upgraded" ;;
`)
	_, realm, err := readDevelopmentKeycloakFixtures(repositoryRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	state := &developmentState{Cluster: "occ-dev-test", PlatformNamespace: "oce-system", BrowserPort: port, directory: directory}
	r := newRunner(Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := r.signInDevelopmentKeycloak(ctx, state, developmentKeycloakSecrets{ClientSecret: "client-secret-value"}, realm, 20*time.Second); err != nil {
		t.Fatal(err)
	}

	// The attach request: alice's fixed subject, the read account version, the
	// exact Origin and a session signed in after the second pass.
	if api.attachOrigin != api.origin || !strings.HasSuffix(api.attachCookie, "-oidc-true") || api.accountReads != 1 {
		t.Fatalf("attach origin %q, cookie %q, account reads %d", api.attachOrigin, api.attachCookie, api.accountReads)
	}
	if got := string(mustJSON(t, api.attachBody)); got != `{"expectedVersion":3,"subject":"6f1c1e9a-3d4b-4c55-9a2e-0a11ce000001"}` {
		t.Fatalf("attach body = %s", got)
	}
	// The second pass ran on the recorded values with the administrator's ID.
	upgraded, err := os.ReadFile(filepath.Join(record, "helm-values.json"))
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]any
	if err := json.Unmarshal(upgraded, &values); err != nil {
		t.Fatal(err)
	}
	if field(t, values, "auth", "recoveryUserId") != "user_admin1" || field(t, values, "auth", "passwordSignIn") != "recovery-only" || field(t, values, "auth", "oidc", "enabled") != true {
		t.Fatalf("second-pass values = %s", upgraded)
	}
	if recorded, _ := os.ReadFile(filepath.Join(directory, "helm-values.json")); string(recorded) != string(upgraded) {
		t.Fatal("helm-values.json does not record the second pass")
	}
	var secret map[string]any
	data, err := os.ReadFile(filepath.Join(record, "applied-oidc-login.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &secret); err != nil {
		t.Fatal(err)
	}
	if field(t, secret, "metadata", "name") != "occ-oidc-login" || field(t, secret, "metadata", "namespace") != "oce-system" ||
		field(t, secret, "stringData", "client-id") != "oce-console" || field(t, secret, "stringData", "client-secret") != "client-secret-value" {
		t.Fatalf("OIDC Secret = %s", data)
	}
}

func TestKeycloakSignInStopsWhenThePasswordIsRefused(t *testing.T) {
	directory := t.TempDir()
	consoleHost, _, _ := developmentBrowserHosts("occ-dev-test")
	if err := writeDevelopmentTLS(directory, "browser", "test browser CA", []string{consoleHost}); err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.LoadX509KeyPair(filepath.Join(directory, "browser-tls.crt"), filepath.Join(directory, "browser-tls.key"))
	if err != nil {
		t.Fatal(err)
	}
	api := &fakeConsoleAPI{t: t, upgraded: filepath.Join(directory, "never"), password: "other"}
	server := httptest.NewUnstartedServer(api)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
	server.StartTLS()
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	api.origin = fmt.Sprintf("https://%s:%d", consoleHost, port)
	if err := os.WriteFile(filepath.Join(directory, "initial-admin-password"), []byte("wrong"), 0600); err != nil {
		t.Fatal(err)
	}
	_, realm, err := readDevelopmentKeycloakFixtures(repositoryRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	state := &developmentState{Cluster: "occ-dev-test", PlatformNamespace: "oce-system", BrowserPort: port, directory: directory}
	err = newRunner(Options{}).signInDevelopmentKeycloak(context.Background(), state, developmentKeycloakSecrets{ClientSecret: "c"}, realm, time.Second)
	if err == nil || !strings.Contains(err.Error(), "HTTP 401 UNAUTHENTICATED") || strings.Contains(err.Error(), "wrong") {
		t.Fatalf("error = %v", err)
	}
}

func TestDevelopmentConsoleTrustsOnlyTheBrowserCA(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer server.Close()
	directory := t.TempDir()
	if err := writeDevelopmentTLS(directory, "browser", "test browser CA", []string{"example.com"}); err != nil {
		t.Fatal(err)
	}
	ca, err := os.ReadFile(filepath.Join(directory, "browser-ca.crt"))
	if err != nil {
		t.Fatal(err)
	}
	address := server.Listener.Addr().String()
	_, port, _ := net.SplitHostPort(address)
	console, err := newDevelopmentConsole("https://example.com:"+port, address, ca)
	if err != nil {
		t.Fatal(err)
	}
	if err := console.call(context.Background(), http.MethodGet, "/api/auth/providers", nil, nil); err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("a certificate from another CA was trusted: %v", err)
	}
}

// This is the Kubernetes Service response, not a caller-provided allowlist.
func keycloakServiceJSON(t *testing.T) []byte {
	t.Helper()
	return mustJSON(t, map[string]any{
		"metadata": map[string]any{"name": "occ-development-keycloak", "namespace": "envoy-gateway-system", "labels": map[string]string{
			"gateway.envoyproxy.io/owning-gateway-name": "keycloak", "gateway.envoyproxy.io/owning-gateway-namespace": "occ-development-keycloak",
		}},
		"spec": map[string]any{"type": "NodePort", "clusterIP": "10.43.0.42", "clusterIPs": []string{"10.43.0.42"},
			"selector": map[string]string{"gateway.envoyproxy.io/owning-gateway-name": "keycloak", "gateway.envoyproxy.io/owning-gateway-namespace": "occ-development-keycloak"},
			"ports":    []any{map[string]any{"protocol": "TCP", "port": 443, "targetPort": 10443, "nodePort": 30443}},
		},
	})
}

func TestKeycloakSignInRejectsUnownedOrInvalidService(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"wrong name":        func(s map[string]any) { s["metadata"].(map[string]any)["name"] = "other" },
		"wrong namespace":   func(s map[string]any) { s["metadata"].(map[string]any)["namespace"] = "default" },
		"wrong owner":       func(s map[string]any) { s["metadata"].(map[string]any)["labels"] = map[string]string{} },
		"wrong destination": func(s map[string]any) { s["spec"].(map[string]any)["selector"] = map[string]string{} },
		"wrong listener":    func(s map[string]any) { s["spec"].(map[string]any)["ports"] = []any{} },
		"headless":          func(s map[string]any) { s["spec"].(map[string]any)["clusterIP"] = "None" },
		"missing addresses": func(s map[string]any) { delete(s["spec"].(map[string]any), "clusterIPs") },
	} {
		t.Run(name, func(t *testing.T) {
			var service map[string]any
			if err := json.Unmarshal(keycloakServiceJSON(t), &service); err != nil {
				t.Fatal(err)
			}
			mutate(service)
			if _, err := developmentKeycloakSignInValues(firstPassValues(t), "occ-dev-test", "user1", mustJSON(t, service)); err == nil {
				t.Fatal("unsafe Service accepted")
			}
		})
	}
	for _, address := range []string{"0.0.0.0", "127.0.0.1", "169.254.1.1", "224.0.0.1", "::", "::1", "fe80::1", "ff02::1", "10.0.0.0/8", "::ffff:10.43.0.42", "fd00::42", "invalid"} {
		t.Run(address, func(t *testing.T) {
			var service map[string]any
			if err := json.Unmarshal(keycloakServiceJSON(t), &service); err != nil {
				t.Fatal(err)
			}
			spec := service["spec"].(map[string]any)
			spec["clusterIP"], spec["clusterIPs"] = address, []string{address}
			if _, err := developmentKeycloakEgressCIDRs(mustJSON(t, service)); err == nil {
				t.Fatal("unsafe address accepted")
			}
		})
	}
}

func TestKeycloakSecondPassRenderedPoliciesRestrictHTTPS(t *testing.T) {
	helm, err := exec.LookPath("helm")
	if err != nil {
		t.Skip("Helm is required to verify the complete rendered policy set")
	}
	first := map[string]any{}
	if err := json.Unmarshal(firstPassValues(t), &first); err != nil {
		t.Fatal(err)
	}
	// The local profile does not enable repository credentials by default.
	delete(first, "repositoryCredentials")
	first["bootstrap"] = map[string]any{"adminEmail": developmentAdministratorEmail, "password": map[string]string{"claimName": "bootstrap-password"}}
	first["api"] = map[string]any{"clients": []any{map[string]any{"namespace": "oce-system", "podLabels": map[string]string{"app.kubernetes.io/name": "occ-kubernetes-dev-client"}}}}
	first["images"] = map[string]string{"controller": "controller@" + profileTestDigest}
	first["database"] = map[string]any{"cidrs": []string{"10.42.0.20/32"}}
	first["cluster"] = map[string]any{"cidrs": []string{"172.30.42.3/32"}, "port": 6443}
	second, err := developmentKeycloakSignInValues(mustJSON(t, first), "occ-dev-test", "user1", keycloakServiceJSON(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, broad := range []bool{false, true} {
		var values map[string]any
		if err := json.Unmarshal(second, &values); err != nil {
			t.Fatal(err)
		}
		if broad {
			delete(values["auth"].(map[string]any)["oidc"].(map[string]any), "egressCidrs")
		}
		path := filepath.Join(t.TempDir(), "values.json")
		if err := os.WriteFile(path, mustJSON(t, values), 0600); err != nil {
			t.Fatal(err)
		}
		command := exec.Command(helm, "template", "openclaw-enterprise", "deploy/helm/openclaw-enterprise", "--namespace", "oce-system", "-f", path)
		command.Dir = repositoryRoot(t)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("Helm render: %v\n%s", err, output)
		}
		decoder := yaml.NewDecoder(bytes.NewReader(output))
		var policies []map[string]any
		for {
			var item map[string]any
			err := decoder.Decode(&item)
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if item["kind"] == "NetworkPolicy" {
				policies = append(policies, item)
			}
		}
		// Include launcher policies too: a narrow additional policy cannot cancel
		// a broad permission in another policy selected by the same API Pod.
		for _, item := range developmentKeycloakManifests(developmentKeycloakInput{Cluster: "occ-dev-test", PlatformNamespace: "oce-system"}) {
			var normalized map[string]any
			if err := json.Unmarshal(mustJSON(t, item), &normalized); err != nil {
				t.Fatal(err)
			}
			if normalized["kind"] == "NetworkPolicy" {
				policies = append(policies, normalized)
			}
		}
		cidrs := []string{}
		postDNAT := false
		for _, policy := range policies {
			spec := policy["spec"].(map[string]any)
			selector := spec["podSelector"].(map[string]any)
			labels, _ := selector["matchLabels"].(map[string]any)
			if component, ok := labels["app.kubernetes.io/component"]; ok && component != "api" {
				continue
			}
			// Other component expressions in this profile include the API.
			egress, _ := spec["egress"].([]any)
			for _, raw := range egress {
				rule := raw.(map[string]any)
				ports, _ := rule["ports"].([]any)
				if len(ports) == 0 {
					t.Fatalf("unrestricted egress ports in %v", policy["metadata"])
				}
				for _, rawPort := range ports {
					port := rawPort.(map[string]any)
					number := fmt.Sprint(port["port"])
					if number == "10443" && field(t, policy, "metadata", "name") == "openclaw-development-api-keycloak-egress" {
						peers := rule["to"].([]any)
						if len(peers) != 1 || field(t, peers[0], "namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") != "envoy-gateway-system" || field(t, peers[0], "podSelector", "matchLabels", "gateway.envoyproxy.io/owning-gateway-name") != "keycloak" || field(t, peers[0], "podSelector", "matchLabels", "gateway.envoyproxy.io/owning-gateway-namespace") != "occ-development-keycloak" {
							t.Fatal("post-DNAT permission is not scoped to Keycloak")
						}
						postDNAT = true
					}
					if number != "443" {
						continue
					}
					for _, rawPeer := range rule["to"].([]any) {
						peer := rawPeer.(map[string]any)
						block, ok := peer["ipBlock"].(map[string]any)
						if !ok {
							t.Fatalf("unscoped HTTPS peer in %v", policy["metadata"])
						}
						cidrs = append(cidrs, block["cidr"].(string))
					}
				}
			}
		}
		if !postDNAT {
			t.Fatal("missing selector-scoped post-DNAT policy")
		}
		slices.Sort(cidrs)
		want := []string{"10.43.0.42/32"}
		if broad {
			want = []string{"0.0.0.0/0"}
		}
		if !slices.Equal(cidrs, want) {
			t.Fatalf("complete rendered HTTPS destinations = %v; want %v (old broad rule=%t)", cidrs, want, broad)
		}
	}
}
