package occdev

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

const (
	developmentAPINodePort = 30080
	developmentController  = "openclaw-enterprise-controller:kubernetes-quickstart"
	developmentNodeBase    = "docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584"
	developmentPostgres    = "docker.io/library/postgres:18.6@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae"
)

func upOpenShellK3d(ctx context.Context, opts Options) (result error) {
	r := newRunner(opts)
	if len(opts.ComposeArgs) != 0 {
		return fmt.Errorf("the OpenShell k3d profile does not accept Compose options")
	}
	timeoutSeconds, err := positiveSetting(r, "OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS", 600, 86400)
	if err != nil {
		return err
	}
	kubernetesPort, err := positiveSetting(r, "OCC_DEVELOPMENT_KUBERNETES_API_PORT", 6443, 65535)
	if err != nil {
		return err
	}
	apiPort, err := positiveSetting(r, "OPENCLAW_DEV_PORT", 3000, 65535)
	if err != nil {
		return err
	}
	threshold, err := positiveSetting(r, "OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT", 5, 20)
	if err != nil {
		return err
	}
	directory, err := stateDirectory(r.env["OCC_DEVELOPMENT_STATE_DIRECTORY"], opts.Repository, false)
	if err != nil {
		return err
	}
	state := &developmentState{
		Version:           3,
		Repository:        opts.Repository,
		ComputeDriver:     "kubernetes",
		SandboxDriver:     "openshell",
		DeploymentMode:    "k3d",
		PlatformNamespace: r.setting("OCC_DEVELOPMENT_KUBERNETES_NAMESPACE", "oce-system"),
		APIPort:           apiPort,
		Cluster:           r.setting("OCC_DEVELOPMENT_KUBERNETES_CLUSTER", "occ-dev-"+strings.ToLower(rand.Text()[:10])),
		KeyPath:           opts.KeyOutput,
		KeyOwned:          opts.KeyOutput == "",
		directory:         directory,
	}
	if !clusterName.MatchString(state.Cluster) || !namespaceName.MatchString(state.PlatformNamespace) {
		return fmt.Errorf("invalid Kubernetes cluster or platform Namespace name")
	}
	if state.KeyOwned {
		state.KeyPath = filepath.Join(directory, "initial-admin-service-key.json")
	} else if err := validateKeyOutput(state.KeyPath); err != nil {
		return err
	}
	for _, name := range []string{"k3d", "kubectl", "helm"} {
		if _, err := exec.LookPath(name); err != nil {
			return fmt.Errorf("%s is required on PATH", name)
		}
	}
	if err := r.selectImageEngine(ctx, r.setting("OCC_DEVELOPMENT_CONTAINER_ENGINE", "auto")); err != nil {
		return err
	}
	if err := r.pinEndpoint(ctx); err != nil {
		return err
	}
	state.ContainerEngine = r.engine
	state.DockerHost = r.env["DOCKER_HOST"]
	exists, err := r.clusterExists(ctx, state.Cluster)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("k3d cluster already exists: %s", state.Cluster)
	}

	if err := os.Mkdir(directory, 0700); err != nil {
		return err
	}
	lock, err := lockState(directory)
	if err != nil {
		return err
	}
	clusterAttempted := false
	clusterCreationFailed := false
	keyWritten := false
	defer func() {
		defer lock.Close()
		if result == nil {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		cleanupErr := r.cleanup(cleanupCtx, state, clusterAttempted)
		if clusterCreationFailed {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("cluster creation failed; verify and retry recorded cleanup"))
		}
		if cleanupErr == nil {
			cleanupErr = os.RemoveAll(directory)
		}
		if keyWritten && !state.KeyOwned {
			if err := os.Remove(state.KeyPath); err != nil && !os.IsNotExist(err) {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("remove copied service key: %w", err))
			}
		}
		if cleanupErr != nil {
			result = errors.Join(result, fmt.Errorf("rollback incomplete; preserving %s for occ dev down: %w", directory, cleanupErr))
		}
	}()
	if err := exclusiveWrite(filepath.Join(directory, ".openclaw-development"), []byte(stateMarker), 0600); err != nil {
		return err
	}
	stateData, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := exclusiveWrite(filepath.Join(directory, "state.json"), stateData, 0600); err != nil {
		return err
	}
	admissionPath, err := prepareOpenShellAdmission(directory)
	if err != nil {
		return err
	}
	fmt.Fprintf(r.opts.Out, "Creating Kubernetes-only k3d cluster %s...\n", state.Cluster)
	clusterAttempted = true
	clusterArgs := []string{
		"cluster", "create", state.Cluster,
		"--image", openShellK3sImage,
		"--servers", "1", "--agents", "0",
		"--api-port", fmt.Sprintf("127.0.0.1:%d", kubernetesPort),
		"--port", fmt.Sprintf("127.0.0.1:%d:%d@loadbalancer", apiPort, developmentAPINodePort),
		"--volume", admissionPath + ":" + openShellAdmissionContainerPath + ":ro@server:0",
		"--k3s-arg", "--kube-apiserver-arg=admission-control-config-file=" + openShellAdmissionContainerPath + "@server:0",
		"--k3s-arg", "--tls-san=k3d-" + state.Cluster + "-serverlb@server:*",
		"--k3s-arg", fmt.Sprintf("--kubelet-arg=eviction-hard=memory.available<100Mi,nodefs.available<%d%%,nodefs.inodesFree<5%%,imagefs.available<%d%%,imagefs.inodesFree<5%%@server:*", threshold, threshold),
		"--kubeconfig-update-default=false", "--kubeconfig-switch-context=false",
	}
	if err := r.run(ctx, "k3d", clusterArgs...); err != nil {
		clusterCreationFailed = true
		return err
	}
	if err := r.writeKubeconfigs(ctx, state); err != nil {
		return err
	}
	r.env["KUBECONFIG"] = filepath.Join(directory, "kubeconfig")
	timeout := time.Duration(timeoutSeconds) * time.Second

	fmt.Fprintln(r.opts.Out, "Preparing pinned OpenShell development assets...")
	assets, err := r.prepareOpenShell(ctx, state, timeout)
	if err != nil {
		return err
	}
	runtimeImage, err := r.importRuntime(ctx, state)
	if err != nil {
		return err
	}
	controllerImage, err := r.importDevelopmentController(ctx, state)
	if err != nil {
		return err
	}
	postgresImage, err := r.importDevelopmentPostgres(ctx, state)
	if err != nil {
		return err
	}
	if err := r.ensureKubernetesNamespace(ctx, state.PlatformNamespace); err != nil {
		return err
	}
	fmt.Fprintf(r.opts.Out, "Installing OpenShell Gateway and OCE in Namespace %s...\n", state.PlatformNamespace)
	if err := r.installOpenShellGateway(ctx, state, assets, state.PlatformNamespace, timeout); err != nil {
		return err
	}
	if err := writeInstallation(state, runtimeImage, assets); err != nil {
		return err
	}
	if err := r.installKubernetesControlPlane(ctx, state, controllerImage, postgresImage, timeout); err != nil {
		return err
	}
	apiURL := fmt.Sprintf("http://127.0.0.1:%d", apiPort)
	if err := r.waitKubernetesAPI(ctx, apiURL, timeout); err != nil {
		return err
	}
	installation, client, err := r.copyAndVerifyKubernetesKey(ctx, state, controllerImage, apiURL, timeout)
	if err != nil {
		return err
	}
	keyWritten = true
	_, namespaceID, err := r.waitForOpenShellNamespace(ctx, timeout)
	if err != nil {
		return err
	}
	if err := waitForDevelopmentNamespace(ctx, client, namespaceID, timeout); err != nil {
		return err
	}
	fmt.Fprintf(r.opts.Out, "OpenClaw Enterprise development stack is ready.\nContainer engine: %s\nCompute Driver: Kubernetes\nSandbox Driver: openshell\nDeployment: Kubernetes only\nPlatform Namespace: %s\nAPI URL: %s\nInstallation ID: %s\nService key file: %s\nKubeconfig: %s\nKubernetes context: k3d-%s\n\nCleanup:\n  env OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell OCC_DEVELOPMENT_STATE_DIRECTORY=%s %s dev down\n", r.engine, state.PlatformNamespace, apiURL, installation, state.KeyPath, filepath.Join(directory, "kubeconfig"), state.Cluster, shellQuote(directory), shellQuote(filepath.Join(opts.Repository, "bin", "occ")))
	return nil
}

