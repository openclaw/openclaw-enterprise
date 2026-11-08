package occcli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const installationAttemptAnnotation = "openclaw.dev/installation-attempt"

// Intent is immutable. Outcomes are separate files so a lost client cannot turn
// an unknown dispatch into permission to replay it.
type installationIntent struct {
	Version   int    `json:"version"`
	Operation string `json:"operation"`

	Attempt       string `json:"attempt"`
	CreatedAt     string `json:"createdAt"`
	ClusterSHA256 string `json:"clusterSha256"`
	Namespace     string `json:"namespace"`
	Release       string `json:"release"`
	ChartSHA256   string `json:"chartSha256"`
	ValuesSHA256  string `json:"valuesSha256"`
}

type installationJobReceipt struct {
	Attempt string `json:"attempt"`
	UID     string `json:"uid"`
}

func (app *application) installationInstallCommand() *cobra.Command {
	var config, kctx, namespace, release, chart, values, receipt string
	var wait time.Duration
	cmd := &cobra.Command{
		Use: "install", Short: "Install once with a durable initialization receipt",
		Args: cobra.NoArgs, Annotations: map[string]string{outputFormatsAnnotation: "text"},
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(config) == "" || strings.TrimSpace(kctx) == "" || !dns1123Label(namespace) || !helmReleaseName(release) || chart == "" || values == "" || receipt == "" || wait <= 0 || wait > 24*time.Hour {
				return errors.New("provide explicit target, local chart, values, new receipt directory and a wait timeout between 0 and 24h")
			}
			// Helm environment overrides can redirect both the release lookup and
			// install, or substitute another identity or storage for the release.
			for _, setting := range os.Environ() {
				key, value, _ := strings.Cut(setting, "=")
				if value != "" && (strings.HasPrefix(strings.ToUpper(key), "HELM_KUBE") || (strings.EqualFold(key, "HELM_DRIVER") && value != "secret" && value != "secrets")) {
					return errors.New("unset Helm Kubernetes overrides and use the default Secret release storage before installing")
				}
			}
			work, err := os.MkdirTemp("", "occ-install-")
			if err != nil {
				return err
			}
			defer os.RemoveAll(work)
			preflight, cancel := context.WithTimeout(cmd.Context(), app.parsedTimeout)
			defer cancel()
			frozenConfig, cluster, err := snapshotInstallationConfig(preflight, config, kctx, work)
			if err != nil {
				return err
			}
			frozenChart, chartHash, err := snapshotInstallationChart(chart, work)
			if err != nil {
				return err
			}
			data, err := readInstallationInput(values, 4<<20)
			if err != nil {
				return errors.New("installation values must be a readable regular file of at most 4 MiB")
			}
			frozenValues := filepath.Join(work, "values.yaml")
			if err = os.WriteFile(frozenValues, data, 0600); err != nil {
				return err
			}
			// Reading all release states catches failed and pending installs too. Helm
			// itself still arbitrates a concurrent install after this point-in-time read.
			var releases doctorBuffer
			list := exec.CommandContext(preflight, "helm", "list", "--all", "--filter", "^"+regexp.QuoteMeta(release)+"$", "--output=json", "--namespace", namespace, "--kubeconfig", frozenConfig, "--kube-context", kctx)
			list.Stdout = &releases
			list.WaitDelay = time.Second
			if err = list.Run(); err != nil {
				return errors.New("cannot establish that the Helm release is unused; no installation dispatched")
			}
			var existing []json.RawMessage
			if json.Unmarshal(releases.buf.Bytes(), &existing) != nil || existing == nil || len(existing) != 0 {
				return errors.New("Helm release is not confirmed unused; preserve and reconcile the original attempt")
			}
			var attempt [32]byte
			if _, err := rand.Read(attempt[:]); err != nil {
				return err
			}
			intent := installationIntent{Version: 1, Operation: "helm-install", Attempt: hex.EncodeToString(attempt[:]), CreatedAt: time.Now().UTC().Format(time.RFC3339), ClusterSHA256: cluster, Namespace: namespace, Release: release, ChartSHA256: chartHash, ValuesSHA256: installationDigest(data)}
			if err = os.Mkdir(receipt, 0700); err != nil {
				return errors.New("receipt directory must be new; never reuse an installation receipt")
			}
			if err = writeInstallationRecord(receipt, "intent.json", intent); err != nil {
				return err
			}
			parent, err := os.Open(filepath.Dir(filepath.Clean(receipt)))
			if err != nil {
				return err
			}
			err = parent.Sync()
			_ = parent.Close()
			if err != nil {
				return err
			}
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "Installation intent persisted in %s. An interrupted dispatch remains unknown; do not repeat install.\n", receipt); err != nil {
				return fmt.Errorf("cannot write installation receipt path to stdout (intent preserved in %q, no installation dispatched): %w", receipt, err)
			}
			// Persist before Start: even a crash between these operations stays unknown.
			if err = writeInstallationRecord(receipt, "dispatch.json", map[string]string{"outcome": "unknown"}); err != nil {
				return err
			}
			runCtx := cmd.Context()
			install := exec.CommandContext(runCtx, "helm", "install", release, frozenChart, "--kubeconfig", frozenConfig, "--kube-context", kctx, "--namespace", namespace, "--values", frozenValues, "--set-string", "installation.attemptId="+intent.Attempt, "--wait", "--timeout", wait.String())
			// Helm/auth-plugin diagnostics may contain sensitive values. Keep them out
			// of the receipt and terminal; operator diagnosis uses the named Job reader.
			install.WaitDelay = time.Second
			err = install.Start()
			observeCtx, stopObserving := context.WithCancel(runCtx)
			observed := make(chan error, 1)
			if err == nil {
				go func() { observed <- observeInstallationJob(observeCtx, frozenConfig, kctx, intent, receipt) }()
				err = install.Wait()
			} else {
				observed <- nil
			}
			stopObserving()
			observationErr := <-observed
			outcome := "unknown"
			if err == nil {
				outcome = "succeeded"
			} else {
				var exit *exec.ExitError
				if errors.As(err, &exit) && exit.ExitCode() > 0 && runCtx.Err() == nil {
					outcome = "failed"
				}
			}
			if saveErr := writeInstallationRecord(receipt, "helm-result.json", map[string]string{"outcome": outcome}); saveErr != nil {
				return saveErr
			}
			if observationErr != nil {
				return observationErr
			}
			_, uid, receiptErr := loadInstallationReceipt(receipt, namespace, release)
			if receiptErr != nil {
				return receiptErr
			}
			finalCtx, done := context.WithTimeout(cmd.Context(), app.parsedTimeout)
			defer done()
			result := readInstallationAttempt(finalCtx, frozenConfig, kctx, intent, uid)
			fmt.Fprintf(cmd.OutOrStdout(), "Helm outcome: %s.\n%s\nUse installation doctor or plan with --receipt and the same explicit target. Do not replay an uncertain installation.\n", outcome, result.message)
			if err != nil {
				return &ExitStatusError{Code: 1}
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&config, "kubeconfig", "", "Trusted kubeconfig file")
	f.StringVar(&kctx, "context", "", "Kubernetes context in that file")
	f.StringVar(&namespace, "kube-namespace", "", "Kubernetes namespace of the release")
	f.StringVar(&release, "release", "", "New Helm release name")
	f.StringVar(&chart, "chart", "", "Local chart directory or archive (snapshotted before install)")
	f.StringVar(&values, "values", "", "Reviewed Helm values file (snapshotted before install)")
	f.StringVar(&receipt, "receipt", "", "New private directory for durable attempt records")
	f.DurationVar(&wait, "wait-timeout", 5*time.Minute, "Helm wait timeout (maximum 24h)")
	for _, name := range []string{"kubeconfig", "context", "kube-namespace", "release", "chart", "values", "receipt"} {
		_ = cmd.MarkFlagRequired(name)
	}
	return cmd
}

func installationDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// A private, flattened snapshot keeps the selected connection and credentials
// together. Only the public connection object's digest survives in the receipt.
func snapshotInstallationConfig(ctx context.Context, config, kctx, work string) (string, string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "--kubeconfig="+config, "--context="+kctx, "config", "view", "--minify", "--flatten", "--raw", "--output=json")
	cmd.Env = append(os.Environ(), "KUBECTL_KUBERC=false")
	var out doctorBuffer
	cmd.Stdout = &out
	cmd.WaitDelay = time.Second
	if cmd.Run() != nil || out.overflow {
		return "", "", errors.New("cannot resolve trusted Kubernetes target")
	}
	var parsed struct {
		Clusters []struct {
			Cluster map[string]any `json:"cluster"`
		} `json:"clusters"`
	}
	if json.Unmarshal(out.buf.Bytes(), &parsed) != nil || len(parsed.Clusters) != 1 {
		return "", "", errors.New("kubeconfig did not select exactly one cluster")
	}
	if server, ok := parsed.Clusters[0].Cluster["server"].(string); !ok || strings.TrimSpace(server) == "" {
		return "", "", errors.New("kubeconfig requires an explicit cluster server")
	}
	connection, err := json.Marshal(parsed.Clusters[0].Cluster)
	if err != nil {
		return "", "", err
	}
	path := filepath.Join(work, "kubeconfig.json")
	if err = os.WriteFile(path, out.buf.Bytes(), 0600); err != nil {
		return "", "", err
	}
	return path, installationDigest(connection), nil
}

