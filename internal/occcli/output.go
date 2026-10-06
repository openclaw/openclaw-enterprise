package occcli

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"maps"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
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

// visibleText escapes every invisible or control character in text, and any
// invalid UTF-8 byte, as a Go escape such as \u202e. OCC strips terminal
// escapes and C0/C1 controls from runtime log text but not bidirectional,
// zero-width or other format characters, which would reorder or hide what an
// operator's terminal shows. Escaping, not dropping, keeps the evidence.
func visibleText(text string) string {
	if strings.IndexFunc(text, isHiddenRune) < 0 && utf8.ValidString(text) {
		return text
	}
	var escaped strings.Builder
	for index := 0; index < len(text); {
		character, size := utf8.DecodeRuneInString(text[index:])
		switch {
		case character == utf8.RuneError && size == 1:
			fmt.Fprintf(&escaped, `\x%02x`, text[index])
		case isHiddenRune(character):
			quoted := strconv.QuoteRuneToGraphic(character)
			escaped.WriteString(quoted[1 : len(quoted)-1])
		default:
			escaped.WriteString(text[index : index+size])
		}
		index += size
	}
	return escaped.String()
}

// noticef prints one notice line to out with visibleText applied, since
// notices carry server-provided revision IDs, reasons and error messages.
func noticef(out io.Writer, format string, args ...any) {
	fmt.Fprintln(out, visibleText(fmt.Sprintf(format, args...)))
}

type runtimeLogRecord struct {
	Type      string         `json:"type"`
	Time      *string        `json:"time"`
	Level     string         `json:"level"`
	Kind      string         `json:"kind"`
	Subsystem string         `json:"subsystem"`
	Message   string         `json:"message"`
	Fields    map[string]any `json:"fields"`
	Reason    string         `json:"reason"`
	Remedy    string         `json:"remedy"`
	Count     int            `json:"count"`
}

func (app *application) printRuntimeLogPage(page *occclient.RuntimeLogPage, notices io.Writer) error {
	if string(page.Stream) == "null" || len(page.Stream) == 0 {
		noticef(notices, "notice: revision %s has no running Pod for source %s", page.RevisionID, page.Source)
	}
	for _, raw := range page.Records {
		var record runtimeLogRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return fmt.Errorf("OCC returned an invalid runtime log record")
		}
		at := "-"
		if record.Time != nil {
			at = *record.Time
		}
		switch record.Type {
		case "gap":
			noticef(notices, "notice: %s gap %s: %s", at, record.Reason, record.Remedy)
		case "withheld":
			noticef(notices, "notice: %s %d lines withheld (%s)", at, record.Count, record.Reason)
		}
		if app.output == "json" {
			// NDJSON: one record per line, exactly as OCC returned it.
			if _, err := fmt.Fprintln(app.out, string(raw)); err != nil {
				return err
			}
			continue
		}
		if record.Type != "line" {
			continue
		}
		if _, err := fmt.Fprintln(app.out, runtimeLogLineText(at, record)); err != nil {
			return err
		}
	}
	return nil
}

func runtimeLogLineText(at string, record runtimeLogRecord) string {
	var text strings.Builder
	fmt.Fprintf(&text, "%s %s %s", at, strings.ToUpper(record.Level), record.Kind)
	if record.Subsystem != "" {
		fmt.Fprintf(&text, " [%s]", record.Subsystem)
	}
	text.WriteString(" " + record.Message)
	names := make([]string, 0, len(record.Fields))
	for name := range record.Fields {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		value := displayValue(record.Fields[name])
		// Quote a value that is empty, holds a space (any Unicode space, which
		// would read as a field break) or a separator, or holds anything
		// strconv.Quote would escape.
		if value == "" || strings.ContainsAny(value, "\"=") || !utf8.ValidString(value) ||
			strings.ContainsFunc(value, func(character rune) bool { return character == ' ' || !strconv.IsPrint(character) }) {
			value = strconv.Quote(value)
		}
		fmt.Fprintf(&text, " %s=%s", name, value)
	}
	// Quoted values are already escaped; this covers the message and the rest.
	return visibleText(text.String())
}

func (app *application) printRuntime(description any) error {
	resource, ok := description.(map[string]any)
	if !ok {
		return fmt.Errorf("OCC returned an invalid runtime description")
	}
	pods, _ := resource["pods"].([]any)
	rows := make([]any, 0, len(pods))
	events := []any{}
	for _, item := range pods {
		pod, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("OCC returned an invalid runtime description")
		}
		podEvents, _ := pod["events"].([]any)
		for _, entry := range podEvents {
			event, ok := entry.(map[string]any)
			if !ok {
				return fmt.Errorf("OCC returned an invalid runtime description")
			}
			events = append(events, map[string]any{
				"pod":            pod["name"],
				"container":      event["container"],
				"type":           event["type"],
				"reason":         event["reason"],
				"count":          event["count"],
				"lastObservedAt": event["lastObservedAt"],
				"message":        event["message"],
			})
		}
		row := map[string]any{
			"role":    pod["role"],
			"name":    pod["name"],
			"cluster": pod["cluster"],
			"phase":   pod["phase"],
			"ready":   pod["ready"],
		}
		containers, _ := pod["containers"].([]any)
		for _, entry := range containers {
			container, _ := entry.(map[string]any)
			if container["name"] != pod["role"] && len(containers) > 1 {
				continue
			}
			row["restarts"] = container["restartCount"]
			row["state"] = container["state"]
			if termination, ok := container["lastTermination"].(map[string]any); ok {
				parts := []string{}
				if reason, ok := termination["reason"].(string); ok {
					parts = append(parts, reason)
				}
				if code, ok := termination["exitCode"].(float64); ok {
					parts = append(parts, fmt.Sprintf("exit %d", int(code)))
				}
				row["lastTermination"] = strings.Join(parts, " ")
			}
			break
		}
		rows = append(rows, row)
	}
	if err := printTable(app.out, rows, []column{
		{title: "ROLE", key: "role"},
		{title: "POD", key: "name"},
		{title: "CLUSTER", key: "cluster"},
		{title: "PHASE", key: "phase"},
		{title: "READY", key: "ready"},
		{title: "STATE", key: "state"},
		{title: "RESTARTS", key: "restarts"},
		{title: "LAST TERMINATION", key: "lastTermination"},
	}); err != nil {
		return err
	}
	sources, _ := resource["sources"].([]any)
	if len(sources) > 0 {
		if _, err := fmt.Fprintln(app.out); err != nil {
			return err
		}
		if err := printTable(app.out, sources, []column{
			{title: "SOURCE", key: "id"},
			{title: "AVAILABLE", key: "available"},
			{title: "RETENTION", key: "retention"},
		}); err != nil {
			return err
		}
	}
	if len(events) == 0 {
		return nil
	}
	if _, err := fmt.Fprintln(app.out); err != nil {
		return err
	}
	// Pod Events arrive newest first per Pod; CONTAINER is "-" for Pod-level Events.
	return printTable(app.out, events, []column{
		{title: "POD", key: "pod"},
		{title: "CONTAINER", key: "container"},
		{title: "TYPE", key: "type"},
		{title: "REASON", key: "reason"},
		{title: "COUNT", key: "count"},
		{title: "LAST SEEN", key: "lastObservedAt"},
		{title: "MESSAGE", key: "message"},
	})
}