func (r *runner) importDevelopmentController(ctx context.Context, state *developmentState) (string, error) {
	image := r.setting("OCC_DEVELOPMENT_CONTROLLER_IMAGE", developmentController)
	if r.env["OCC_DEVELOPMENT_CONTROLLER_IMAGE"] != "" {
		if _, err := r.output(ctx, r.engine, "image", "inspect", image); err != nil {
			return "", fmt.Errorf("explicitly selected controller image must already exist locally: %s", image)
		}
	} else {
		base := r.setting("OCC_DEVELOPMENT_NODE_BASE_IMAGE", developmentNodeBase)
		if err := r.run(ctx, r.engine, "build", "--target", "runtime", "--build-arg", "NODE_BASE_IMAGE="+base, "--tag", image, "."); err != nil {
			return "", err
		}
	}
	return r.importDevelopmentImage(ctx, state, image)
}

func (r *runner) importDevelopmentPostgres(ctx context.Context, state *developmentState) (string, error) {
	image := r.setting("OCC_DEVELOPMENT_POSTGRES_IMAGE", developmentPostgres)
	if _, err := r.output(ctx, r.engine, "image", "inspect", image); err != nil {
		if err := r.run(ctx, r.engine, "pull", image); err != nil {
			return "", err
		}
	}
	return r.importDevelopmentImage(ctx, state, image)
}

