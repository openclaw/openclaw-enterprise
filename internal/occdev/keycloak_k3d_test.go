package occdev

import (
	"context"
	"encoding/json/v2"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
