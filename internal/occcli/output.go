package occcli

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"maps"
	"strconv"
	"strings"
	"text/tabwriter"
	"unicode"
	"unicode/utf16"

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

// printSecretDetail adds a CONSUMERS column to the single-Secret table: the
// referencing resource IDs the caller may read, the count of those it may not,
// and whether OCC stopped examining references. Structured output keeps the
// full consumers object.
func (app *application) printSecretDetail(value any) error {
	if app.output == "table" {
		if resource, ok := value.(map[string]any); ok {
			row := maps.Clone(resource)
			row["consumers"] = secretConsumersText(resource["consumers"])
			value = row
		}
	}
	return app.printItems(value, false, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "CONSUMERS", key: "consumers"},
	})
}

// secretConsumersText renders consumers as "kind:id" pairs, then "N unreadable"
// and "more" when present, or nil (shown as "-") when nothing references the
// Secret.
func secretConsumersText(value any) any {
	consumers, ok := value.(map[string]any)
	if !ok {
		return value
	}
	parts := []string{}
	for _, kind := range []struct{ key, label string }{
		{"agents", "agent"},
		{"configurations", "configuration"},
		{"credentialSources", "credential-source"},
		{"provisioningRequests", "provisioning"},
	} {
		ids, _ := consumers[kind.key].([]any)
		for _, id := range ids {
			parts = append(parts, kind.label+":"+displayValue(id))
		}
	}
	if unreadable, ok := consumers["unreadable"].(float64); ok && unreadable > 0 {
		parts = append(parts, strconv.FormatFloat(unreadable, 'f', -1, 64)+" unreadable")
	}
	if truncated, _ := consumers["truncated"].(bool); truncated {
		parts = append(parts, "more")
	}
	if len(parts) == 0 {
		return nil
	}
	return strings.Join(parts, ", ")
}

// printPreset shows Preset identity in tables; structured output includes the template.
func (app *application) printPreset(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "CREATED", key: "createdAt"},
	})
}

func (app *application) printCredentialSource(value any, collection bool) error {
	columns := []column{
		{title: "ID", key: "id"},
		{title: "NAME", key: "name"},
		{title: "TYPE", key: "type"},
		{title: "STATE", key: "state"},
	}
	// List responses carry no live gateway status (that takes a gateway call per source),
	// so only single-resource tables get the column.
	if collection {
		return app.printItems(value, collection, columns)
	}
	if app.output == "table" {
		if resource, ok := value.(map[string]any); ok {
			if status, ok := resource["status"].(map[string]any); ok {
				// Table output shows the live gateway state; structured output keeps the full status.
				row := maps.Clone(resource)
				row["gatewayStatus"] = status["state"]
				value = row
			}
		}
	}
	return app.printItems(value, collection, append(columns, column{title: "GATEWAY STATUS", key: "gatewayStatus"}))
}

func (app *application) printCredentialWithdrawal(value any) error {
	return app.printItems(value, false, []column{
		{title: "AGENT", key: "agentId"},
		{title: "REVISION", key: "revisionId"},
		{title: "CREDENTIAL SOURCE", key: "credentialSourceId"},
		{title: "STATE", key: "state"},
		{title: "REQUESTED BY", key: "requestedBy"},
		{title: "REASON", key: "reason"},
		{title: "IN PROGRESS", key: "withdrawalInProgress"},
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

func (app *application) printIAMServicePrincipal(value any, collection bool) error {
	return app.printItems(value, collection, []column{
		{title: "ID", key: "id"},
		{title: "NAMESPACE", key: "namespaceId"},
	})
}

func (app *application) printServiceKey(value any) error {
	return app.printItems(value, false, []column{
		{title: "ID", key: "id"},
		{title: "SERVICE PRINCIPAL", key: "servicePrincipalId"},
		{title: "NAMESPACE", key: "namespaceId"},
		{title: "NAME", key: "name"},
		{title: "EXPIRES", key: "expiresAt"},
	})
}

func (app *application) printAgent(value any, collection bool) error {
	return app.printBrowsingItems(value, collection, []column{
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
	return app.printBrowsingItems(table, true, []column{
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

// printBrowsingItems keeps metadata readable while making saved-settings errors visible.
// Structured output preserves the API's typed error; tables add a column only when needed.
func (app *application) printBrowsingItems(value any, collection bool, columns []column) error {
	if app.output != "table" {
		return app.printItems(value, collection, columns)
	}
	items := []any{value}
	if collection {
		var ok bool
		items, ok = value.([]any)
		if !ok {
			return fmt.Errorf("OCC returned an invalid resource collection")
		}
	}
	rows := make([]any, 0, len(items))
	hasError := false
	for _, item := range items {
		resource, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("OCC returned an invalid resource")
		}
		row := maps.Clone(resource)
		if readError, ok := resource["configurationReadError"].(map[string]any); ok {
			row["configurationReadError"] = fmt.Sprintf("%s (%s)", displayValue(readError["code"]), displayValue(readError["field"]))
			hasError = true
		}
		rows = append(rows, row)
	}
	if hasError {
		columns = append(columns, column{title: "CONFIGURATION ERROR", key: "configurationReadError"})
	}
	return printTable(app.out, rows, columns)
}

func (app *application) printStructured(value any) error {
	switch app.output {
	case "json":
		if err := json.MarshalWrite(app.out, value, jsontext.WithIndent("  "), json.Deterministic(true)); err != nil {
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
			row[index] = tableCell(resource[column.key])
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
	encoded, err := json.Marshal(value, json.Deterministic(true))
	if err != nil {
		return "-"
	}
	return string(encoded)
}

// tableCell is displayValue with every non-graphic rune escaped. Names may hold
// bidirectional overrides, zero-width or C1 control characters (the Name
// contract rejects only C0 and DEL); printed raw they reorder or hide columns.
// A string is Go-quoted, as is one that starts with a quote so that a quoted
// cell always means escaping; a structured value keeps valid JSON \u escapes.
func tableCell(value any) string {
	text := displayValue(value)
	_, isString := value.(string)
	if isString && strings.HasPrefix(text, `"`) {
		return strconv.QuoteToGraphic(text)
	}
	if strings.IndexFunc(text, isHiddenRune) < 0 {
		return text
	}
	if isString {
		return strconv.QuoteToGraphic(text)
	}
	var escaped strings.Builder
	for _, character := range text {
		if !isHiddenRune(character) {
			escaped.WriteRune(character)
			continue
		}
		for _, unit := range utf16.Encode([]rune{character}) {
			fmt.Fprintf(&escaped, `\u%04x`, unit)
		}
	}
	return escaped.String()
}

func isHiddenRune(character rune) bool {
	return !unicode.IsGraphic(character)
}
