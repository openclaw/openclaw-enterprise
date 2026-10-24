package occcli

import (
	"fmt"
	"github.com/spf13/cobra"
)

func (app *application) agentPolicyCommand() *cobra.Command {
	command := commandGroup("policy", "Read and explicitly change an Agent's sandbox network additions")
	var facet string
	command.PersistentFlags().StringVar(&facet, "facet", "networking", "Sandbox policy facet (currently networking only)")
	get := &cobra.Command{Use: "get AGENT_ID", Args: idArgs(agentIDArg), Short: "Read desired policy, application evidence, and delegation ceiling", RunE: func(_ *cobra.Command, args []string) error {
		if err := policyFacet(facet); err != nil {
			return err
		}
		namespace, client, err := app.namespaceClient()
		if err != nil {
			return err
		}
		value, err := client.GetAgentSandboxPolicy(namespace, args[0], facet)
		if err != nil {
			return err
		}
		return app.printStructured(value)
	}}
	var file string
	update := &cobra.Command{Use: "update AGENT_ID --file PATH", Args: idArgs(agentIDArg), Short: "Save additions from JSON containing expectedVersion and additions", RunE: func(_ *cobra.Command, args []string) error {
		if err := policyFacet(facet); err != nil {
			return err
		}
		body, err := readJSON(file)
		if err != nil {
			return err
		}
		namespace, client, err := app.namespaceClient()
		if err != nil {
			return err
		}
		value, err := client.UpdateAgentSandboxPolicy(namespace, args[0], facet, body)
		if err != nil {
			return err
		}
		return app.printStructured(value)
	}}
	update.Flags().StringVar(&file, "file", "", "JSON document with expectedVersion and the complete additions array")
	_ = update.MarkFlagRequired("file")
	var revision string
	var version int
	apply := &cobra.Command{Use: "apply AGENT_ID --revision REVISION_ID --expected-version VERSION", Args: idArgs(agentIDArg), Short: "Request live application to one exact running revision", RunE: func(_ *cobra.Command, args []string) error {
		if err := policyFacet(facet); err != nil {
			return err
		}
		if version < 1 {
			return fmt.Errorf("--expected-version must be positive")
		}
		namespace, client, err := app.namespaceClient()
		if err != nil {
			return err
		}
		if err := revisionIDArg.check(revision, namespace); err != nil {
			return err
		}
		value, err := client.ApplyAgentSandboxPolicy(namespace, args[0], facet, revision, version)
		if err != nil {
			return err
		}
		return app.printStructured(value)
	}}
	apply.Flags().StringVar(&revision, "revision", "", "Exact active revision ID")
	apply.Flags().IntVar(&version, "expected-version", 0, "Saved policy version to apply")
	_ = apply.MarkFlagRequired("revision")
	_ = apply.MarkFlagRequired("expected-version")
	var enabled bool
	editing := &cobra.Command{Use: "editing AGENT_ID --enabled=true|false", Args: idArgs(agentIDArg), Short: "Administratively enable or disable future user policy edits", RunE: func(_ *cobra.Command, args []string) error {
		if err := policyFacet(facet); err != nil {
			return err
		}
		namespace, client, err := app.namespaceClient()
		if err != nil {
			return err
		}
		value, err := client.TEMPORARY_API_WILL_BREAK_IN_FUTURE_SetAgentSandboxPolicyEditing(namespace, args[0], facet, enabled)
		if err != nil {
			return err
		}
		return app.printStructured(value)
	}}
	editing.Flags().BoolVar(&enabled, "enabled", false, "Enable editing; disabling preserves approved grants")
	_ = editing.MarkFlagRequired("enabled")
	var recommendationRevision string
	recommendations := &cobra.Command{Use: "recommendations AGENT_ID --revision REVISION_ID", Args: idArgs(agentIDArg), Short: "Read untrusted provider policy suggestions for one exact revision", RunE: func(_ *cobra.Command, args []string) error {
		if err := policyFacet(facet); err != nil {
			return err
		}
		namespace, client, err := app.namespaceClient()
		if err != nil {
			return err
		}
		if err := revisionIDArg.check(recommendationRevision, namespace); err != nil {
			return err
		}
		value, err := client.GetAgentSandboxRecommendations(namespace, args[0], facet, recommendationRevision)
		if err != nil {
			return err
		}
		return app.printStructured(value)
	}}
	recommendations.Flags().StringVar(&recommendationRevision, "revision", "", "Exact revision ID")
	_ = recommendations.MarkFlagRequired("revision")

	for _, child := range []*cobra.Command{get, update, apply, editing, recommendations} {
		child.Annotations = map[string]string{outputFormatsAnnotation: "json,yaml"}
	}
	command.AddCommand(get, update, apply, editing, recommendations)
	return command
}

// policyFacet refuses anything but networking before a request. The flag says
// that is the only facet, and OCC answers the others with a conflict.
func policyFacet(facet string) error {
	if facet != "networking" {
		return fmt.Errorf("--facet must be networking")
	}
	return nil
}
