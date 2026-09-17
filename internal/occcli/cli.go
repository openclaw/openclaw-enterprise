package occcli

import (
	"cmp"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
	"go.yaml.in/yaml/v3"
)

const defaultTimeoutSeconds = "30"

// Version is replaced with a release version when distribution packaging is added.
var Version = "dev"

type application struct {
	out            io.Writer
	url            string
	serviceKeyFile string
	caBundle       string
	timeoutSeconds string
	namespace      string
	output         string
	parsedTimeout  time.Duration
}

type column struct {
	title string
	key   string
}

// New builds the OCC domain command tree.
func New(out, errOut io.Writer) *cobra.Command {
	app := &application{out: out}
	command := &cobra.Command{
		Use:           "occ",
		Short:         "Manage OpenClaw Control Plane resources",
		Version:       Version,
		SilenceErrors: true,
		SilenceUsage:  true,
		Args:          cobra.NoArgs,
		PersistentPreRunE: func(_ *cobra.Command, _ []string) error {
			return app.validateOptions()
		},
	}
	command.SetOut(out)
	command.SetErr(errOut)
	command.SetVersionTemplate("occ {{.Version}}\n")

	flags := command.PersistentFlags()
	flags.StringVar(&app.url, "url", os.Getenv("OCC_URL"), "OCC endpoint URL")
	flags.StringVar(
		&app.serviceKeyFile,
		"service-key-file",
		os.Getenv("OCC_SERVICE_KEY_FILE"),
		"Bootstrap or service-key response file",
	)
	flags.StringVar(
		&app.caBundle,
		"ca-bundle",
		os.Getenv("OCC_CA_BUNDLE"),
		"Additional PEM trust bundle for the OCC endpoint",
	)
	flags.StringVar(
		&app.timeoutSeconds,
		"timeout-seconds",
		cmp.Or(os.Getenv("OCC_TIMEOUT_SECONDS"), defaultTimeoutSeconds),
		"Request timeout in seconds",
	)
	flags.StringVar(
		&app.namespace,
		"namespace",
		os.Getenv("OCC_NAMESPACE"),
		"Namespace scope for Configuration and Agent operations",
	)
	flags.StringVarP(&app.output, "output", "o", "table", "Output format: table, json, or yaml")

	command.AddCommand(
		app.installationCommand(),
		app.namespaceCommand(),
		app.configurationCommand(),
		app.agentCommand(),
		developmentCommand(),
	)
	return command
}

func (app *application) installationCommand() *cobra.Command {
	command := commandGroup("installation", "Inspect the singleton Installation")
	command.AddCommand(&cobra.Command{
		Use:   "get",
		Short: "Show the Installation",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			installation, err := client.GetInstallation()
			if err != nil {
				return err
			}
			return app.printItems(installation, false, []column{
				{title: "ID", key: "id"},
				{title: "NAME", key: "name"},
				{title: "CREATED", key: "createdAt"},
			})
		},
	})
	return command
}

func (app *application) namespaceCommand() *cobra.Command {
	command := commandGroup("namespace", "Manage Namespaces")

	var existingNamespace string
	create := &cobra.Command{
		Use:   "create NAME",
		Short: "Create a Namespace",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespace, err := client.CreateNamespace(args[0], existingNamespace)
			if err != nil {
				return err
			}
			return app.printNamespace(namespace, false)
		},
	}
	create.Flags().StringVar(
		&existingNamespace,
		"existing-namespace",
		"",
		"Adopt this existing Kubernetes namespace",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "List authorized Namespaces",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespaces, err := client.ListNamespaces()
			if err != nil {
				return err
			}
			return app.printNamespace(namespaces, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespace, err := client.GetNamespace(args[0])
			if err != nil {
				return err
			}
			return app.printNamespace(namespace, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Begin deleting an empty Namespace",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespace, err := client.DeleteNamespace(args[0])
			if err != nil {
				return err
			}
			return app.printNamespace(namespace, false)
		},
	}

	command.AddCommand(create, list, get, deleteCommand)
	return command
}

func (app *application) configurationCommand() *cobra.Command {
	command := commandGroup("configuration", "Manage Configurations in the selected Namespace")

	var createFile string
	create := &cobra.Command{
		Use:   "create",
		Short: "Create a Configuration from a JSON document",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			body, err := readJSON(createFile)
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			configuration, err := client.CreateConfiguration(namespace, body)
			if err != nil {
				return err
			}
			return app.printConfiguration(configuration)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Configuration",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			configuration, err := client.GetConfiguration(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printConfiguration(configuration)
		},
	}

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID",
		Short: "Update a Configuration from a JSON document",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			body, err := readJSON(updateFile)
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			configuration, err := client.UpdateConfiguration(namespace, args[0], body)
			if err != nil {
				return err
			}
			return app.printConfiguration(configuration)
		},
	}
	update.Flags().StringVar(&updateFile, "file", "", "JSON document path")
	_ = update.MarkFlagRequired("file")

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete an unreferenced Configuration",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			if err := client.DeleteConfiguration(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("configuration", args[0])
		},
	}

	command.AddCommand(create, get, update, deleteCommand)
	return command
}

