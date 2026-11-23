package occcli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/bootstrapcredentials"
	"go.yaml.in/yaml/v3"
)

type installationBootstrapSecret struct {
	Name           string `json:"name"`
	PasswordKey    string `json:"passwordKey"`
	ServiceKeyKey  string `json:"serviceKeyKey"`
	InputDirectory string `json:"inputDirectory"`
}

// Resolve through Helm itself, including chart defaults and supplied overrides.
// Generated credentials require the supported fresh-only hook, never an older
// chart that can report success after merely verifying an existing Installation.
func resolveInstallationBootstrap(ctx context.Context, chart, values, namespace, release string) (installationBootstrapSecret, error) {
	var selection installationBootstrapSecret
	command := exec.CommandContext(ctx, "helm", "template", release, chart, "--namespace", namespace, "--values", values, "--show-only", "templates/jobs.yaml")
	var out doctorBuffer
	command.Stdout = &out
	command.WaitDelay = time.Second
	if command.Run() != nil || out.overflow {
		return selection, errors.New("cannot resolve bootstrap inputs from the selected chart; run offline helm template with protected diagnostics")
	}
	var job struct {
		Kind string `yaml:"kind"`
		Spec struct {
			Template struct {
				Spec struct {
					Containers []struct {
						Name string   `yaml:"name"`
						Args []string `yaml:"args"`
					} `yaml:"containers"`
					InitContainers []struct {
						Name string   `yaml:"name"`
						Args []string `yaml:"args"`
					} `yaml:"initContainers"`
					Volumes []struct {
						Name   string `yaml:"name"`
						Secret *struct {
							SecretName string `yaml:"secretName"`
							Items      []struct {
								Key  string `yaml:"key"`
								Path string `yaml:"path"`
							} `yaml:"items"`
						} `yaml:"secret"`
					} `yaml:"volumes"`
				} `yaml:"spec"`
			} `yaml:"template"`
		} `yaml:"spec"`
	}
	decoder := yaml.NewDecoder(bytes.NewReader(out.buf.Bytes()))
	if decoder.Decode(&job) != nil || job.Kind != "Job" {
		return selection, errors.New("generated credentials require the supported initialization Job")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return selection, errors.New("expected exactly one initialization Job")
	}
	fresh, empty := false, false
	for _, c := range job.Spec.Template.Spec.Containers {
		if c.Name == "bootstrap" && slices.Contains(c.Args, "scripts/bootstrap-installation.mjs") && slices.Contains(c.Args, "--require-fresh") {
			fresh = true
		}
	}
	for _, c := range job.Spec.Template.Spec.InitContainers {
		if c.Name == "migration" && slices.Contains(c.Args, "--expect-empty") {
			empty = true
		}
	}
	if !fresh || !empty {
		return selection, errors.New("generated credentials require fresh-only bootstrap and empty-database migration; use the matching chart")
	}
	for _, v := range job.Spec.Template.Spec.Volumes {
		if v.Name != "bootstrap-credentials" || v.Secret == nil {
			continue
		}
		selection.Name = v.Secret.SecretName
		for _, item := range v.Secret.Items {
			switch item.Path {
			case "admin-password":
				selection.PasswordKey = item.Key
			case "admin-service-key":
				selection.ServiceKeyKey = item.Key
			}
		}
	}
	nameRule := regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
	keyRule := regexp.MustCompile(`^[-._a-zA-Z0-9]+$`)
	if len(selection.Name) > 253 || !nameRule.MatchString(selection.Name) || len(selection.PasswordKey) > 253 || !keyRule.MatchString(selection.PasswordKey) || len(selection.ServiceKeyKey) > 253 || !keyRule.MatchString(selection.ServiceKeyKey) || selection.PasswordKey == selection.ServiceKeyKey {
		return selection, errors.New("chart must select a valid dedicated bootstrap Secret and two distinct keys")
	}
	return selection, nil
}

func requireAbsentBootstrapSecret(ctx context.Context, config, kctx, namespace, name string) error {
	command := exec.CommandContext(ctx, "kubectl", "--kubeconfig", config, "--context", kctx, "--namespace", namespace, "get", "secret", name, "--ignore-not-found", "--output=name")
	command.Env = append(os.Environ(), "KUBECTL_KUBERC=false")
	var out doctorBuffer
	command.Stdout = &out
	command.WaitDelay = time.Second
	if command.Run() != nil || out.overflow {
		return errors.New("cannot establish that the bootstrap Secret is absent; no credentials generated")
	}
	if strings.TrimSpace(out.buf.String()) != "" {
		return errors.New("bootstrap Secret already exists; preserve and reconcile its original attempt, or explicitly select --bootstrap-credentials=existing for deliberately provisioned inputs")
	}
	return nil
}