// Copy only regular chart files; symlinks would reintroduce mutable inputs or
// escape the selected chart. Hash paths and bytes with unambiguous boundaries.
func snapshotInstallationChart(source, work string) (string, string, error) {
	info, err := os.Lstat(source)
	if err != nil {
		return "", "", errors.New("cannot read local chart")
	}
	destination := filepath.Join(work, "chart")
	if !info.IsDir() {
		destination += ".tgz"
	}
	workInfo, err := os.Stat(work)
	if err != nil {
		return "", "", err
	}
	hash := sha256.New()
	total := int64(0)
	err = filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, rel)
		if entry.IsDir() {
			// Never package the private kubeconfig or recursively copy the
			// snapshot when TMPDIR is inside the selected chart.
			info, err := entry.Info()
			if err != nil || os.SameFile(info, workInfo) {
				return errors.New("temporary directory inside chart")
			}
			return os.MkdirAll(target, 0700)
		}
		if !entry.Type().IsRegular() {
			return errors.New("chart must contain only regular files and directories")
		}
		data, err := readInstallationInput(path, (64<<20)-total)
		if err != nil {
			return err
		}
		total += int64(len(data))
		if total > 64<<20 {
			return errors.New("chart exceeds 64 MiB")
		}
		fmt.Fprintf(hash, "%d:%s:%d:", len(rel), rel, len(data))
		_, _ = hash.Write(data)
		return os.WriteFile(target, data, 0600)
	})
	if err != nil {
		return "", "", errors.New("cannot snapshot chart; require regular local files totaling at most 64 MiB")
	}
	return destination, hex.EncodeToString(hash.Sum(nil)), nil
}

// Link an fsynced temporary file into place without replacing an existing
// record, then sync the directory. Readers see either a complete record or none.
func writeInstallationRecord(directory, name string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".record-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(append(data, '\n')); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Link(file.Name(), filepath.Join(directory, name)); err != nil {
		return err
	}
	dir, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func readInstallationRecord(directory, name string, target any) error {
	path := filepath.Join(directory, name)
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 16384 {
		return errors.New("receipt record must be a private regular file no larger than 16 KiB")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	dec := json.NewDecoder(io.LimitReader(file, 16385))
	dec.DisallowUnknownFields()
	if err = dec.Decode(target); err != nil {
		return errors.New("invalid installation receipt")
	}
	if err = dec.Decode(new(any)); err != io.EOF {
		return errors.New("invalid installation receipt")
	}
	return nil
}

func loadInstallationReceipt(directory, namespace, release string) (installationIntent, string, error) {
	var intent installationIntent
	info, err := os.Lstat(filepath.Clean(directory))
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return intent, "", errors.New("receipt must be a private directory")
	}
	if err := readInstallationRecord(directory, "intent.json", &intent); err != nil {
		return intent, "", err
	}
	digest := regexp.MustCompile(`^[a-f0-9]{64}$`)
	if intent.Version != 1 || intent.Operation != "helm-install" || !digest.MatchString(intent.Attempt) || !digest.MatchString(intent.ClusterSHA256) || !digest.MatchString(intent.ChartSHA256) || !digest.MatchString(intent.ValuesSHA256) || intent.Namespace != namespace || intent.Release != release {
		return intent, "", errors.New("receipt does not match the selected installation target or supported format")
	}
	var job installationJobReceipt
	err = readInstallationRecord(directory, "job.json", &job)
	if err != nil && !os.IsNotExist(err) {
		return intent, "", err
	}
	if err == nil && (job.Attempt != intent.Attempt || job.UID == "") {
		return intent, "", errors.New("invalid installation Job receipt")
	}
	return intent, job.UID, nil
}

func readInstallationOutcome(directory string) (string, error) {
	var result struct {
		Outcome string `json:"outcome"`
	}
	err := readInstallationRecord(directory, "helm-result.json", &result)
	if errors.Is(err, os.ErrNotExist) {
		return "unknown", nil
	}
	if err != nil {
		return "", err
	}
	switch result.Outcome {
	case "unknown", "succeeded", "failed":
		return result.Outcome, nil
	default:
		return "", errors.New("invalid Helm outcome record")
	}
}

func readInstallationAttempt(ctx context.Context, config, kctx string, intent installationIntent, uid string) initializationResult {
	name := initializationJobName(intent.Release)
	return readInitializationWithAttempt(ctx, config, kctx, intent.Namespace, name, intent.Release, uid, intent.Attempt)
}

func readInstallationInput(path string, limit int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("input must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("input must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("input too large")
	}
	return data, nil
}

// Capture the first recognized Job while Helm is still waiting. Stop after one
// UID: a replacement can never update the original receipt.
func observeInstallationJob(ctx context.Context, config, kctx string, intent installationIntent, directory string) error {
	for {
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		result := readInstallationAttempt(readCtx, config, kctx, intent, "")
		cancel()
		if result.captureUID != "" {
			return writeInstallationRecord(directory, "job.json", installationJobReceipt{Attempt: intent.Attempt, UID: result.captureUID})
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(500 * time.Millisecond):
		}
	}
}