func (r *runner) ensureKubernetesNamespace(ctx context.Context, namespace string) error {
	if _, err := r.output(ctx, "kubectl", "get", "namespace", namespace); err == nil {
		return nil
	}
	return r.run(ctx, "kubectl", "create", "namespace", namespace)
}

func randomDevelopmentSecret() (string, error) {
	data := make([]byte, 24)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func (r *runner) writeAndApply(ctx context.Context, state *developmentState, name string, resource any) error {
	data, err := json.Marshal(resource)
	if err != nil {
		return err
	}
	path := filepath.Join(state.directory, name+".json")
	if err := exclusiveWrite(path, data, 0600); err != nil {
		return err
	}
	return r.run(ctx, "kubectl", "apply", "-f", path)
}

func kubernetesMetadata(name, namespace string, labels map[string]string) map[string]any {
	return map[string]any{"name": name, "namespace": namespace, "labels": labels}
}

func (r *runner) installKubernetesControlPlane(ctx context.Context, state *developmentState, controllerImage, postgresImage string, timeout time.Duration) error {
	postgresPassword, err := randomDevelopmentSecret()
	if err != nil {
		return err
	}
	migrationPassword, err := randomDevelopmentSecret()
	if err != nil {
		return err
	}
	appPassword, err := randomDevelopmentSecret()
	if err != nil {
		return err
	}
	authSecret, err := randomDevelopmentSecret()
	if err != nil {
		return err
	}
	namespace := state.PlatformNamespace
	labels := map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}
	resources := map[string]any{"requests": map[string]string{"cpu": "100m", "memory": "128Mi"}, "limits": map[string]string{"cpu": "1", "memory": "1Gi"}}
	secret := map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata": kubernetesMetadata("postgres-bootstrap", namespace, labels),
		"stringData": map[string]string{
			"password": postgresPassword,
			"init.sql": fmt.Sprintf("CREATE ROLE occ_migrator LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nCREATE ROLE occ_app LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nGRANT CREATE ON DATABASE openclaw_enterprise TO occ_migrator;\nCREATE SCHEMA occ AUTHORIZATION occ_migrator;\nCREATE SCHEMA drizzle AUTHORIZATION occ_migrator;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;", migrationPassword, appPassword),
		},
	}
	if err := r.writeAndApply(ctx, state, "postgres-bootstrap", secret); err != nil {
		return err
	}
	for _, name := range []string{"postgres-data", "bootstrap-password"} {
		claim := map[string]any{
			"apiVersion": "v1", "kind": "PersistentVolumeClaim",
			"metadata": kubernetesMetadata(name, namespace, labels),
			"spec":     map[string]any{"accessModes": []string{"ReadWriteOnce"}, "storageClassName": "local-path", "resources": map[string]any{"requests": map[string]string{"storage": "1Gi"}}},
		}
		if err := r.writeAndApply(ctx, state, name, claim); err != nil {
			return err
		}
	}
	prepare := map[string]any{
		"apiVersion": "v1", "kind": "Pod", "metadata": kubernetesMetadata("bootstrap-password-prepare", namespace, labels),
		"spec": map[string]any{
			"restartPolicy": "Never", "automountServiceAccountToken": false,
			"securityContext": map[string]any{"runAsUser": 0, "runAsGroup": 0, "seccompProfile": map[string]string{"type": "RuntimeDefault"}},
			"containers": []any{map[string]any{
				"name": "prepare", "image": controllerImage, "imagePullPolicy": "Never",
				"command":         []string{"node", "-e", "const fs=require('node:fs');const p='/var/lib/openclaw/bootstrap';fs.chownSync(p,1000,1000);fs.chmodSync(p,0o700)"},
				"securityContext": map[string]any{"allowPrivilegeEscalation": false, "capabilities": map[string]any{"drop": []string{"ALL"}, "add": []string{"CHOWN", "FOWNER"}}},
				"resources":       resources, "volumeMounts": []any{map[string]any{"name": "bootstrap", "mountPath": "/var/lib/openclaw/bootstrap"}},
			}},
			"volumes": []any{map[string]any{"name": "bootstrap", "persistentVolumeClaim": map[string]string{"claimName": "bootstrap-password"}}},
		},
	}
	if err := r.writeAndApply(ctx, state, "bootstrap-password-prepare", prepare); err != nil {
		return err
	}
	if err := r.waitPodSucceeded(ctx, namespace, "bootstrap-password-prepare", timeout); err != nil {
		return err
	}
	postgres := map[string]any{
		"apiVersion": "v1", "kind": "Pod", "metadata": kubernetesMetadata("postgres", namespace, map[string]string{"app": "postgres", "app.kubernetes.io/managed-by": "openclaw-development"}),
		"spec": map[string]any{
			"securityContext": map[string]any{"runAsNonRoot": true, "runAsUser": 999, "runAsGroup": 999, "fsGroup": 999, "seccompProfile": map[string]string{"type": "RuntimeDefault"}},
			"containers": []any{map[string]any{
				"name": "postgres", "image": postgresImage, "imagePullPolicy": "Never", "resources": resources,
				"securityContext": map[string]any{"allowPrivilegeEscalation": false, "capabilities": map[string]any{"drop": []string{"ALL"}}},
				"env":             []any{map[string]string{"name": "POSTGRES_DB", "value": "openclaw_enterprise"}, map[string]any{"name": "POSTGRES_PASSWORD", "valueFrom": map[string]any{"secretKeyRef": map[string]string{"name": "postgres-bootstrap", "key": "password"}}}},
				"volumeMounts":    []any{map[string]any{"name": "data", "mountPath": "/var/lib/postgresql"}, map[string]any{"name": "init", "mountPath": "/docker-entrypoint-initdb.d", "readOnly": true}},
				"readinessProbe":  map[string]any{"exec": map[string]any{"command": []string{"pg_isready", "-U", "postgres", "-d", "openclaw_enterprise"}}, "initialDelaySeconds": 2, "periodSeconds": 2},
			}},
			"volumes": []any{map[string]any{"name": "data", "persistentVolumeClaim": map[string]string{"claimName": "postgres-data"}}, map[string]any{"name": "init", "secret": map[string]any{"secretName": "postgres-bootstrap", "items": []any{map[string]string{"key": "init.sql", "path": "init.sql"}}}}},
		},
	}
	if err := r.writeAndApply(ctx, state, "postgres", postgres); err != nil {
		return err
	}
	postgresService := map[string]any{
		"apiVersion": "v1", "kind": "Service", "metadata": kubernetesMetadata("postgres", namespace, labels),
		"spec": map[string]any{"selector": map[string]string{"app": "postgres"}, "ports": []any{map[string]any{"port": 5432}}},
	}
	if err := r.writeAndApply(ctx, state, "postgres-service", postgresService); err != nil {
		return err
	}
	if err := r.run(ctx, "kubectl", "-n", namespace, "wait", "--for=condition=Ready", "pod/postgres", "--timeout", timeout.String()); err != nil {
		return err
	}
	postgresIP, err := r.output(ctx, "kubectl", "-n", namespace, "get", "pod", "postgres", "-o", "jsonpath={.status.podIP}")
	if err != nil || len(postgresIP) == 0 {
		return fmt.Errorf("resolve PostgreSQL Pod IP: %w", err)
	}
	clusterIP, err := r.output(ctx, "kubectl", "-n", "default", "get", "endpoints", "kubernetes", "-o", "jsonpath={.subsets[0].addresses[0].ip}")
	if err != nil || len(clusterIP) == 0 {
		return fmt.Errorf("resolve Kubernetes API endpoint IP: %w", err)
	}
	clusterPortData, err := r.output(ctx, "kubectl", "-n", "default", "get", "endpoints", "kubernetes", "-o", "jsonpath={.subsets[0].ports[0].port}")
	if err != nil {
		return fmt.Errorf("resolve Kubernetes API endpoint port: %w", err)
	}
	clusterPort, err := strconv.Atoi(string(clusterPortData))
	if err != nil || clusterPort < 1 || clusterPort > 65535 {
		return fmt.Errorf("Kubernetes API endpoint reported an invalid port")
	}
	installationData, err := os.ReadFile(filepath.Join(state.directory, "installation.yaml"))
	if err != nil {
		return err
	}
	secrets := map[string]any{
		"apiVersion": "v1", "kind": "List", "items": []any{
			map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": kubernetesMetadata("occ-installation-startup", namespace, labels), "stringData": map[string]string{"installation.yaml": string(installationData)}},
			map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": kubernetesMetadata("occ-database", namespace, labels), "stringData": map[string]string{"application-url": fmt.Sprintf("postgresql://occ_app:%s@postgres.%s.svc.cluster.local:5432/openclaw_enterprise", appPassword, namespace), "migration-url": fmt.Sprintf("postgresql://occ_migrator:%s@postgres.%s.svc.cluster.local:5432/openclaw_enterprise", migrationPassword, namespace)}},
			map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": kubernetesMetadata("occ-auth", namespace, labels), "stringData": map[string]string{"secret": authSecret}},
		},
	}
	if err := r.writeAndApply(ctx, state, "oce-secrets", secrets); err != nil {
		return err
	}
	values := map[string]any{
		"images":       map[string]string{"controller": controllerImage},
		"installation": map[string]string{"name": "OpenShell development"},
		"auth":         map[string]string{"baseUrl": fmt.Sprintf("http://127.0.0.1:%d", state.APIPort)},
		"bootstrap":    map[string]any{"adminEmail": "admin@development.openclaw.invalid", "password": map[string]string{"claimName": "bootstrap-password"}},
		"database":     map[string]any{"cidrs": []string{string(postgresIP) + "/32"}},
		"cluster":      map[string]any{"cidrs": []string{string(clusterIP) + "/32"}, "port": clusterPort},
		"api":          map[string]any{"clients": []any{map[string]any{"namespace": namespace, "podLabels": map[string]string{"app.kubernetes.io/name": "occ-kubernetes-dev-client"}}}},
		"resources":    resources,
	}
	valuesData, err := json.Marshal(values)
	if err != nil {
		return err
	}
	valuesPath := filepath.Join(state.directory, "helm-values.json")
	if err := exclusiveWrite(valuesPath, valuesData, 0600); err != nil {
		return err
	}
	if err := r.run(ctx, "helm", "upgrade", "--install", "openclaw-enterprise", "deploy/helm/openclaw-enterprise", "--namespace", namespace, "--kubeconfig", filepath.Join(state.directory, "kubeconfig"), "--kube-context", "k3d-"+state.Cluster, "-f", valuesPath, "--wait", "--timeout", timeout.String()); err != nil {
		return err
	}
	return r.installDevelopmentAPIProxy(ctx, state, controllerImage, timeout)
}

