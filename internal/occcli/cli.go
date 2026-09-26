package occcli

import (
	"cmp"
	"encoding/json/jsontext"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
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
		"Namespace scope for Configuration, Secret, IAM, and Agent operations",
	)
	flags.StringVarP(&app.output, "output", "o", "table", "Output format: table, json, or yaml")

	command.AddCommand(
		app.installationCommand(),
		app.namespaceCommand(),
		app.iamCommand(),
		app.configurationCommand(),
		app.secretCommand(),
		app.agentCommand(),
		developmentCommand(),
	)
	return command
}

func (app *application) installationCommand() *cobra.Command {
	command := commandGroup("installation", "Inspect the singleton Installation")
	get := &cobra.Command{
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
	}
	deploymentInventory := &cobra.Command{
		Use:   "deployment-inventory",
		Short: "Show the complete authorized Agent deployment inventory",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			result, err := client.GetInstallationDeploymentInventory()
			if err != nil {
				return err
			}
			return app.printItems(result, false, []column{
				{title: "INSTALLATION", key: "installationId"},
				{title: "NAMESPACES", key: "namespaces"},
			})
		},
	}
	command.AddCommand(get, deploymentInventory)
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

func (app *application) iamCommand() *cobra.Command {
	command := commandGroup("iam", "Manage Namespace IAM policy")
	command.AddCommand(app.iamRoleCommand(), app.iamAccessBindingCommand())
	return command
}

func (app *application) iamRoleCommand() *cobra.Command {
	command := commandGroup("role", "Manage Namespace IAM Roles")

	var createFile string
	create := &cobra.Command{
		Use:   "create",
		Short: "Create a Namespace IAM Role from a JSON document",
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
			role, err := client.CreateIAMRole(namespace, body)
			if err != nil {
				return err
			}
			return app.printIAMRole(role, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	list := &cobra.Command{
		Use:   "list",
		Short: "List Namespace IAM Roles",
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
			roles, err := client.ListIAMRoles(namespace)
			if err != nil {
				return err
			}
			return app.printIAMRole(roles, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace IAM Role",
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
			role, err := client.GetIAMRole(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printIAMRole(role, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete an unreferenced Namespace IAM Role",
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
			if err := client.DeleteIAMRole(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("iam role", args[0])
		},
	}

	command.AddCommand(create, list, get, deleteCommand)
	return command
}

func (app *application) iamAccessBindingCommand() *cobra.Command {
	command := commandGroup("access-binding", "Manage Namespace IAM AccessBindings")

	var createFile string
	create := &cobra.Command{
		Use:   "create",
		Short: "Create a Namespace IAM AccessBinding from a JSON document",
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
			binding, err := client.CreateIAMAccessBinding(namespace, body)
			if err != nil {
				return err
			}
			return app.printIAMAccessBinding(binding, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	list := &cobra.Command{
		Use:   "list",
		Short: "List Namespace IAM AccessBindings",
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
			bindings, err := client.ListIAMAccessBindings(namespace)
			if err != nil {
				return err
			}
			return app.printIAMAccessBinding(bindings, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace IAM AccessBinding",
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
			binding, err := client.GetIAMAccessBinding(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printIAMAccessBinding(binding, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete a Namespace IAM AccessBinding",
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
			if err := client.DeleteIAMAccessBinding(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("iam access-binding", args[0])
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

func (app *application) secretCommand() *cobra.Command {
	command := commandGroup("secret", "Manage Secrets in the selected Namespace")

	var createFile string
	create := &cobra.Command{
		Use:   "create",
		Short: "Create a Secret from a JSON document",
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
			secret, err := client.CreateSecret(namespace, body)
			if err != nil {
				return err
			}
			return app.printSecret(secret)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show Secret metadata",
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
			secret, err := client.GetSecret(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printSecret(secret)
		},
	}

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID",
		Short: "Update a Secret from a JSON document",
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
			secret, err := client.UpdateSecret(namespace, args[0], body)
			if err != nil {
				return err
			}
			return app.printSecret(secret)
		},
	}
	update.Flags().StringVar(&updateFile, "file", "", "JSON document path")
	_ = update.MarkFlagRequired("file")

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete an unbound Secret",
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
			if err := client.DeleteSecret(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("secret", args[0])
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
	deploymentStatus := &cobra.Command{
		Use:   "deployment-status AGENT_ID DEPLOYMENT_ID",
		Short: "Show durable status for one Agent deployment",
		Args:  cobra.ExactArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			deployment, err := client.GetAgentDeployment(namespace, args[0], args[1])
			if err != nil {
				return err
			}
			return app.printItems(deployment, false, []column{
				{title: "ID", key: "deploymentId"},
				{title: "AGENT", key: "agentId"},
				{title: "STATUS", key: "status"},
				{title: "ERROR", key: "error"},
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
	deleteAgent := &cobra.Command{
		Use:   "delete ID",
		Short: "Begin asynchronous Agent deletion",
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
			agent, err := client.DeleteAgent(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}

	command.AddCommand(create, list, get, update, deploy, deploymentStatus, stop, deleteAgent)
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
