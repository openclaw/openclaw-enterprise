package occdev

import (
	"context"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestResolvedComposeValidatesInheritedPublicationsAndFreezesInputs(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "0.0.0.0"} {
		t.Run(host, func(t *testing.T) {
			repository := t.TempDir()
			// PostgreSQL's publication and bind mount come from another file.
			// Validating only the unresolved top-level service misses both.
			files := map[string]string{
				"compose.yaml": `services:
  postgres:
    extends: {file: database.yaml, service: database}
  controller:
    image: example.invalid/controller:fixture
    ports: ["127.0.0.1:3100:3000"]
    env_file: runtime.env
    environment:
      LITERAL: "${LITERAL}"
    build: {context: .}
  worker-kubernetes:
    image: example.invalid/controller:fixture
`,
				"compose.kubernetes.yaml": "services: {}\n",
				"database.yaml":           "services:\n  database:\n    image: example.invalid/postgres:fixture\n    ports: [\"" + host + ":55432:5432\"]\n    volumes: [\"./init.sql:/init.sql:ro,Z\"]\n",
				"runtime.env":             "FROZEN=original\n",
				"init.sql":                "-- fixture\n",
			}
			for name, content := range files {
				if err := os.WriteFile(filepath.Join(repository, name), []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			r := &runner{opts: Options{Repository: repository}, env: map[string]string{"LITERAL": "literal-$VALUE"}}
			state := &developmentState{Repository: repository, ComposeProject: "occ-dev-config"}
			resolved, err := r.resolveCompose(context.Background(), state)
			if err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(resolved)
			if err != nil {
				t.Fatal(err)
			}
			_, err = AnalyzeCompose(data, "kubernetes")
			if host == "0.0.0.0" {
				if err == nil || !strings.Contains(err.Error(), "PostgreSQL port must publish only on loopback") {
					t.Fatalf("inherited public port escaped validation: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			services := resolved.(map[string]any)["services"].(map[string]any)
			postgres := services["postgres"].(map[string]any)
			if _, exists := postgres["extends"]; exists {
				t.Fatal("snapshot still depends on an extends source")
			}
			mount := postgres["volumes"].([]any)[0].(map[string]any)
			if mount["source"] != filepath.Join(repository, "init.sql") {
				t.Fatal("relocation would change the database initialization mount")
			}
			controller := services["controller"].(map[string]any)
			if controller["build"].(map[string]any)["context"] != repository {
				t.Fatal("relocation would change the build context")
			}
			if _, exists := controller["env_file"]; exists {
				t.Fatal("snapshot still depends on a mutable environment file")
			}
			if controller["environment"].(map[string]any)["FROZEN"] != "original" {
				t.Fatal("service environment was not resolved")
			}
			// Persisted values must survive the provider's second interpolation.
			snapshot, err := yaml.Marshal(escapeInterpolation(resolved))
			if err != nil || !strings.Contains(string(snapshot), "literal-$$VALUE") {
				t.Fatalf("literal environment value changed: %v", err)
			}
		})
	}
}
