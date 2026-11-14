package occdev

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/compose-spec/compose-go/v2/cli"
	"github.com/compose-spec/compose-go/v2/loader"
	"github.com/compose-spec/compose-go/v2/template"
)

// resolveCompose freezes the complete model before validation and relocation.
// podman-compose config does not expand extends, so its output cannot be used
// as either the publication/ownership boundary or a standalone saved snapshot.
func (r *runner) resolveCompose(ctx context.Context, state *developmentState) (any, error) {
	files := []string{"compose.yaml", "compose.kubernetes.yaml"}
	if state.BrowserPort != 0 {
		files = append(files, "compose.native-admin.yaml")
	}
	var envFiles []string
	for i := 0; i < len(r.opts.ComposeArgs); i++ {
		flag, value, inline := strings.Cut(r.opts.ComposeArgs[i], "=")
		if !inline {
			i++
			value = r.opts.ComposeArgs[i]
		}
		switch flag {
		case "-f", "--file":
			files = append(files, value)
		case "--env-file":
			envFiles = append(envFiles, value)
		}
	}
	for _, paths := range [][]string{files, envFiles} {
		for i, path := range paths {
			if !filepath.IsAbs(path) {
				paths[i] = filepath.Join(state.Repository, path)
			}
		}
	}
	environment := make([]string, 0, len(r.env))
	for key, value := range r.env {
		environment = append(environment, key+"="+value)
	}
	// Loader errors can contain interpolated credentials. The caller gets
	// a stage-specific error without configuration values, just like r.output.
	options, err := cli.NewProjectOptions(files,
		cli.WithName(state.ComposeProject), cli.WithWorkingDirectory(state.Repository),
		cli.WithEnv(environment), cli.WithEnvFiles(envFiles...), cli.WithDotEnv,
		cli.WithDefaultProfiles(), cli.WithDiscardEnvFile,
		cli.WithLoadOptions(func(options *loader.Options) {
			if options.Interpolate != nil {
				options.Interpolate.Substitute = func(value string, mapping template.Mapping) (string, error) {
					return template.SubstituteWithOptions(value, mapping, template.WithoutLogging)
				}
			}
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("could not load Compose environment files; check their paths and syntax")
	}
	project, err := options.LoadProject(ctx)
	if err != nil {
		return nil, fmt.Errorf("could not resolve Compose configuration; check file paths, required variables, and Compose syntax")
	}
	data, err := project.MarshalJSON()
	if err != nil {
		return nil, fmt.Errorf("could not encode resolved Compose configuration")
	}
	var rendered any
	if err := json.Unmarshal(data, &rendered); err != nil {
		return nil, fmt.Errorf("could not read resolved Compose configuration")
	}
	if r.engine == "podman" {
		// This profile manages independently networked containers. podman-compose
		// otherwise creates an unlabelled, empty-sharing Pod outside our ownership
		// inventory, which cannot be safely recovered by project labels.
		model := rendered.(map[string]any)
		settings, _ := model["x-podman"].(map[string]any)
		if settings == nil {
			settings = map[string]any{}
		}
		settings["in_pod"] = false
		model["x-podman"] = settings
	}
	return rendered, nil
}
