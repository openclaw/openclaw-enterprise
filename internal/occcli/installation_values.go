package occcli

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"
	"go.yaml.in/yaml/v3"
)

func (app *application) installationMigrateValuesCommand() *cobra.Command {
	var chart, values, namespace, release, out string
	cmd := &cobra.Command{
		Use: "migrate-values", Short: "Remove legacy bootstrap settings from a copy of local Helm values",
		Args: cobra.NoArgs, Annotations: map[string]string{outputFormatsAnnotation: "text"},
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !dns1123Label(namespace) || !helmReleaseName(release) || chart == "" || values == "" {
				return errors.New("provide an explicit release, Kubernetes namespace, local chart directory and values file")
			}
			if cmd.Flags().Changed("out") && (out == "" || out == "-" || os.IsPathSeparator(out[len(out)-1])) {
				return errors.New("--out must name a new local file")
			}
			data, err := readInstallationInput(values, 4<<20)
			if err != nil {
				return errors.New("installation values must be a readable regular file of at most 4 MiB")
			}
			converted, err := removeLegacyBootstrapValues(data)
			if err != nil {
				return err
			}
			info, err := os.Lstat(chart)
			if err != nil || !info.IsDir() {
				return errors.New("provide a local chart directory")
			}
			chartDir, err := canonicalValuesDirectory(chart)
			if err != nil {
				return errors.New("cannot resolve the local chart directory")
			}
			work, err := os.MkdirTemp("", "occ-values-")
			if err != nil {
				return errors.New("cannot create a private conversion directory")
			}
			defer os.RemoveAll(work)
			frozenChart, _, err := snapshotInstallationChart(chartDir, work)
			if err != nil {
				return err
			}
			original := filepath.Join(work, "original.yaml")
			if os.WriteFile(original, data, 0600) != nil {
				return errors.New("cannot snapshot the original values")
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), app.parsedTimeout)
			defer cancel()
			if _, err := resolveInstallationBootstrap(ctx, frozenChart, original, namespace, release); err != nil {
				return err
			}
			if converted == nil {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), "Values already omit the legacy bootstrap settings. No output file created.")
				return err
			}
			candidate := filepath.Join(work, "converted.yaml")
			if os.WriteFile(candidate, converted, 0600) != nil {
				return errors.New("cannot snapshot the converted values")
			}
			if err = compareInstallationValuesRenders(ctx, frozenChart, original, candidate, namespace, release); err != nil {
				return err
			}
			if out == "" {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), "Preview passed. Remove bootstrap.password and bootstrap.serviceKey where present. No files written. Repeat with --out to save a verified copy.")
				return err
			}
			if ctx.Err() != nil {
				return errors.New("conversion was interrupted before writing the output")
			}
			if err = writeConvertedInstallationValues(info, out, converted); err != nil {
				return err
			}
			if _, err := fmt.Fprintln(cmd.OutOrStdout(), "Wrote converted installation values to a new private file."); err != nil {
				return errors.New("the output file was written, but OCC could not print the confirmation")
			}
			return nil
		},
	}
	flags := cmd.Flags()
	flags.StringVar(&chart, "chart", "", "Local chart directory")
	flags.StringVar(&release, "release", "", "Helm release name")
	flags.StringVar(&namespace, "kube-namespace", "", "Kubernetes namespace of the release")
	flags.StringVar(&values, "values", "", "Original Helm values file")
	flags.StringVar(&out, "out", "", "New private output file (omit for preview)")
	for _, flag := range []string{"chart", "release", "kube-namespace", "values"} {
		_ = cmd.MarkFlagRequired(flag)
	}
	return cmd
}

var errAmbiguousValues = errors.New("conversion requires one unambiguous YAML mapping with unique string keys and without YAML anchors, aliases, merge keys or custom tags")

func parseInstallationValues(data []byte) (*yaml.Node, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var doc yaml.Node
	if decoder.Decode(&doc) != nil || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode ||
		decoder.Decode(new(yaml.Node)) != io.EOF || !unambiguousValuesNode(doc.Content[0]) {
		return nil, errAmbiguousValues
	}
	return doc.Content[0], nil
}

