package occcli

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"maps"
	"strings"
	"text/tabwriter"

	"go.yaml.in/yaml/v3"
)

type column struct {
	title string
	key   string
}

func (app *application) printNamespace(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "STATUS", key: "status"},
		{title: "ADOPTED NAMESPACE", key: "existingNamespace"},
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

func (app *application) printSecret(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
	})
}

func (app *application) printCredentialSource(value any, collection bool) error {
	if app.output == "table" && !collection {
		if resource, ok := value.(map[string]any); ok {
			if status, ok := resource["status"].(map[string]any); ok {
				// Table output shows the live gateway state; structured output keeps the full status.
				row := maps.Clone(resource)
				row["gatewayStatus"] = status["state"]
				value = row
			}
		}
	}
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "TYPE", key: "type"},
		{title: "STATE", key: "state"},
		{title: "GATEWAY STATUS", key: "gatewayStatus"},
	})
}

func (app *application) printCredentialWithdrawal(value any) error {
	return app.printItems(value, false, []column{
		{title: "AGENT", key: "agentId"},
		{title: "REVISION", key: "revisionId"},
		{title: "CREDENTIAL SOURCE", key: "credentialSourceId"},
		{title: "STATE", key: "state"},
		{title: "REQUESTED BY", key: "requestedBy"},
		{title: "REASON", key: "reason"},
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
		// Lifecycle is active or deleting; deployment health comes from deployment-status.
		{title: "LIFECYCLE", key: "status"},
		{title: "ACTIVE REVISION", key: "activeRevisionId"},
	})
}

// printAgentRevisionList prints rows from describeAgentRevisions. Structured
// output keeps every field, including active and deploymentStatus.
func (app *application) printAgentRevisionList(rows []any) error {
	if app.output != "table" {
		return app.printStructured(rows)
	}
	table := make([]any, 0, len(rows))
	for _, item := range rows {
		row := maps.Clone(item.(map[string]any))
		if active, _ := row["active"].(bool); active {
			row["active"] = "*"
		} else {
			row["active"] = ""
		}
		table = append(table, row)
	}
	return printTable(app.out, table, []column{
		{title: "ACTIVE", key: "active"},
		{title: "ID", key: "id"},
		{title: "REVISION", key: "revision"},
		{title: "GENERATION", key: "configurationGeneration"},
		{title: "STATUS", key: "deploymentStatus"},
		{title: "CONFIGURATION", key: "configurationId"},
		{title: "CREATED", key: "createdAt"},
	})
}

// printDeploymentStatus shows startup warnings in the table too: a succeeded
// deployment can still have disabled a selected plugin (PLUGIN_AUTH_REQUIRED,
// PLUGIN_INSTALL_FAILED). Structured output keeps the full warnings array.
func (app *application) printDeploymentStatus(value any) error {
	if app.output == "table" {
		if resource, ok := value.(map[string]any); ok {
			row := maps.Clone(resource)
			row["warnings"] = deploymentWarningsText(resource["warnings"])
			value = row
		}
	}
	return app.printItems(value, false, []column{
		{title: "ID", key: "deploymentId"},
		{title: "AGENT", key: "agentId"},
		{title: "STATUS", key: "status"},
		{title: "ERROR", key: "error"},
		{title: "WARNINGS", key: "warnings"},
	})
}

// deploymentWarningsText renders warnings as "pluginId (CODE)" pairs, or nil
// (shown as "-") when there are none.
func deploymentWarningsText(value any) any {
	warnings, ok := value.([]any)
	if !ok || len(warnings) == 0 {
		return nil
	}
	parts := make([]string, 0, len(warnings))
	for _, item := range warnings {
		warning, ok := item.(map[string]any)
		if !ok {
			parts = append(parts, displayValue(item))
			continue
		}
		code := displayValue(warning["code"])
		if plugin, ok := warning["pluginId"].(string); ok && plugin != "" {
			parts = append(parts, plugin+" ("+code+")")
		} else {
			parts = append(parts, code)
		}
	}
	return strings.Join(parts, ", ")
}

func (app *application) printRuntimeCredentials(value any) error {
	return app.printItems(value, false, []column{
		{title: "CONFIGURED", key: "transportConfigured"},
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
