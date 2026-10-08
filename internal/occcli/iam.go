package occcli

import (
	"encoding/json/v2"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func (app *application) iamCommand() *cobra.Command {
	command := commandGroup("iam", "Manage Namespace IAM policy")
	command.AddCommand(
		app.iamRoleCommand(),
		app.iamAccessBindingCommand(),
		app.iamServicePrincipalCommand(),
	)
	return command
}

func (app *application) iamServicePrincipalCommand() *cobra.Command {
	command := commandGroup("service-principal", "Manage Namespace ServicePrincipals for automation and CLI keys")

	create := &cobra.Command{
		Use:     "create",
		Short:   "Create a Namespace ServicePrincipal with no grants",
		Example: iamServicePrincipalCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			principal, err := client.CreateIAMServicePrincipal(namespace)
			if err != nil {
				return err
			}
			return app.printIAMServicePrincipal(principal, false)
		},
	}

	list := &cobra.Command{
		Use:   "list",
		Short: "List Namespace ServicePrincipals",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			principals, err := client.ListIAMServicePrincipals(namespace)
			if err != nil {
				return err
			}
			return app.printIAMServicePrincipal(principals, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace ServicePrincipal",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			principal, err := client.GetIAMServicePrincipal(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printIAMServicePrincipal(principal, false)
		},
	}

	command.AddCommand(create, list, get)
	return command
}

func (app *application) serviceKeyCommand() *cobra.Command {
	command := commandGroup("service-key", "Issue and revoke service keys")

	var principalID, name, outFile string
	var expiresInDays int
	create := &cobra.Command{
		Use:     "create",
		Short:   "Issue a key for a ServicePrincipal and write it to a new key file",
		Example: serviceKeyCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if expiresInDays != 0 && (expiresInDays < 1 || expiresInDays > 365) {
				return fmt.Errorf("--expires-in-days must be between 1 and 365")
			}
			if app.namespace != "" {
				if err := namespaceIDArg.check(app.namespace); err != nil {
					return fmt.Errorf("OCC_NAMESPACE or --namespace: %w", err)
				}
			}
			// Create the file first, so an existing path or a bad directory fails
			// before a key exists that nothing could save.
			file, err := os.OpenFile(outFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return fmt.Errorf("failed to create key file: %w", err)
			}
			written := false
			defer func() {
				_ = file.Close()
				if !written {
					_ = os.Remove(outFile)
				}
			}()
			client, err := app.client()
			if err != nil {
				return err
			}
			body := map[string]any{"servicePrincipalId": principalID, "name": name}
			if app.namespace != "" {
				body["namespaceId"] = app.namespace
			}
			if expiresInDays != 0 {
				body["expiresIn"] = expiresInDays * 24 * 60 * 60
			}
			key, err := client.CreateServiceKey(body)
			if err != nil {
				return err
			}
			details, ok := key.(map[string]any)
			keyID, _ := details["id"].(string)
			if !ok || keyID == "" {
				return fmt.Errorf("OCC returned an invalid service key")
			}
			// The file holds the issuance envelope, which --service-key-file reads.
			writeErr := json.MarshalWrite(file, map[string]any{"data": key})
			if writeErr == nil {
				writeErr = file.Close()
			}
			if writeErr != nil {
				// Nobody holds the unsaved key: revoke it, and name it if that fails too.
				if _, revokeErr := client.RevokeServiceKey(keyID); revokeErr != nil {
					return fmt.Errorf(
						"failed to write key file (%w); revoke unsaved service key %s with occ service-key revoke",
						writeErr,
						keyID,
					)
				}
				return fmt.Errorf("failed to write key file (%w); the unsaved service key %s was revoked", writeErr, keyID)
			}
			written = true
			delete(details, "key")
			return app.printServiceKey(details)
		},
	}
	create.Flags().StringVar(&principalID, "service-principal", "", "ServicePrincipal ID")
	create.Flags().StringVar(&name, "name", "", "Key name (1-32 characters)")
	create.Flags().StringVar(&outFile, "out", "", "New key file to write (mode 0600; must not exist)")
	create.Flags().IntVar(&expiresInDays, "expires-in-days", 0, "Lifetime in days, 1-365 (default 30)")
	_ = create.MarkFlagRequired("service-principal")
	_ = create.MarkFlagRequired("name")
	_ = create.MarkFlagRequired("out")

	revoke := &cobra.Command{
		Use:   "revoke ID",
		Short: "Revoke a service key",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			result, err := client.RevokeServiceKey(args[0])
			if err != nil {
				return err
			}
			return app.printItems(result, false, []column{
				{title: "ID", key: "id"},
				{title: "REVOKED", key: "revoked"},
			})
		},
	}

	command.AddCommand(create, revoke)
	return command
}

func (app *application) iamRoleCommand() *cobra.Command {
	command := commandGroup("role", "Manage Namespace IAM Roles")

	var createFile string
	create := &cobra.Command{
		Use:     "create",
		Short:   "Create a Namespace IAM Role from a JSON document",
		Example: iamRoleCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
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
			namespace, client, err := app.namespaceClient()
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
			namespace, client, err := app.namespaceClient()
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
			namespace, client, err := app.namespaceClient()
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
		Use:     "create",
		Short:   "Create a Namespace IAM AccessBinding from a JSON document",
		Example: iamAccessBindingCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
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
			namespace, client, err := app.namespaceClient()
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
			namespace, client, err := app.namespaceClient()
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
			namespace, client, err := app.namespaceClient()
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
