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

var oauthPollDelay = 2 * time.Second

type deploymentOAuthStart struct {
	deploymentStatus any
	observation      any
}

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

	var deployAuth string
	var deployAuthTimeout string
	deploy := &cobra.Command{
		Use:   "deploy ID",
		Short: "Deploy an Agent and create an immutable revision",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			if deployAuth != "" && deployAuth != "oauth" {
				return fmt.Errorf("unsupported deployment auth method %q: expected oauth", deployAuth)
			}
			if deployAuth == "oauth" && app.output != "table" {
				return fmt.Errorf("OAuth activation prints a user code and requires table output")
			}
			authTimeout, err := time.ParseDuration(deployAuthTimeout)
			if err != nil || authTimeout <= 0 {
				return fmt.Errorf("OAuth activation timeout must be a positive duration")
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			revision, err := client.DeployAgent(namespace, args[0])
			if err != nil {
				return err
			}
			if deployAuth == "oauth" {
				deploymentID, err := requiredStringField(revision, "id")
				if err != nil {
					return err
				}
				deadline := time.Now().Add(authTimeout)
				started, err := startDeploymentOAuth(client, namespace, args[0], deploymentID, deadline)
				if err != nil {
					return err
				}
				status := started.deploymentStatus
				if status == nil {
					status, err = app.activateDeploymentOAuth(
						client,
						namespace,
						args[0],
						deploymentID,
						started.observation,
						deadline,
					)
					if err != nil {
						return err
					}
				}
				return app.printItems(status, false, []column{
					{title: "DEPLOYMENT", key: "deploymentId"},
					{title: "STATUS", key: "status"},
					{title: "AGENT", key: "agentId"},
				})
			}
			return app.printItems(revision, false, []column{
				{title: "ID", key: "id"},
				{title: "REVISION", key: "revision"},
				{title: "AGENT", key: "agentId"},
				{title: "CONFIGURATION", key: "configurationId"},
			})
		},
	}
	deploy.Flags().StringVar(&deployAuth, "auth", "", "Deployment auth flow to complete: oauth")
	deploy.Flags().StringVar(&deployAuthTimeout, "auth-timeout", "15m", "Maximum time to wait for OAuth activation")
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

	command.AddCommand(create, list, get, update, deploy, stop, deleteAgent)
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

func (app *application) printSecret(value any) error {
	return app.printItems(value, false, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
	})
}

func (app *application) printIAMRole(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "PERMISSIONS", key: "permissions"},
	})
}

func (app *application) printIAMAccessBinding(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "SUBJECT", key: "subjectId"},
		{title: "ROLE", key: "roleId"},
		{title: "RESOURCE KIND", key: "resourceKind"},
		{title: "RESOURCE", key: "resourceId"},
	})
}

func (app *application) printAgent(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "SERVICE PRINCIPAL", key: "servicePrincipalId"},
		{title: "CONFIGURATION", key: "configurationId"},
		{title: "MODE", key: "executionMode"},
		{title: "DESIRED STATE", key: "desiredRuntimeState"},
		{title: "STATUS", key: "status"},
		{title: "ACTIVE REVISION", key: "activeRevisionId"},
	})
}

func startDeploymentOAuth(
	client *occclient.Client,
	namespaceID string,
	agentID string,
	deploymentID string,
	deadline time.Time,
) (deploymentOAuthStart, error) {
	for {
		if time.Now().After(deadline) {
			return deploymentOAuthStart{}, fmt.Errorf("OAuth activation timed out")
		}
		status, done, err := observeDeploymentStatus(client, namespaceID, agentID, deploymentID, "before OAuth activation")
		if err != nil {
			return deploymentOAuthStart{}, err
		}
		if done {
			return deploymentOAuthStart{deploymentStatus: status}, nil
		}
		observation, err := client.StartAgentDeploymentAuth(namespaceID, agentID, deploymentID)
		if err != nil {
			status, done, statusErr := observeDeploymentStatus(
				client,
				namespaceID,
				agentID,
				deploymentID,
				"after OAuth start failure",
			)
			if statusErr != nil {
				return deploymentOAuthStart{}, statusErr
			}
			if done {
				return deploymentOAuthStart{deploymentStatus: status}, nil
			}
			return deploymentOAuthStart{}, err
		}
		phase, err := requiredStringField(observation, "phase")
		if err != nil {
			return deploymentOAuthStart{}, err
		}
		status, done, err = observeDeploymentStatus(client, namespaceID, agentID, deploymentID, "after OAuth start")
		if err != nil {
			return deploymentOAuthStart{}, err
		}
		if done {
			return deploymentOAuthStart{deploymentStatus: status}, nil
		}
		if phase != "preparing" {
			return deploymentOAuthStart{observation: observation}, nil
		}
		if err := sleepUntilNextOAuthPoll(deadline); err != nil {
			return deploymentOAuthStart{}, err
		}
	}
}