func (app *application) agentCommand() *cobra.Command {
	command := commandGroup("agent", "Manage Agents in the selected Namespace")

	var createFile string
	create := &cobra.Command{
		Use:   "create",
		Short: "Create an Agent from a JSON document",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			body, err := readJSON(createFile)
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			agent, err := client.CreateAgent(namespace, body)
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	list := &cobra.Command{
		Use:   "list",
		Short: "List Agents",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			agents, err := client.ListAgents(namespace)
			if err != nil {
				return err
			}
			return app.printAgent(agents, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show an Agent",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			agent, err := client.GetAgent(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID",
		Short: "Update an Agent from a JSON document",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			body, err := readJSON(updateFile)
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			agent, err := client.UpdateAgent(namespace, args[0], body)
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}
	update.Flags().StringVar(&updateFile, "file", "", "JSON document path")
	_ = update.MarkFlagRequired("file")

	deploy := &cobra.Command{
		Use:   "deploy ID",
		Short: "Deploy an Agent and create an immutable revision",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			revision, err := client.DeployAgent(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printItems(revision, false, []column{
				{title: "ID", key: "id"},
				{title: "REVISION", key: "revision"},
				{title: "AGENT", key: "agentId"},
				{title: "CONFIGURATION", key: "configurationId"},
			})
		},
	}
	stop := &cobra.Command{
		Use:   "stop ID",
		Short: "Stop an Agent while retaining its revision history and persistent state",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			agent, err := client.StopAgent(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}

	command.AddCommand(create, list, get, update, deploy, stop)
	return command
}

func commandGroup(use, short string) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return command.Help()
		},
	}
}

func (app *application) validateOptions() error {
	switch app.output {
	case "table", "json", "yaml":
	default:
		return fmt.Errorf("invalid output format %q: expected table, json, or yaml", app.output)
	}
	seconds, err := strconv.ParseUint(app.timeoutSeconds, 10, 64)
	if err != nil || seconds == 0 || seconds > uint64((1<<63-1)/int64(time.Second)) {
		return fmt.Errorf("OCC timeout must be a positive integer number of seconds")
	}
	app.parsedTimeout = time.Duration(seconds) * time.Second
	return nil
}

func (app *application) client() (*occclient.Client, error) {
	if app.url == "" {
		return nil, fmt.Errorf("set OCC_URL or pass --url")
	}
	if app.serviceKeyFile == "" {
		return nil, fmt.Errorf("set OCC_SERVICE_KEY_FILE or pass --service-key-file")
	}
	return occclient.New(occclient.Config{
		URL:            app.url,
		ServiceKeyFile: app.serviceKeyFile,
		CABundle:       app.caBundle,
		Timeout:        app.parsedTimeout,
	})
}

func (app *application) requiredNamespace() (string, error) {
	if app.namespace == "" {
		return "", fmt.Errorf("set OCC_NAMESPACE or pass --namespace")
	}
	return app.namespace, nil
}

func (app *application) printNamespace(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "STATUS", key: "status"},
		{title: "KUBERNETES NAMESPACE", key: "existingNamespace"},
	})
}

func (app *application) printConfiguration(value any) error {
	return app.printItems(value, false, []column{
		{title: "ID", key: "id"},
		{title: "KIND", key: "kind"},
		{title: "GENERATION", key: "generation"},
		{title: "CREATED", key: "createdAt"},
	})
}

func (app *application) printAgent(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "CONFIGURATION", key: "configurationId"},
		{title: "MODE", key: "executionMode"},
		{title: "DESIRED STATE", key: "desiredRuntimeState"},
		{title: "ACTIVE REVISION", key: "activeRevisionId"},
	})
}

func (app *application) printDeletion(kind, id string) error {
	value := map[string]any{"deleted": true, "kind": kind, "id": id}
	if app.output == "table" {
		_, err := fmt.Fprintf(app.out, "Deleted %s %s.\n", kind, id)
		return err
	}
	return app.printStructured(value)
}

func (app *application) printItems(value any, collection bool, columns []column) error {
	if app.output != "table" {
		return app.printStructured(value)
	}
	items := []any{value}
	if collection {
		var ok bool
		items, ok = value.([]any)
		if !ok {
			return fmt.Errorf("OCC returned an invalid resource collection")
		}
	}
	return printTable(app.out, items, columns)
}

func (app *application) printStructured(value any) error {
	switch app.output {
	case "json":
		if err := json.MarshalWrite(app.out, value, jsontext.WithIndent("  ")); err != nil {
			return err
		}
		_, err := fmt.Fprintln(app.out)
		return err
	case "yaml":
		encoded, err := yaml.Marshal(value)
		if err != nil {
			return err
		}
		_, err = app.out.Write(encoded)
		return err
	default:
		return fmt.Errorf("unsupported structured output format %q", app.output)
	}
}

func printTable(out io.Writer, items []any, columns []column) error {
	if len(items) == 0 {
		_, err := fmt.Fprintln(out, "No resources found.")
		return err
	}

	writer := tabwriter.NewWriter(out, 0, 8, 2, ' ', 0)
	headings := make([]string, len(columns))
	for index, column := range columns {
		headings[index] = column.title
	}
	if _, err := fmt.Fprintln(writer, strings.Join(headings, "\t")); err != nil {
		return err
	}
	for _, item := range items {
		resource, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("OCC returned an invalid resource")
		}
		row := make([]string, len(columns))
		for index, column := range columns {
			row[index] = displayValue(resource[column.key])
		}
		if _, err := fmt.Fprintln(writer, strings.Join(row, "\t")); err != nil {
			return err
		}
	}
	return writer.Flush()
}

func displayValue(value any) string {
	if value == nil {
		return "-"
	}
	if text, ok := value.(string); ok {
		return text
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "-"
	}
	return string(encoded)
}

func readJSON(path string) (jsontext.Value, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read JSON file %s: %w", path, err)
	}
	value := jsontext.Value(contents)
	if !value.IsValid() {
		return nil, fmt.Errorf("invalid JSON file %s", path)
	}
	return value, nil
}