func prepareInstallationBootstrap(ctx context.Context, output io.Writer, config, kctx, namespace, receipt, attempt string, selection installationBootstrapSecret) error {
	root := os.Getenv("XDG_STATE_HOME")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		root = filepath.Join(home, ".local", "state")
	}
	if !filepath.IsAbs(root) {
		return errors.New("XDG_STATE_HOME must be absolute")
	}
	parent := filepath.Join(root, "occ", "installation-credentials")
	if err := makeBootstrapStateDirectory(parent); err != nil {
		return err
	}
	selection.InputDirectory = filepath.Join(parent, attempt)
	if err := os.Mkdir(selection.InputDirectory, 0700); err != nil {
		return err
	}
	if err := os.Chmod(selection.InputDirectory, 0700); err != nil {
		return err
	}
	if err := syncBootstrapDirectory(parent); err != nil {
		return err
	}
	if err := writeInstallationRecord(receipt, "bootstrap-secret.json", selection); err != nil {
		return err
	}
	inputs, err := bootstrapcredentials.Prepare(selection.InputDirectory, "")
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(output, "Bootstrap recovery inputs retained in %s. These prepared credentials are not yet authenticated.\n", selection.InputDirectory); err != nil {
		return err
	}
	password, err := readInstallationInput(inputs.PasswordPath, 4096)
	if err != nil {
		return err
	}
	key, err := readInstallationInput(inputs.ServiceKeyPath, 4096)
	if err != nil {
		return err
	}
	data := map[string]string{selection.PasswordKey: base64.StdEncoding.EncodeToString(password), selection.ServiceKeyKey: base64.StdEncoding.EncodeToString(key)}
	encoded, err := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]string{"name": selection.Name, "namespace": namespace}, "type": "Opaque", "data": data})
	if err != nil {
		return err
	}
	// Send the fixed core/v1 create through stdin. The API server owns admission
	// and validation; no credential values appear in argv or a manifest file.
	// Persist before dispatch. Lost responses must not authorize a replacement create.
	if err = writeInstallationRecord(receipt, "bootstrap-secret-dispatch.json", map[string]string{"outcome": "unknown"}); err != nil {
		return err
	}
	create := exec.CommandContext(ctx, "kubectl", "--kubeconfig", config, "--context", kctx, "create", "--raw=/api/v1/namespaces/"+namespace+"/secrets", "-f", "-")
	create.Stdin = bytes.NewReader(encoded)
	create.Env = append(os.Environ(), "KUBECTL_KUBERC=false")
	var response doctorBuffer
	create.Stdout = &response
	create.WaitDelay = time.Second
	if create.Run() != nil || response.overflow {
		return errors.New("bootstrap Secret creation is unconfirmed; preserve recovery inputs and reconcile this receipt before another install (an existing Secret is never overwritten; use existing mode only for deliberately provisioned inputs)")
	}
	var observed struct {
		APIVersion, Kind string
		Metadata         struct{ Name, Namespace, UID string }
		Data             map[string]string
	}
	if json.Unmarshal(response.buf.Bytes(), &observed) != nil || observed.APIVersion != "v1" || observed.Kind != "Secret" || observed.Metadata.Name != selection.Name || observed.Metadata.Namespace != namespace || observed.Metadata.UID == "" || observed.Data[selection.PasswordKey] != data[selection.PasswordKey] || observed.Data[selection.ServiceKeyKey] != data[selection.ServiceKeyKey] {
		return errors.New("bootstrap Secret response could not be verified; preserve recovery inputs and reconcile this receipt before another install")
	}
	return writeInstallationRecord(receipt, "bootstrap-secret-result.json", map[string]string{"uid": observed.Metadata.UID})
}

// Sync each new directory entry without requiring read access to unrelated
// ancestors above the existing state directory. Concurrent directory creation
// refuses this attempt before any cluster write rather than adopting its state.
func makeBootstrapStateDirectory(path string) error {
	var missing []string
	for current := path; ; current = filepath.Dir(current) {
		if _, err := os.Stat(current); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		missing = append(missing, current)
	}
	for i := len(missing) - 1; i >= 0; i-- {
		if err := os.Mkdir(missing[i], 0700); err != nil {
			return err
		}
		if err := syncBootstrapDirectory(filepath.Dir(missing[i])); err != nil {
			return err
		}
	}
	return nil
}

func syncBootstrapDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := dir.Sync()
	closeErr := dir.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

// Handoff exposes only progress and names, never reads the recovery directory.
func installationBootstrapProgress(receipt string) (string, error) {
	var selection installationBootstrapSecret
	if err := readInstallationRecord(receipt, "bootstrap-secret.json", &selection); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	var result struct {
		UID string `json:"uid"`
	}
	if err := readInstallationRecord(receipt, "bootstrap-secret-result.json", &result); err == nil && result.UID != "" {
		return "Bootstrap Secret: creation confirmed; local credentials still require authenticated verification.\n", nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return "Bootstrap Secret: preparation or creation unconfirmed; preserve recovery inputs and reconcile the original attempt before another install.\n", nil
}