func (r *runner) waitPodSucceeded(ctx context.Context, namespace, name string, timeout time.Duration) error {
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		phase, err := r.output(ctx, "kubectl", "-n", namespace, "get", "pod", name, "-o", "jsonpath={.status.phase}")
		if err != nil {
			return false, nil
		}
		if string(phase) == "Failed" {
			return false, fmt.Errorf("Pod %s failed", name)
		}
		return string(phase) == "Succeeded", nil
	})
}

func (r *runner) installDevelopmentAPIProxy(ctx context.Context, state *developmentState, controllerImage string, timeout time.Duration) error {
	namespace := state.PlatformNamespace
	labels := map[string]string{"app.kubernetes.io/name": "occ-kubernetes-dev-client", "app.kubernetes.io/managed-by": "openclaw-development"}
	bindings := map[string]any{
		"apiVersion": "v1", "kind": "List", "items": []any{
			developmentOpenShellWorkspaceRole(labels),
			developmentClusterRoleBinding("openclaw-development-tenant-worker", "openclaw-enterprise-openclaw-tenant-worker", namespace, "openclaw-enterprise-worker", labels),
			developmentClusterRoleBinding("openclaw-development-openshell-workspace-rbac", "openclaw-development-openshell-workspace-rbac", namespace, "openclaw-enterprise-worker", labels),
			developmentClusterRoleBinding("openclaw-development-tenant-configuration", "openclaw-enterprise-openclaw-tenant-configuration", namespace, "openclaw-enterprise-api", labels),
			developmentClusterRoleBinding("openclaw-development-tenant-secrets", "openclaw-enterprise-openclaw-tenant-api", namespace, "openclaw-enterprise-api", labels),
		},
	}
	if err := r.writeAndApply(ctx, state, "development-tenant-access", bindings); err != nil {
		return err
	}
	proxy := map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment", "metadata": kubernetesMetadata("occ-development-api-proxy", namespace, labels),
		"spec": map[string]any{
			"replicas": 1, "selector": map[string]any{"matchLabels": labels},
			"template": map[string]any{"metadata": map[string]any{"labels": labels}, "spec": map[string]any{
				"automountServiceAccountToken": false,
				"securityContext":              map[string]any{"runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 1000, "seccompProfile": map[string]string{"type": "RuntimeDefault"}},
				"containers": []any{map[string]any{
					"name": "proxy", "image": controllerImage, "imagePullPolicy": "Never",
					"command":         []string{"node", "-e", "const net=require('node:net');net.createServer(c=>{const u=net.connect(8080,'openclaw-enterprise-api');c.pipe(u);u.pipe(c);const close=()=>{c.destroy();u.destroy()};c.on('error',close);u.on('error',close)}).listen(8080,'0.0.0.0')"},
					"ports":           []any{map[string]any{"name": "http", "containerPort": 8080}},
					"readinessProbe":  map[string]any{"tcpSocket": map[string]any{"port": "http"}, "periodSeconds": 2},
					"securityContext": map[string]any{"allowPrivilegeEscalation": false, "capabilities": map[string]any{"drop": []string{"ALL"}}},
					"resources":       map[string]any{"requests": map[string]string{"cpu": "25m", "memory": "32Mi"}, "limits": map[string]string{"cpu": "250m", "memory": "128Mi"}},
				}},
			}},
		},
	}
	if err := r.writeAndApply(ctx, state, "api-proxy", proxy); err != nil {
		return err
	}
	service := map[string]any{
		"apiVersion": "v1", "kind": "Service", "metadata": kubernetesMetadata("occ-development-api", namespace, labels),
		"spec": map[string]any{"type": "NodePort", "selector": labels, "ports": []any{map[string]any{"name": "http", "port": 8080, "targetPort": "http", "nodePort": developmentAPINodePort}}},
	}
	if err := r.writeAndApply(ctx, state, "api-proxy-service", service); err != nil {
		return err
	}
	// The worker provisions Sandboxes; the API registers credential sources.
	controlPlaneClients := map[string]any{
		"matchLabels": map[string]string{
			"app.kubernetes.io/name":     "openclaw-enterprise",
			"app.kubernetes.io/instance": "openclaw-enterprise",
		},
		"matchExpressions": []any{map[string]any{
			"key": "app.kubernetes.io/component", "operator": "In", "values": []string{"api", "worker"},
		}},
	}
	gatewayLabels := map[string]string{
		"app.kubernetes.io/name":     "openshell",
		"app.kubernetes.io/instance": openShellGatewayService,
	}
	supervisorLabels := map[string]string{
		openShellManagedByLabel:    openShellManagedByValue,
		openShellBoundaryRoleLabel: openShellSupervisorRole,
	}
	port := []any{map[string]any{"protocol": "TCP", "port": 8080}}
	networkPolicies := map[string]any{
		"apiVersion": "v1", "kind": "List", "items": []any{
			map[string]any{
				"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": kubernetesMetadata("openclaw-enterprise-openshell-egress", namespace, labels),
				"spec": map[string]any{
					"podSelector": controlPlaneClients,
					"policyTypes": []string{"Egress"},
					"egress":      []any{map[string]any{"to": []any{map[string]any{"podSelector": map[string]any{"matchLabels": gatewayLabels}}}, "ports": port}},
				},
			},
			map[string]any{
				"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": kubernetesMetadata("openclaw-development-openshell-ingress", namespace, labels),
				"spec": map[string]any{
					"podSelector": map[string]any{"matchLabels": gatewayLabels},
					"policyTypes": []string{"Ingress"},
					"ingress": []any{map[string]any{
						"from": []any{
							map[string]any{"podSelector": controlPlaneClients},
							map[string]any{
								"namespaceSelector": map[string]any{
									"matchLabels":      map[string]string{openShellOperatorNamespaceLabel: openShellOperatorNamespaceValue},
									"matchExpressions": []any{map[string]any{"key": "openclaw.dev/namespace", "operator": "Exists"}},
								},
								"podSelector": map[string]any{"matchLabels": supervisorLabels},
							},
						},
						"ports": port,
					}},
				},
			},
		},
	}
	if err := r.writeAndApply(ctx, state, "openshell-network-policies", networkPolicies); err != nil {
		return err
	}
	return r.run(ctx, "kubectl", "-n", namespace, "rollout", "status", "deployment/occ-development-api-proxy", "--timeout", timeout.String())
}