func unambiguousValuesNode(node *yaml.Node) bool {
	if node.Kind == yaml.AliasNode || node.Anchor != "" || node.Style&yaml.TaggedStyle != 0 {
		return false
	}
	if node.Kind == yaml.MappingNode {
		seen := make(map[string]bool, len(node.Content)/2)
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || key.Value == "<<" || seen[key.Value] {
				return false
			}
			// Older Helm YAML readers may treat these unquoted keys as booleans.
			if key.Style == 0 && slices.Contains([]string{"y", "yes", "n", "no", "on", "off"}, strings.ToLower(key.Value)) {
				return false
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if !unambiguousValuesNode(child) {
			return false
		}
	}
	return true
}

func removeLegacyBootstrapValues(data []byte) ([]byte, error) {
	root, err := parseInstallationValues(data)
	if err != nil {
		return nil, err
	}
	for i := 0; i < len(root.Content); i += 2 {
		if root.Content[i].Value != "bootstrap" {
			continue
		}
		bootstrap := root.Content[i+1]
		if bootstrap.Kind != yaml.MappingNode {
			return nil, errors.New("bootstrap must be a YAML mapping")
		}

		// Locate the keys with the YAML parser and retain the exact spelling and
		// layout of other values. Reparse the result to reject ambiguous edits.
		var lines [][]byte
		var retained []*yaml.Node
		for j := 0; j < len(bootstrap.Content); j += 2 {
			key := bootstrap.Content[j]
			if key.Value != "password" && key.Value != "serviceKey" {
				retained = append(retained, bootstrap.Content[j:j+2]...)
				continue
			}
			if lines == nil {
				lines = bytes.SplitAfter(data, []byte("\n"))
			}
			if bootstrap.Style&yaml.FlowStyle != 0 || !removeLegacyValuesLines(lines, key) {
				return nil, errors.New("legacy bootstrap settings must use simple block entries")
			}
		}
		if lines == nil {
			return nil, nil
		}
		bootstrap.Content = retained
		result := bytes.Join(lines, nil)
		reparsed, err := parseInstallationValues(result)
		if err != nil || !sameInstallationValues(root, reparsed) {
			return nil, errors.New("cannot remove the legacy bootstrap settings without changing other values")
		}
		return result, nil
	}
	return nil, nil
}

func removeLegacyValuesLines(lines [][]byte, key *yaml.Node) bool {
	start := key.Line - 1
	indent := strings.Repeat(" ", key.Column-1)
	if key.Style != 0 || start < 0 || start >= len(lines) || !bytes.HasPrefix(lines[start], []byte(indent+key.Value+":")) {
		return false
	}
	end := start + 1
	nested := []byte(indent + " ")
	for i := end; i < len(lines); i++ {
		line := lines[i]
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if !bytes.HasPrefix(line, nested) {
			break
		}
		end = i + 1
	}
	clear(lines[start:end])
	return true
}

func sameInstallationValues(a, b *yaml.Node) bool {
	return a.Kind == b.Kind && a.Tag == b.Tag && a.Style == b.Style && a.Value == b.Value &&
		slices.EqualFunc(a.Content, b.Content, sameInstallationValues)
}

func compareInstallationValuesRenders(ctx context.Context, chart, original, candidate, namespace, release string) error {
	// Direct Helm uses the supplied inputs. OCC also sets an attempt ID.
	for _, overrides := range [][]string{nil, {"--set-string", "installation.attemptId=" + strings.Repeat("a", 64)}} {
		var rendered [2]doctorBuffer
		for i, values := range []string{original, candidate} {
			// Include CRDs and the default hook output. Never forward Helm output.
			if err := renderInstallationChart(ctx, chart, values, namespace, release, &rendered[i], append(overrides, "--include-crds")...); err != nil {
				return err
			}
			if rendered[i].overflow {
				return errors.New("rendered manifests exceed the comparison limit")
			}
		}
		if !bytes.Equal(rendered[0].buf.Bytes(), rendered[1].buf.Bytes()) {
			return errors.New("removing legacy bootstrap settings would change the offline Helm render")
		}
	}
	return nil
}

// Resolve the original spelling, including symlinks before "..", even when
// the shell entered the working directory through a symlink.
func canonicalValuesDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) {
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		path = cwd + string(os.PathSeparator) + path
	}
	return filepath.EvalSymlinks(path)
}

func writeConvertedInstallationValues(chart os.FileInfo, path string, contents []byte) error {
	parent, name := filepath.Split(path)
	parent, err := canonicalValuesDirectory(parent)
	if err != nil {
		return errors.New("cannot locate the output directory")
	}
	// Path spellings can differ on case-insensitive filesystems. Private
	// values must never become a file in a chart Helm may package.
	for ancestor := parent; ; ancestor = filepath.Dir(ancestor) {
		info, err := os.Stat(ancestor)
		if err != nil {
			return errors.New("cannot verify the output directory")
		}
		if os.SameFile(chart, info) {
			return errors.New("output file must be outside the selected chart directory")
		}
		if ancestor == filepath.Dir(ancestor) {
			break
		}
	}
	dir, err := os.OpenRoot(parent)
	if err != nil {
		return errors.New("cannot open the output directory")
	}
	defer dir.Close()
	info, err := dir.Stat(".")
	if err != nil || info.Mode().Perm()&0022 != 0 {
		return errors.New("use an output directory that is not writable by other users")
	}

	// Publish a complete private file with a single link. An existing path,
	// including a dangling symlink, cannot be replaced.
	temp := ".occ-values-" + rand.Text()
	file, err := dir.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("cannot stage a private values file")
	}
	defer dir.Remove(temp)
	defer file.Close()
	if err = file.Chmod(0600); err != nil {
		return errors.New("cannot set private permissions on the values file")
	}
	if _, err = file.Write(contents); err != nil {
		return errors.New("cannot write the private values file")
	}
	if err = file.Sync(); err != nil {
		return errors.New("cannot sync the private values file")
	}
	if err = file.Close(); err != nil {
		return errors.New("cannot close the private values file")
	}
	if err = dir.Link(temp, name); err != nil {
		return errors.New("cannot publish the converted values at the new output path")
	}
	return nil
}