func (app *application) activateDeploymentOAuth(
	client *occclient.Client,
	namespaceID string,
	agentID string,
	deploymentID string,
	initial any,
	deadline time.Time,
) (any, error) {
	observation := initial
	printedAttempts := map[string]bool{}
	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("OAuth activation timed out")
		}
		status, done, err := observeDeploymentStatus(client, namespaceID, agentID, deploymentID, "during OAuth activation")
		if err != nil {
			return nil, err
		}
		if done {
			return status, nil
		}
		phase, err := requiredStringField(observation, "phase")
		if err != nil {
			return nil, err
		}
		switch phase {
		case "preparing":
			if err := sleepUntilNextOAuthPoll(deadline); err != nil {
				return nil, err
			}
			observation, err = client.GetAgentDeploymentAuth(namespaceID, agentID, deploymentID)
			if err != nil {
				return deploymentStatusIfSucceededAfterAuthError(
					client,
					namespaceID,
					agentID,
					deploymentID,
					err,
				)
			}
		case "waiting":
			attemptID, err := requiredStringField(observation, "attemptId")
			if err != nil {
				return nil, err
			}
			if !printedAttempts[attemptID] {
				if err := app.printOAuthDeviceCode(observation); err != nil {
					return nil, err
				}
				printedAttempts[attemptID] = true
			}
			expired, err := oauthAttemptExpired(observation)
			if err != nil {
				return nil, err
			}
			if expired {
				return nil, fmt.Errorf("OAuth authorization expired")
			}
			if err := sleepUntilNextOAuthPoll(deadline); err != nil {
				return nil, err
			}
			observation, err = client.GetAgentDeploymentAuth(namespaceID, agentID, deploymentID)
			if err != nil {
				return deploymentStatusIfSucceededAfterAuthError(
					client,
					namespaceID,
					agentID,
					deploymentID,
					err,
				)
			}
		case "authorized":
			attemptID, err := requiredStringField(observation, "attemptId")
			if err != nil {
				return nil, err
			}
			observation, err = client.CompleteAgentDeploymentAuth(
				namespaceID,
				agentID,
				deploymentID,
				attemptID,
			)
			if err != nil {
				return deploymentStatusIfSucceededAfterAuthError(
					client,
					namespaceID,
					agentID,
					deploymentID,
					err,
				)
			}
		case "committed":
			return waitForDeploymentSucceeded(client, namespaceID, agentID, deploymentID, deadline)
		case "failed":
			reason, _ := stringField(observation, "reason")
			if reason == "" {
				reason = "unavailable"
			}
			return nil, fmt.Errorf("OAuth authorization failed: %s", reason)
		default:
			return nil, fmt.Errorf("OCC returned unsupported OAuth phase %q", phase)
		}
	}
}

func deploymentStatusIfSucceededAfterAuthError(
	client *occclient.Client,
	namespaceID string,
	agentID string,
	deploymentID string,
	authErr error,
) (any, error) {
	if strings.Contains(authErr.Error(), "(HTTP 401)") {
		return nil, authErr
	}
	status, err := client.GetAgentDeployment(namespaceID, agentID, deploymentID)
	if err != nil {
		return nil, authErr
	}
	state, err := requiredStringField(status, "status")
	if err != nil {
		return nil, authErr
	}
	if state == "succeeded" {
		return status, nil
	}
	return nil, authErr
}

func observeDeploymentStatus(
	client *occclient.Client,
	namespaceID string,
	agentID string,
	deploymentID string,
	context string,
) (any, bool, error) {
	status, err := client.GetAgentDeployment(namespaceID, agentID, deploymentID)
	if err != nil {
		return nil, false, err
	}
	state, err := requiredStringField(status, "status")
	if err != nil {
		return nil, false, err
	}
	switch state {
	case "succeeded":
		return status, true, nil
	case "failed":
		return nil, true, fmt.Errorf("deployment failed %s", context)
	case "queued", "running":
		return nil, false, nil
	default:
		return nil, false, fmt.Errorf("OCC returned unsupported deployment status %q", state)
	}
}

func (app *application) printOAuthDeviceCode(observation any) error {
	verificationURL, err := requiredStringField(observation, "verificationUrl")
	if err != nil {
		return err
	}
	userCode, err := requiredStringField(observation, "userCode")
	if err != nil {
		return err
	}
	expiresAt, err := requiredStringField(observation, "expiresAt")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(
		app.out,
		"OpenAI OAuth authorization required.\nVisit: %s\nUser code: %s\nExpires: %s\nWaiting for authorization...\n\n",
		verificationURL,
		userCode,
		expiresAt,
	)
	return err
}

func waitForDeploymentSucceeded(
	client *occclient.Client,
	namespaceID string,
	agentID string,
	deploymentID string,
	deadline time.Time,
) (any, error) {
	for {
		status, err := client.GetAgentDeployment(namespaceID, agentID, deploymentID)
		if err != nil {
			return nil, err
		}
		state, err := requiredStringField(status, "status")
		if err != nil {
			return nil, err
		}
		switch state {
		case "succeeded":
			return status, nil
		case "failed":
			return nil, fmt.Errorf("deployment failed after OAuth commit")
		case "queued", "running":
			if err := sleepUntilNextOAuthPoll(deadline); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("OCC returned unsupported deployment status %q", state)
		}
	}
}

func sleepUntilNextOAuthPoll(deadline time.Time) error {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return fmt.Errorf("OAuth activation timed out")
	}
	delay := oauthPollDelay
	if remaining < delay {
		delay = remaining
	}
	time.Sleep(delay)
	return nil
}

func oauthAttemptExpired(value any) (bool, error) {
	expiresAt, err := requiredStringField(value, "expiresAt")
	if err != nil {
		return false, err
	}
	expires, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return false, fmt.Errorf("OCC returned an invalid OAuth expiration")
	}
	return !time.Now().Before(expires), nil
}

func requiredStringField(value any, key string) (string, error) {
	result, ok := stringField(value, key)
	if !ok || result == "" {
		return "", fmt.Errorf("OCC returned an invalid response")
	}
	return result, nil
}

func stringField(value any, key string) (string, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return "", false
	}
	result, ok := record[key].(string)
	return result, ok
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
