package occcli

import (
	"encoding/json/v2"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

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
