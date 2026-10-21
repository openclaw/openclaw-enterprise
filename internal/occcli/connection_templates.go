package occcli

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"

	"github.com/spf13/cobra"
)

// connectionTemplateRoleID is the built-in Installation Role that grants use on one template.
const connectionTemplateRoleID = "role_connection_template_user"

func (app *application) connectionTemplateCommand() *cobra.Command {
	command := commandGroup(
		"connection-template",
		"Manage Installation connection templates that people connect to personal Agents",
	)
	columns := []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "displayName"},
		{title: "CREATED", key: "createdAt"},
	}

	list := &cobra.Command{
		Use:   "list",
		Short: "List connection templates",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			templates, err := client.ListConnectionTemplates()
			if err != nil {
				return err
			}
			return app.printItems(templates, true, columns)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a connection template, its current version, and its callback URI",
		Args:  idArgs(connectionTemplateIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			template, err := client.GetConnectionTemplate(args[0])
			if err != nil {
				return err
			}
			return app.printStructured(template)
		},
	}

	var createFile string
	create := &cobra.Command{
		Use:   "create --file PATH",
		Short: "Create a connection template from a JSON document",
		Long: "Create a connection template from a JSON document. Include clientSecret only for " +
			"an OAuth client not registered yet; the secret is write-only.",
		Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			body, err := readJSON(createFile)
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			template, err := client.CreateConnectionTemplate(body)
			if err != nil {
				return err
			}
			return app.printStructured(template)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID --file PATH",
		Short: "Rename a template, or create a version with new approved values",
		Long: "Changing any field except displayName creates a new version. Existing " +
			"connections keep the version their owner approved until they reconnect.",
		Args: idArgs(connectionTemplateIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			body, err := readJSON(updateFile)
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			template, err := client.UpdateConnectionTemplate(args[0], body)
			if err != nil {
				return err
			}
			return app.printStructured(template)
		},
	}
	update.Flags().StringVar(&updateFile, "file", "", "JSON document path")
	_ = update.MarkFlagRequired("file")

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete a connection template that no connection uses",
		Args:  idArgs(connectionTemplateIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			return client.DeleteConnectionTemplate(args[0])
		},
	}

	var secretFile string
	rotate := &cobra.Command{
		Use:   "rotate-client-secret ID --file PATH",
		Short: "Replace the OAuth client secret used by new connections",
		Long: "The JSON document contains clientSecret. Existing connections keep the secret " +
			"they were configured with until the provider disables it.",
		Args: idArgs(connectionTemplateIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			body, err := readJSON(secretFile)
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			template, err := client.RotateConnectionClientSecret(args[0], body)
			if err != nil {
				return err
			}
			return app.printStructured(template)
		},
	}
	rotate.Flags().StringVar(&secretFile, "file", "", "JSON document with clientSecret")
	_ = rotate.MarkFlagRequired("file")

	var person, namespace string
	bind := &cobra.Command{
		Use:   "bind ID (--person PRINCIPAL_ID | --namespace NAMESPACE_ID)",
		Short: "Let a person, or anyone connecting an Agent in a Namespace, use this template",
		Args:  idArgs(connectionTemplateIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			if (person == "") == (namespace == "") {
				return fmt.Errorf("set exactly one of --person or --namespace")
			}
			subjectKind, subjectID := "identity", person
			if namespace != "" {
				if err := namespaceIDArg.check(namespace, ""); err != nil {
					return err
				}
				subjectKind, subjectID = "namespace", namespace
			}
			body, err := jsonBody(map[string]string{
				"subjectKind":  subjectKind,
				"subjectId":    subjectID,
				"roleId":       connectionTemplateRoleID,
				"resourceKind": "connection_template",
				"resourceId":   args[0],
			})
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			binding, err := client.CreateInstallationAccessBinding(body)
			if err != nil {
				return err
			}
			return app.printStructured(binding)
		},
	}
	bind.Flags().StringVar(&person, "person", "", "Principal ID of the person")
	bind.Flags().StringVar(&namespace, "namespace", "", "Namespace ID whose Agents may connect it")

	bindings := &cobra.Command{
		Use:   "bindings",
		Short: "List who may use connection templates",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			value, err := client.ListInstallationAccessBindings()
			if err != nil {
				return err
			}
			return app.printItems(value, true, []column{
				{title: "ID", key: "id"},
				{title: "SUBJECT KIND", key: "subjectKind"},
				{title: "SUBJECT", key: "subjectId"},
				{title: "TEMPLATE", key: "resourceId"},
			})
		},
	}

	unbind := &cobra.Command{
		Use:   "unbind BINDING_ID",
		Short: "Remove a connection template access binding",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			return client.DeleteInstallationAccessBinding(args[0])
		},
	}

	command.AddCommand(list, get, create, update, deleteCommand, rotate, bind, bindings, unbind)
	return command
}

// agentConnectionCommand lists and disconnects connected accounts. Connecting needs the
// person's signed-in console session, which service keys never provide.
func (app *application) agentConnectionCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "connection",
		Short: "List or disconnect an Agent's connected accounts (connect from the console)",
	}
	list := &cobra.Command{
		Use:   "list AGENT_ID",
		Short: "List an Agent's connected accounts",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			value, err := client.ListAgentConnections(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printItems(value, true, []column{
				{title: "SOURCE", key: "credentialSourceId"},
				{title: "TEMPLATE", key: "connectionTemplateId"},
				{title: "VERSION", key: "connectionTemplateVersion"},
				{title: "OWNER", key: "ownerPrincipalId"},
				{title: "CREATED", key: "createdAt"},
			})
		},
	}
	disconnect := &cobra.Command{
		Use:   "disconnect AGENT_ID SOURCE_ID",
		Short: "Remove a connected account and request its withdrawal",
		Args:  idArgs(agentIDArg, credentialSourceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			value, err := client.DisconnectAgentConnection(namespace, args[0], args[1])
			if err != nil {
				return err
			}
			return app.printStructured(value)
		},
	}
	command.AddCommand(list, disconnect)
	return command
}

func jsonBody(value any) (jsontext.Value, error) {
	encoded, err := json.Marshal(value, json.Deterministic(true))
	return jsontext.Value(encoded), err
}
