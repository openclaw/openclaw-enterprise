package occcli

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
)

// idArg describes one resource ID argument. OCC addresses resources only by
// ID, so the CLI rejects an obvious name locally and says where to find the ID
// instead of sending it and returning the API's generic contract error.
type idArg struct {
	kind     string
	prefix   string
	lookup   string
	optional bool
}

var (
	namespaceIDArg        = idArg{kind: "Namespace", prefix: "ns_", lookup: "occ namespace list"}
	configurationIDArg    = idArg{kind: "Configuration", prefix: "cfg_", lookup: "occ agent get AGENT_ID"}
	secretIDArg           = idArg{kind: "Secret", prefix: "sec_", lookup: "occ secret list"}
	presetIDArg           = idArg{kind: "Preset", prefix: "pre_", lookup: "occ preset list"}
	credentialSourceIDArg = idArg{kind: "credential source", prefix: "cs_", lookup: "occ credential-source list"}
	serviceAccountIDArg   = idArg{kind: "ServiceAccount", prefix: "sa_", lookup: "occ service-account list"}
	agentIDArg            = idArg{kind: "Agent", prefix: "agt_", lookup: "occ agent list"}
	revisionIDArg         = idArg{kind: "deployment", prefix: "rev_", lookup: "occ agent revisions AGENT_ID"}
)

func optionalID(arg idArg) idArg {
	arg.optional = true
	return arg
}

// uuidV4 is the suffix shape the OCC API accepts after every typed ID prefix
// (the path parameter patterns in the OpenAPI contract): a lowercase version 4 UUID.
var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// check accepts a value with the ID prefix followed by the UUID shape the API
// accepts, so a value such as "agt_../../namespaces" is never sent: a gateway
// can normalize it into another path and answer with a redirect (finding D744).
// A value without the prefix is plainly a name; the refusal names the lookup
// command, and for a Namespace-scoped resource it carries the selected
// Namespace when that is a Namespace ID, so a stale OCC_NAMESPACE cannot
// redirect the lookup.
func (arg idArg) check(value, namespace string) error {
	if suffix, ok := strings.CutPrefix(value, arg.prefix); ok && uuidV4.MatchString(suffix) {
		return nil
	}
	if strings.HasPrefix(strings.ToLower(value), arg.prefix) {
		return fmt.Errorf("%q is not a valid %s ID: expected %s followed by a UUID", value, arg.kind, arg.prefix)
	}
	lookup := arg.lookup
	if arg.prefix != namespaceIDArg.prefix && namespaceIDArg.check(namespace, "") == nil {
		lookup = "occ --namespace " + namespace + strings.TrimPrefix(lookup, "occ")
	}
	return fmt.Errorf(
		"%q is not a valid %s ID: OCC accepts IDs that start with %q, not names; run %q to find the ID",
		value,
		arg.kind,
		arg.prefix,
		lookup,
	)
}

// opaqueIDArgs accepts one server-issued ID that has no fixed shape in the API
// contract (ServicePrincipal, Role, AccessBinding and service-key IDs). OCC
// never issues one containing "/" or made only of dots, and such a value would
// not reach the API as one path segment, so it is refused locally.
func opaqueIDArgs(kind string) cobra.PositionalArgs {
	return func(command *cobra.Command, values []string) error {
		if err := cobra.ExactArgs(1)(command, values); err != nil {
			return err
		}
		value := values[0]
		if strings.Contains(value, "/") || strings.Trim(value, ".") == "" {
			return fmt.Errorf("%q is not a valid %s ID: IDs never contain \"/\" or consist only of dots", value, kind)
		}
		return nil
	}
}

// idArgs accepts exactly the listed IDs, with optional IDs allowed only at the end.
func idArgs(args ...idArg) cobra.PositionalArgs {
	required := 0
	for _, arg := range args {
		if !arg.optional {
			required++
		}
	}
	return func(command *cobra.Command, values []string) error {
		if err := cobra.RangeArgs(required, len(args))(command, values); err != nil {
			return err
		}
		// Flags are parsed before positional arguments are checked.
		namespace := ""
		if flag := command.Flag("namespace"); flag != nil {
			namespace = flag.Value.String()
		}
		for index, value := range values {
			if err := args[index].check(value, namespace); err != nil {
				return err
			}
		}
		return nil
	}
}

// latestRevisionID returns the ID of the newest revision the caller can read.
func latestRevisionID(client *occclient.Client, namespace, agentID string) (string, error) {
	id, _, err := latestReadableRevision(client, namespace, agentID)
	return id, err
}

// errNoReadableRevisions reports an empty revision list. OCC filters the list
// by revision read, so the Agent has no revisions or the caller may read none.
var errNoReadableRevisions = errors.New("no readable revisions")

// latestReadableRevision retains the summary number for ordering diagnostics.
// It returns errNoReadableRevisions when the list is empty.
func latestReadableRevision(client *occclient.Client, namespace, agentID string) (string, float64, error) {
	latest, err := client.LatestAgentRevision(namespace, agentID)
	if err != nil {
		return "", 0, err
	}
	if latest == nil {
		return "", 0, errNoReadableRevisions
	}
	revision, ok := latest.(map[string]any)
	if !ok {
		return "", 0, fmt.Errorf("OCC returned an invalid resource")
	}
	id, idOK := revision["id"].(string)
	number, numberOK := revision["revision"].(float64)
	if !idOK || !numberOK {
		return "", 0, fmt.Errorf("OCC returned an invalid revision")
	}
	return id, number, nil
}

// noReadableRevisionsError explains an empty revision list. The list cannot
// tell an Agent that was never deployed from one whose revisions the caller may
// not read, so deploy advice goes only to a caller whose permission answer
// allows Agent deploy, and everyone else learns which grant lists revisions
// (finding 522). alternative names another way in, such as passing an ID.
func noReadableRevisionsError(client *occclient.Client, namespace, agentID, subject, alternative string) error {
	grant := "listing revisions needs revision read (ask an administrator to grant it)"
	if alternative != "" {
		grant += ", or " + alternative
	}
	permissions, err := client.GetAgentCallerPermissions(namespace, agentID)
	resource, _ := permissions.(map[string]any)
	if deploy, _ := resource["deploy"].(bool); err == nil && deploy {
		return fmt.Errorf(
			"%s; if it was never deployed, run \"occ --namespace %s agent deploy %s\" first; otherwise %s",
			subject, namespace, agentID, grant,
		)
	}
	return fmt.Errorf("%s; %s", subject, grant)
}
