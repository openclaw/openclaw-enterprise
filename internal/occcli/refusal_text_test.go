package occcli

import "fmt"

// Refusal sentences occ writes itself, built once so a wording change is one
// edit here instead of a hunt through pasted copies. Each builder mirrors one
// product format; tests still compare whole messages.

// nameNotIDRefusal is the refusal for a value without the ID prefix: occ takes
// it for a name and points at the command that lists the IDs.
func nameNotIDRefusal(value, kind, prefix, lookup string) string {
	return fmt.Sprintf("%q is not a valid %s ID: OCC accepts IDs that start with %q, not names; run %q to find the ID", value, kind, prefix, lookup)
}

// malformedIDRefusal is the refusal for a value with the ID prefix but not the
// UUID shape the API accepts (finding D744).
func malformedIDRefusal(value, kind, prefix string) string {
	return fmt.Sprintf("%q is not a valid %s ID: expected %s followed by a UUID", value, kind, prefix)
}

// opaqueIDRefusal is the refusal for a server-issued ID without a fixed shape
// that contains "/" or is made only of dots.
func opaqueIDRefusal(value, kind string) string {
	return fmt.Sprintf("%q is not a valid %s ID: IDs never contain \"/\" or consist only of dots", value, kind)
}

// grantHint is the hint occ adds to a FORBIDDEN refusal. A command that takes
// an ID also says an unknown ID is refused the same way.
func grantHint(path, needs string, takesID bool) string {
	hint := fmt.Sprintf("hint: \"occ %s\" needs %s; ask an Installation administrator to grant what is missing.", path, needs)
	if takesID {
		hint += " OCC refuses an ID that does not exist the same way."
	}
	return hint
}

// createHint is the hint for a refused create: no Role can hold create, so it
// says who creates the resource instead of asking for a grant (finding 2607).
func createHint(path, needs, kinds string) string {
	return fmt.Sprintf("hint: \"occ %s\" needs %s. Only an Installation administrator can create %s: ask one to create it.", path, needs, kinds)
}

// revisionReadAdvice ends the refusal for an Agent with no revision the
// caller can read.
const revisionReadAdvice = "listing revisions needs AgentRevision read (ask an Installation administrator to grant it)"

// noReadableRevision is the start of that refusal when the Agent also has no
// active revision (agent logs and agent runtime).
func noReadableRevision(agentID string) string {
	return "agent " + agentID + " has no active revision and no revision you can read; " + revisionReadAdvice
}