func developmentOpenShellWorkspaceRole(labels map[string]string) map[string]any {
	return map[string]any{
		"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
		"metadata": map[string]any{"name": "openclaw-development-openshell-workspace-rbac", "labels": labels},
		"rules": []any{
			map[string]any{
				"apiGroups": []string{"rbac.authorization.k8s.io"},
				"resources": []string{"roles"},
				"verbs":     []string{"get", "list", "create", "patch", "delete"},
			},
			map[string]any{
				"apiGroups":     []string{"rbac.authorization.k8s.io"},
				"resources":     []string{"roles"},
				"resourceNames": []string{"openshell-workspace-sandbox"},
				"verbs":         []string{"bind", "escalate"},
			},
			map[string]any{
				"apiGroups": []string{"rbac.authorization.k8s.io"},
				"resources": []string{"rolebindings"},
				"verbs":     []string{"get", "list", "create", "patch", "delete"},
			},
		},
	}
}

func developmentClusterRoleBinding(name, role, namespace, account string, labels map[string]string) map[string]any {
	return map[string]any{
		"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
		"metadata": map[string]any{"name": name, "labels": labels},
		"roleRef":  map[string]string{"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": role},
		"subjects": []any{map[string]string{"kind": "ServiceAccount", "name": account, "namespace": namespace}},
	}
}

