package occcli

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
)

// commandPermission names what one command's main OCC request needs.
type commandPermission struct {
	// operations are the OpenAPI operationIds whose permissions needs lists.
	operations []string
	// needs are the operations' unconditional permissions, as resourceKind.action
	// from x-openclaw-permissions in packages/contracts/openapi/occ-api.openapi.json.
	needs []string
	// also names conditional grants in prose; a parenthetical such as
	// "(or administer)" names an alternative to the first permission.
	also string
}

// commandPermissions is the hint table for refused commands, keyed by the
// command path after "occ". OCC refuses with one generic message that is the
// same for a missing and an inaccessible object, so the hint is static per
// command: it names the grants the command needs and nothing about the object.
var commandPermissions = map[string]commandPermission{
	"installation get":                    {[]string{"getInstallation"}, []string{"installation.read"}, ""},
	"installation deployment-inventory":   {[]string{"getInstallationDeploymentInventory"}, []string{"installation.administer"}, "read on every Namespace, Agent and active revision, and deploy on each running Agent"},
	"namespace list":                      {[]string{"listNamespaces"}, nil, ""},
	"namespace get":                       {[]string{"getNamespace"}, []string{"namespace.read"}, ""},
	"namespace create":                    {[]string{"createNamespace"}, []string{"namespace.create"}, "Installation administer with --existing-namespace"},
	"namespace delete":                    {[]string{"deleteNamespace"}, []string{"namespace.delete"}, ""},
	"configuration create":                {[]string{"createConfiguration"}, []string{"configuration.create"}, "Secret operate on each Secret it binds"},
	"configuration get":                   {[]string{"getConfiguration"}, []string{"configuration.read"}, ""},
	"configuration update":                {[]string{"updateConfiguration"}, []string{"configuration.update"}, "Secret operate on each Secret it binds"},
	"configuration delete":                {[]string{"deleteConfiguration"}, []string{"configuration.delete"}, ""},
	"secret create":                       {[]string{"createSecret"}, []string{"secret.create"}, ""},
	"secret list":                         {[]string{"listSecrets"}, []string{"namespace.read"}, ""},
	"secret get":                          {[]string{"getSecret"}, []string{"secret.read"}, ""},
	"secret update":                       {[]string{"updateSecret"}, []string{"secret.update"}, ""},
	"secret delete":                       {[]string{"deleteSecret"}, []string{"secret.delete"}, ""},
	"preset list":                         {[]string{"listPresets"}, []string{"namespace.read"}, ""},
	"preset get":                          {[]string{"getPreset"}, []string{"preset.read"}, ""},
	"preset delete":                       {[]string{"deletePreset"}, []string{"preset.delete"}, ""},
	"credential-source create":            {[]string{"createCredentialSource"}, []string{"credential_source.create"}, "Secret operate on the Secret it registers"},
	"credential-source list":              {[]string{"listCredentialSources"}, []string{"namespace.read"}, ""},
	"credential-source get":               {[]string{"getCredentialSource"}, []string{"credential_source.read"}, ""},
	"credential-source delete":            {[]string{"deleteCredentialSource"}, []string{"credential_source.delete"}, ""},
	"credential-source update":            {[]string{"updateCredentialSource"}, []string{"credential_source.update"}, "Secret operate on each Secret it binds"},
	"credential-source rotate":            {[]string{"rotateCredentialSource"}, []string{"credential_source.update"}, ""},
	"service-account list":                {[]string{"listServiceAccounts"}, []string{"namespace.read"}, ""},
	"service-account delete":              {[]string{"deleteServiceAccount"}, []string{"service_account.delete"}, ""},
	"iam role list":                       {[]string{"listIAMRoles"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam role get":                        {[]string{"getIAMRole"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam role create":                     {[]string{"createIAMRole"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam role delete":                     {[]string{"deleteIAMRole"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam access-binding list":             {[]string{"listIAMAccessBindings"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam access-binding get":              {[]string{"getIAMAccessBinding"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam access-binding create":           {[]string{"createIAMAccessBinding"}, []string{"installation.administer", "namespace.read"}, "read on the bound resource"},
	"iam access-binding delete":           {[]string{"deleteIAMAccessBinding"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam service-principal create":        {[]string{"createIAMServicePrincipal"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam service-principal list":          {[]string{"listIAMServicePrincipals"}, []string{"installation.administer", "namespace.read"}, ""},
	"iam service-principal get":           {[]string{"getIAMServicePrincipal"}, []string{"installation.administer", "namespace.read"}, ""},
	"service-key create":                  {[]string{"createServiceKey"}, []string{"installation.administer"}, ""},
	"service-key revoke":                  {[]string{"revokeServiceKey"}, []string{"installation.administer"}, ""},
	"agent create":                        {[]string{"createAgent"}, []string{"agent.create", "configuration.read"}, "access to the ServiceAccount, Secrets and credential sources it binds"},
	"agent list":                          {[]string{"listAgents"}, []string{"namespace.read"}, ""},
	"agent get":                           {[]string{"getAgent"}, []string{"agent.read"}, ""},
	"agent update":                        {[]string{"updateAgent"}, []string{"agent.update", "configuration.read"}, "access to the ServiceAccount, Secrets and credential sources it binds"},
	"agent deploy":                        {[]string{"deployAgent"}, []string{"agent.deploy", "configuration.read"}, "access to the ServiceAccount, Secrets and credential sources it binds, and Agent read and operate for a first deploy"},
	"agent revisions":                     {[]string{"listAgentRevisions"}, []string{"agent.read"}, ""},
	"agent deployment-status":             {[]string{"getAgentDeployment"}, []string{"agent_revision.read"}, "Agent read without DEPLOYMENT_ID"},
	"agent stop":                          {[]string{"stopAgent"}, []string{"agent.operate"}, ""},
	"agent delete":                        {[]string{"deleteAgent"}, []string{"agent.delete"}, ""},
	"agent runtime-credentials get":       {[]string{"getAgentRuntimeCredentials"}, []string{"agent.read"}, ""},
	"agent runtime-credentials provision": {[]string{"provisionAgentRuntimeCredentials"}, []string{"agent.operate", "agent.read"}, ""},
	"agent credential-withdrawal request": {[]string{"withdrawAgentCredentialSource"}, []string{"agent.operate"}, ""},
	"agent credential-withdrawal get":     {[]string{"getAgentCredentialWithdrawal"}, []string{"agent.read"}, ""},
	"agent runtime":                       {[]string{"getAgentDeploymentRuntime"}, []string{"agent.operate", "agent.read", "agent_revision.read"}, ""},
	"agent logs":                          {[]string{"getAgentDeploymentRuntimeLogs"}, []string{"agent.read_logs", "agent.read"}, "(or administer)"},
	"agent policy get":                    {[]string{"getAgentSandboxPolicy"}, []string{"agent.read", "sandbox_policy.read"}, ""},
	"agent policy update":                 {[]string{"updateAgentSandboxPolicy"}, []string{"agent.manage_policy", "sandbox_policy.update"}, ""},
	"agent policy apply":                  {[]string{"applyAgentSandboxPolicy"}, []string{"agent.manage_policy", "sandbox_policy.update"}, ""},
	"agent policy editing":                {[]string{"TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing"}, []string{"agent.administer", "installation.administer"}, ""},
	"agent policy recommendations":        {[]string{"getAgentSandboxRecommendations"}, []string{"agent.read", "sandbox_policy.read"}, ""},
}

// permissionKinds names OCC resource kinds as the console and docs do.
var permissionKinds = map[string]string{
	"installation":      "Installation",
	"namespace":         "Namespace",
	"agent":             "Agent",
	"agent_revision":    "AgentRevision",
	"configuration":     "Configuration",
	"secret":            "Secret",
	"preset":            "Preset",
	"credential_source": "credential source",
	"service_account":   "ServiceAccount",
	"sandbox_policy":    "SandboxPolicy",
}

// OCC's two caller-scope refusals that get a hint: the generic one, which names
// no cause, and a Namespace-scoped key's refusal outside its Namespace, which
// starts with admittedNamespacePrefix and names the key's Namespace (finding
// D763). Other 403 messages name their own cause and get no hint: an Agent
// principal's missing grant, or the caller's own missing grant, which OCC names
// after "Not authorized:" (finding 2534). Only an older OCC sends
// genericRefusal for every caller denial.
const (
	genericRefusal          = "The exact platform operation was not authorized."
	admittedNamespacePrefix = "This service key works only in Namespace "
)

// installationCommands reach no Namespace, so a Namespace-scoped key is
// refused whichever Namespace is selected.
var installationCommands = map[string]bool{
	"installation get":                  true,
	"installation deployment-inventory": true,
	"namespace list":                    true,
	"namespace create":                  true,
	"service-key create":                true,
	"service-key revoke":                true,
}

// keyNamespacePattern accepts a plain Namespace ID from the key file; anything
// else, such as a hand-edited value with control characters, is not printed.
var keyNamespacePattern = regexp.MustCompile(`^ns_[A-Za-z0-9-]{1,64}$`)

// refusalHint returns one hint line for OCC's generic or admitted-Namespace
// 403 from the command, or "". It depends only on the command and the caller's
// own key file, never on the requested IDs, so a real and a fake ID still print
// the same.
func (app *application) refusalHint(command *cobra.Command, path string, err error) string {
	var apiErr *occclient.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden || apiErr.Code != "FORBIDDEN" {
		return ""
	}
	switch {
	case strings.HasPrefix(apiErr.Message, admittedNamespacePrefix):
		// OCC's message already says which Namespace the key works in and to ask an
		// Installation administrator, so the hint adds only what to change here
		// (finding D770).
		namespace := apiErr.ServiceKeyNamespace
		if installationCommands[path] {
			// No --namespace helps here: the command reaches no Namespace (finding D740).
			if !keyNamespacePattern.MatchString(namespace) {
				return fmt.Sprintf("hint: \"occ %s\" needs an Installation-scoped key; no --namespace value helps.", path)
			}
			return fmt.Sprintf(
				"hint: \"occ %s\" needs an Installation-scoped key; no --namespace value helps. Read this key's Namespace with \"occ namespace get %s\".",
				path, namespace,
			)
		}
		if !keyNamespacePattern.MatchString(namespace) {
			return "hint: pass this key's Namespace ID with --namespace (or OCC_NAMESPACE) and read it with \"occ namespace get ID\"; other Namespaces and Installation-level commands such as \"occ namespace list\" need an Installation-scoped key."
		}
		return fmt.Sprintf(
			"hint: pass --namespace %s (or set OCC_NAMESPACE) and read it with \"occ namespace get %s\"; other Namespaces and Installation-level commands such as \"occ namespace list\" need an Installation-scoped key.",
			namespace, namespace,
		)
	case apiErr.Message == genericRefusal:
	default:
		return ""
	}
	permission, ok := commandPermissions[path]
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(permission.needs))
	created := ""
	for _, need := range permission.needs {
		kind, action, _ := strings.Cut(need, ".")
		parts = append(parts, permissionKinds[kind]+" "+action)
		if action == "create" {
			created = permissionKinds[kind]
		}
	}
	also := permission.also
	if strings.HasPrefix(also, "(") && len(parts) > 0 {
		// A parenthetical qualifies the first permission: "read_logs (or administer)".
		parts[0] += " " + also
		also = ""
	}
	needs := strings.Join(parts, " and ")
	if len(parts) > 2 {
		needs = strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
	}
	switch {
	case needs == "":
		// Nothing to grant: a list filtered per item refuses only a scoped key.
		return ""
	case also != "":
		needs += ", plus " + also
	}
	hint := fmt.Sprintf("hint: \"occ %s\" needs %s; ask an Installation administrator to grant what is missing.", path, needs)
	if created != "" {
		// No Role can hold create, so a create asks for the resource, as OCC and
		// the console do, instead of a grant nobody can give (finding 2607).
		hint = fmt.Sprintf("hint: \"occ %s\" needs %s. Only an Installation administrator can create %ss: ask one to create it.", path, needs, created)
	}
	if strings.Contains(command.Use, "ID") {
		hint += " OCC refuses an ID that does not exist the same way."
	}
	return hint
}

// refusalHintError appends a hint line to a refused command's error.
type refusalHintError struct {
	err  error
	hint string
}

func (err *refusalHintError) Error() string { return err.err.Error() + "\n" + err.hint }
func (err *refusalHintError) Unwrap() error { return err.err }

// addRefusalHints wraps every runnable command under root so a 403 also
// prints the hint for that command.
func (app *application) addRefusalHints(root *cobra.Command) {
	for _, command := range root.Commands() {
		app.addRefusalHints(command)
		run := command.RunE
		if run == nil || command.HasSubCommands() {
			continue
		}
		path := strings.TrimPrefix(command.CommandPath(), root.Root().Name()+" ")
		command.RunE = func(command *cobra.Command, args []string) error {
			app.commandPath = path
			err := run(command, args)
			if hint := app.refusalHint(command, path, err); hint != "" {
				return &refusalHintError{err: err, hint: hint}
			}
			return err
		}
	}
}
