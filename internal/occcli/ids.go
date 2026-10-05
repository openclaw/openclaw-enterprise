package occcli

import (
	"fmt"
	"strings"

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
	agentIDArg            = idArg{kind: "Agent", prefix: "agt_", lookup: "occ agent list"}
	revisionIDArg         = idArg{kind: "deployment", prefix: "rev_", lookup: "occ agent revisions AGENT_ID"}
)

func optionalID(arg idArg) idArg {
	arg.optional = true
	return arg
}

func (arg idArg) check(value string) error {
	if strings.HasPrefix(value, arg.prefix) {
		return nil
	}
	return fmt.Errorf(
		"%q is not a valid %s ID: OCC accepts IDs that start with %q, not names; run %q to find the ID",
		value,
		arg.kind,
		arg.prefix,
		arg.lookup,
	)
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
		for index, value := range values {
			if err := args[index].check(value); err != nil {
				return err
			}
		}
		return nil
	}
}

// latestRevisionID picks the highest-numbered revision from a revision list.
func latestRevisionID(agentID string, value any) (string, error) {
	revisions, ok := value.([]any)
	if !ok {
		return "", fmt.Errorf("OCC returned an invalid resource collection")
	}
	latestID, latestNumber := "", -1.0
	for _, item := range revisions {
		revision, ok := item.(map[string]any)
		if !ok {
			return "", fmt.Errorf("OCC returned an invalid resource")
		}
		id, idOK := revision["id"].(string)
		number, numberOK := revision["revision"].(float64)
		if !idOK || !numberOK {
			return "", fmt.Errorf("OCC returned an invalid revision")
		}
		if number > latestNumber {
			latestID, latestNumber = id, number
		}
	}
	if latestID == "" {
		return "", fmt.Errorf("agent %s has no readable revisions; run \"occ agent deploy %s\" first", agentID, agentID)
	}
	return latestID, nil
}