func (r *runner) waitKubernetesAPI(ctx context.Context, url string, timeout time.Duration) error {
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return poll(ctx, timeout, func(ctx context.Context) (bool, error) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/api/auth/session", nil)
		if err != nil {
			return false, err
		}
		response, err := client.Do(request)
		if err != nil {
			return false, nil
		}
		response.Body.Close()
		return response.StatusCode >= 200 && response.StatusCode < 300, nil
	})
}

func (r *runner) copyAndVerifyKubernetesKey(ctx context.Context, state *developmentState, controllerImage, url string, timeout time.Duration) (string, *occclient.Client, error) {
	labels := map[string]string{"app.kubernetes.io/managed-by": "openclaw-development"}
	reader := map[string]any{
		"apiVersion": "v1", "kind": "Pod", "metadata": kubernetesMetadata("bootstrap-key-reader", state.PlatformNamespace, labels),
		"spec": map[string]any{
			"restartPolicy": "Never", "automountServiceAccountToken": false,
			"securityContext": map[string]any{"runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000, "seccompProfile": map[string]string{"type": "RuntimeDefault"}},
			"containers": []any{map[string]any{
				"name": "reader", "image": controllerImage, "imagePullPolicy": "Never", "command": []string{"node", "-e", "setInterval(()=>{},1<<30)"},
				"securityContext": map[string]any{"allowPrivilegeEscalation": false, "capabilities": map[string]any{"drop": []string{"ALL"}}},
				"resources":       map[string]any{"requests": map[string]string{"cpu": "10m", "memory": "32Mi"}, "limits": map[string]string{"cpu": "100m", "memory": "64Mi"}},
				"volumeMounts":    []any{map[string]any{"name": "bootstrap", "mountPath": "/var/lib/openclaw/bootstrap", "readOnly": true}},
			}},
			"volumes": []any{map[string]any{"name": "bootstrap", "persistentVolumeClaim": map[string]string{"claimName": "bootstrap-password"}}},
		},
	}
	if err := r.writeAndApply(ctx, state, "bootstrap-key-reader", reader); err != nil {
		return "", nil, err
	}
	defer r.output(context.WithoutCancel(ctx), "kubectl", "-n", state.PlatformNamespace, "delete", "pod", "bootstrap-key-reader", "--ignore-not-found=true")
	if err := r.run(ctx, "kubectl", "-n", state.PlatformNamespace, "wait", "--for=condition=Ready", "pod/bootstrap-key-reader", "--timeout", timeout.String()); err != nil {
		return "", nil, err
	}
	data, err := r.output(ctx, "kubectl", "-n", state.PlatformNamespace, "exec", "bootstrap-key-reader", "--", "node", "-e", "process.stdout.write(require('node:fs').readFileSync('/var/lib/openclaw/bootstrap/initial-admin-service-key.json'))")
	if err != nil {
		return "", nil, err
	}
	var key struct {
		Meta struct {
			InstallationID string `json:"installationId"`
		} `json:"meta"`
		Data struct {
			Key string `json:"key"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &key); err != nil || key.Meta.InstallationID == "" || strings.TrimSpace(key.Data.Key) == "" {
		return "", nil, fmt.Errorf("bootstrap service key is missing its key or Installation ID")
	}
	temporary := filepath.Join(state.directory, "bootstrap-key-copy.json")
	if err := exclusiveWrite(temporary, data, 0600); err != nil {
		return "", nil, err
	}
	client, err := occclient.New(occclient.Config{URL: url, ServiceKeyFile: temporary, Timeout: 15 * time.Second})
	if err != nil {
		return "", nil, err
	}
	installation, err := client.GetInstallation()
	if err != nil {
		return "", nil, fmt.Errorf("Installation authorization failed: %w", err)
	}
	record, ok := installation.(map[string]any)
	if !ok || record["id"] != key.Meta.InstallationID {
		return "", nil, fmt.Errorf("Installation ID does not match the bootstrap service key")
	}
	if err := exclusiveWrite(state.KeyPath, data, 0600); err != nil {
		return "", nil, err
	}
	if err := os.Remove(temporary); err != nil {
		return "", nil, err
	}
	return key.Meta.InstallationID, client, nil
}
