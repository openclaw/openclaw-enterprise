package occcli

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
)

const (
	runtimeLogFollowInterval = 2 * time.Second
	runtimeLogFollowTail     = "1000"
)

// sleepContext waits for d or until ctx is done. Tests replace it.
var sleepContext = func(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// agentRevision returns the requested revision, or the Agent's active revision.
// Without an active revision (for example, after a failed first deploy) it uses
// the latest revision and says so on notices, because that is the version whose
// Pods and output explain the failure. When it had to read the chosen revision's
// runtime description to decide, it returns that description too (else nil).
func (app *application) agentRevision(
	client *occclient.Client,
	notices io.Writer,
	namespace, agentID, revision string,
) (string, any, error) {
	if revision != "" {
		if err := revisionIDArg.check(revision); err != nil {
			return "", nil, err
		}
		return revision, nil, nil
	}
	agent, err := client.GetAgent(namespace, agentID)
	if err != nil {
		return "", nil, err
	}
	resource, _ := agent.(map[string]any)
	active, _ := resource["activeRevisionId"].(string)
	if active == "" {
		revisions, err := client.ListAgentRevisions(namespace, agentID)
		if err != nil {
			return "", nil, err
		}
		latest, err := latestRevisionID(agentID, revisions)
		if err != nil {
			return "", nil, err
		}
		noticef(notices, "agent %s has no active revision; using latest revision %s", agentID, latest)
		return latest, nil, nil
	}
	// A newer revision than the active one is being deployed or has failed; while
	// its Pods exist they hold the current failure, and the active revision may
	// have none (a dedicated replacement stops its predecessor).
	probe := newerRevisionWithPods(client, namespace, agentID, active)
	switch {
	case probe.hasPods:
		noticef(
			notices,
			"notice: reading revision %s, newer than the active revision %s and not yet active; pass --revision %s for the active revision",
			probe.latest, active, active,
		)
		return probe.latest, probe.description, nil
	case probe.err != nil:
		// The runtime probe needs more permission than reading logs, so a log
		// reader may be refused here yet allowed to read the newer revision.
		noticef(
			notices,
			"notice: reading the active revision %s; a newer revision %s exists but its runtime could not be read (%v); pass --revision %s to read it",
			active, probe.latest, probe.err, probe.latest,
		)
	default:
		noticef(notices, "notice: reading the active revision %s", active)
	}
	return active, nil, nil
}

// newerRevision is the result of probing for a revision newer than the active one.
type newerRevision struct {
	// latest is the newer revision, or "" when there is none or the list failed.
	latest string
	// hasPods reports that latest's runtime description lists Pods.
	hasPods bool
	// description is latest's runtime description when it was read.
	description any
	// err is the failure to read latest's runtime description.
	err error
}

// newerRevisionWithPods looks for a latest revision that is not the active one
// and reads its runtime description to see whether it has Pods. A failure to
// list revisions keeps the active revision silently.
func newerRevisionWithPods(client *occclient.Client, namespace, agentID, active string) newerRevision {
	revisions, err := client.ListAgentRevisions(namespace, agentID)
	if err != nil {
		return newerRevision{}
	}
	latest, err := latestRevisionID(agentID, revisions)
	if err != nil || latest == active {
		return newerRevision{}
	}
	description, err := client.GetAgentRuntime(namespace, agentID, latest)
	if err != nil {
		return newerRevision{latest: latest, err: err}
	}
	resource, _ := description.(map[string]any)
	pods, _ := resource["pods"].([]any)
	return newerRevision{latest: latest, hasPods: len(pods) > 0, description: description}
}

func (app *application) agentRuntimeCommand() *cobra.Command {
	var revision string
	command := &cobra.Command{
		Use:   "runtime AGENT_ID",
		Short: "Show Pod status, restarts, last termination and log sources for an Agent revision",
		Args:  idArgs(agentIDArg),
		RunE: func(command *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			revisionID, description, err := app.agentRevision(client, command.ErrOrStderr(), namespace, args[0], revision)
			if err != nil {
				return err
			}
			if description == nil {
				description, err = client.GetAgentRuntime(namespace, args[0], revisionID)
				if err != nil {
					return err
				}
			}
			if app.output != "table" {
				return app.printStructured(description)
			}
			return app.printRuntime(description)
		},
	}
	command.Flags().StringVar(&revision, "revision", "", "Revision ID (default: a newer not-yet-active revision that has Pods, else the active revision, else the latest revision)")
	return command
}

type runtimeLogOptions struct {
	source   string
	revision string
	pod      string
	previous bool
	tail     int
	since    time.Duration
	follow   bool
	level    string
}

func (app *application) agentLogsCommand() *cobra.Command {
	options := runtimeLogOptions{}
	command := &cobra.Command{
		Use:   "logs AGENT_ID",
		Short: "Print redacted container or sandbox output for an Agent revision",
		Long: "Print one bounded, redacted page of Gateway or Harness container output, or of the\n" +
			"Agent's sandbox policy decisions (--source sandbox).\n" +
			"Requires Agent read_logs (or administer) and read. Each view is audited.\n" +
			"--follow polls every 2 seconds with the view's cursor until interrupted.",
		Args:        idArgs(agentIDArg),
		Annotations: map[string]string{outputFormatsAnnotation: "text,json"},
		RunE: func(command *cobra.Command, args []string) error {
			return app.runAgentLogs(command, args[0], options)
		},
	}
	flags := command.Flags()
	flags.StringVar(&options.source, "source", "", "Log source: gateway, agent or sandbox")
	flags.StringVar(&options.revision, "revision", "", "Revision ID (default: a newer not-yet-active revision that has Pods, else the active revision, else the latest revision)")
	flags.StringVar(&options.pod, "pod", "", "Pod name (default: the source's first Pod)")
	flags.BoolVar(&options.previous, "previous", false, "Read the previous container instance")
	flags.IntVar(&options.tail, "tail", 200, "Lines from the end of the stream, 1 to 1000")
	flags.DurationVar(&options.since, "since", 0, "Only lines newer than this duration, up to 24h")
	flags.BoolVar(&options.follow, "follow", false, "Poll for new lines every 2 seconds")
	flags.StringVar(&options.level, "level", "", "Minimum level: error, warn, info or debug (default: every level; lines of unknown level are always shown)")
	_ = command.MarkFlagRequired("source")
	return command
}

func (options runtimeLogOptions) query() (url.Values, error) {
	switch options.source {
	case "gateway", "agent":
	case "sandbox":
		if options.pod != "" || options.previous {
			return nil, fmt.Errorf("--pod and --previous do not apply to --source sandbox")
		}
	default:
		return nil, fmt.Errorf("invalid --source %q: expected gateway, agent or sandbox", options.source)
	}
	if options.tail < 1 || options.tail > 1000 {
		return nil, fmt.Errorf("--tail must be between 1 and 1000")
	}
	if options.since < 0 || options.since > 24*time.Hour {
		return nil, fmt.Errorf("--since must be between 1s and 24h")
	}
	if options.follow && options.previous {
		return nil, fmt.Errorf("--follow cannot be combined with --previous: the previous instance does not change")
	}
	switch options.level {
	case "", "error", "warn", "info", "debug":
	default:
		return nil, fmt.Errorf("invalid --level %q: expected error, warn, info or debug", options.level)
	}
	query := url.Values{
		"source":    {options.source},
		"tailLines": {strconv.Itoa(options.tail)},
	}
	if options.pod != "" {
		query.Set("pod", options.pod)
	}
	if options.previous {
		query.Set("previous", "true")
	}
	if options.since > 0 {
		query.Set("sinceSeconds", strconv.Itoa(max(1, int(math.Ceil(options.since.Seconds())))))
	}
	if options.level != "" {
		query.Set("minLevel", options.level)
	}
	return query, nil
}

func (app *application) runAgentLogs(command *cobra.Command, agentID string, options runtimeLogOptions) error {
	query, err := options.query()
	if err != nil {
		return err
	}
	namespace, client, err := app.namespaceClient()
	if err != nil {
		return err
	}
	ctx := cmp.Or(app.ctx, context.Background())
	notices := command.ErrOrStderr()
	revisionID, _, err := app.agentRevision(client, notices, namespace, agentID, options.revision)
	if err != nil {
		if options.follow && ctx.Err() != nil {
			return nil
		}
		return err
	}
	cursor := ""
	for {
		pageQuery := query
		if cursor != "" {
			// A cursor continues the view; the server derives the window from it.
			pageQuery = url.Values{
				"source":    query["source"],
				"tailLines": {runtimeLogFollowTail},
				"cursor":    {cursor},
			}
			if pod := query.Get("pod"); pod != "" {
				pageQuery.Set("pod", pod)
			}
			if level := query.Get("minLevel"); level != "" {
				pageQuery.Set("minLevel", level)
			}
		}
		page, err := client.GetAgentRuntimeLogs(namespace, agentID, revisionID, pageQuery)
		wait := runtimeLogFollowInterval
		if err != nil {
			if options.follow && ctx.Err() != nil {
				return nil
			}
			var apiErr *occclient.APIError
			if !options.follow || !errors.As(err, &apiErr) {
				return err
			}
			switch {
			case apiErr.Status == http.StatusTooManyRequests:
				wait = max(wait, apiErr.RetryAfter)
				fmt.Fprintf(notices, "notice: rate limited; retrying in %s\n", wait)
			case apiErr.Status == http.StatusGatewayTimeout:
				fmt.Fprintf(notices, "notice: the read timed out; retrying in %s\n", wait)
			case apiErr.Status == http.StatusBadRequest && apiErr.Code == "RUNTIME_LOGS_CURSOR_INVALID" && cursor != "":
				fmt.Fprintln(notices, "notice: the cursor was rejected; starting a new view")
				cursor = ""
				continue
			default:
				// 501 and 503 (and every other failure) end the command with a non-zero exit.
				return err
			}
		} else {
			if err := app.printRuntimeLogPage(page, notices); err != nil {
				return err
			}
			if !options.follow {
				return nil
			}
			if page.Cursor == nil {
				cursor = ""
			} else {
				cursor = *page.Cursor
			}
		}
		if ctx.Err() != nil {
			return nil
		}
		if err := sleepContext(ctx, wait); err != nil {
			return nil
		}
	}
}
