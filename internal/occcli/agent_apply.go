package occcli

import (
	"crypto/rand"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"reflect"
	"slices"
	"strings"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
)

// applyAgentFields are the saved Agent fields that apply compares and sends.
// Each has the same shape in a provision body and on a read.
var applyAgentFields = []string{"backendId", "harnessAuth", "executionMode", "gatewayManagedMode", "plugins", "pluginApprovers"}

// applyCreateOnlyFields cannot change an existing Agent through apply: the update
// body lacks some, and a read returns others in a different shape than the request.
var applyCreateOnlyFields = []string{"initialWorkspaceFiles", "workspaceDefaultsId", "nativeAdmin", "repositoryBindings", "repositoryAccess"}

func (app *application) agentApplyCommand() *cobra.Command {
	var file string
	command := &cobra.Command{
		Use:     "apply --file FILE",
		Short:   "Create an Agent, or update the Agent with the same name and deploy it if a value changed",
		Example: agentApplyExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(file)
			if err != nil {
				return err
			}
			result, err := applyAgent(client, namespace, body)
			if err != nil {
				return err
			}
			return app.printItems(result, false, []column{
				{title: "RESULT", key: "result"},
				{title: "AGENT", key: "agentId"},
				{title: "REVISION", key: "revisionId"},
				{title: "WORK", key: "workId"},
			})
		},
	}
	command.Flags().StringVar(&file, "file", "", "JSON document path")
	_ = command.MarkFlagRequired("file")
	return command
}

func applyAgent(client *occclient.Client, namespace string, body jsontext.Value) (map[string]any, error) {
	var desired map[string]any
	if err := json.Unmarshal(body, &desired); err != nil || desired == nil {
		return nil, fmt.Errorf("the file must hold one JSON object")
	}
	name, _ := desired["name"].(string)
	if name == "" {
		return nil, fmt.Errorf("the file must set name; apply uses it to find the Agent")
	}
	if _, ok := desired["requestId"]; ok {
		return nil, fmt.Errorf("remove requestId from the file; apply sets it")
	}
	agent, err := findAgentByName(client, namespace, name)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return provisionAgent(client, namespace, desired)
	}
	return updateAgent(client, namespace, agent, desired)
}

func findAgentByName(client *occclient.Client, namespace, name string) (map[string]any, error) {
	listed, err := client.ListAgents(namespace)
	if err != nil {
		return nil, err
	}
	agents, ok := listed.([]any)
	if !ok {
		return nil, fmt.Errorf("OCC returned an invalid resource collection")
	}
	for _, item := range agents {
		if agent, ok := item.(map[string]any); ok && agent["name"] == name {
			return agent, nil
		}
	}
	return nil, nil
}

func provisionAgent(client *occclient.Client, namespace string, desired map[string]any) (map[string]any, error) {
	// A version 4 UUID, as the request ID pattern requires.
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	id := fmt.Sprintf("req_%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
	desired["requestId"] = id
	body, err := json.Marshal(desired)
	if err != nil {
		return nil, err
	}
	provisioned, err := client.ProvisionAgent(namespace, body)
	if err != nil {
		return nil, err
	}
	data, _ := provisioned.(map[string]any)
	provisioning, _ := data["provisioning"].(map[string]any)
	if provisioning == nil {
		return nil, fmt.Errorf("OCC returned an invalid provisioning response")
	}
	return map[string]any{
		"result":     "created",
		"agentId":    provisioning["agentId"],
		"revisionId": provisioning["revisionId"],
		"workId":     provisioning["workId"],
		"status":     provisioning["status"],
	}, nil
}

func updateAgent(client *occclient.Client, namespace string, agent, desired map[string]any) (map[string]any, error) {
	if fields := presentFields(desired, applyCreateOnlyFields); len(fields) > 0 {
		return nil, fmt.Errorf("apply cannot change %s on an existing Agent; remove them from the file or use occ agent update", strings.Join(fields, ", "))
	}
	agentID, _ := agent["id"].(string)
	configurationID, _ := agent["configurationId"].(string)
	wanted, _ := desired["configuration"].(map[string]any)
	if agentID == "" || configurationID == "" || wanted == nil {
		return nil, fmt.Errorf("the file must set configuration, and OCC must return the Agent's configurationId")
	}
	saved, err := client.GetConfiguration(namespace, configurationID)
	if err != nil {
		return nil, err
	}
	savedConfiguration, _ := saved.(map[string]any)
	if savedConfiguration["kind"] != wanted["kind"] {
		return nil, fmt.Errorf("the Agent's saved Configuration has another kind than the file; apply cannot change it")
	}

	// Omitted secretBindings keep their saved value, so only a listed set is compared.
	configurationChanged := !sameSetting(wanted["values"], savedConfiguration["values"])
	update := map[string]any{"values": wanted["values"], "expectedGeneration": savedConfiguration["generation"]}
	if bindings, ok := wanted["secretBindings"]; ok {
		update["secretBindings"] = bindings
		configurationChanged = configurationChanged || !sameSetting(bindings, savedConfiguration["secretBindings"])
	}
	patch := map[string]any{"configurationId": configurationID}
	agentChanged := false
	for _, field := range applyAgentFields {
		if value, ok := desired[field]; ok && !sameSetting(value, agent[field]) {
			patch[field] = value
			agentChanged = true
		}
	}
	if !configurationChanged && !agentChanged {
		return map[string]any{"result": "unchanged", "agentId": agentID, "revisionId": agent["activeRevisionId"]}, nil
	}

	if configurationChanged {
		body, err := json.Marshal(update)
		if err != nil {
			return nil, err
		}
		if _, err := client.UpdateConfiguration(namespace, configurationID, body); err != nil {
			return nil, err
		}
	}
	if agentChanged {
		body, err := json.Marshal(patch)
		if err != nil {
			return nil, err
		}
		if _, err := client.UpdateAgent(namespace, agentID, body); err != nil {
			return nil, fmt.Errorf("saved the Configuration but could not update the Agent; run apply again: %w", err)
		}
	}
	revision, err := client.DeployAgent(namespace, agentID, nil)
	if err != nil {
		return nil, fmt.Errorf("saved the changes but could not deploy; run \"occ agent deploy %s\": %w", agentID, err)
	}
	deployed, _ := revision.(map[string]any)
	return map[string]any{"result": "updated", "agentId": agentID, "revisionId": deployed["id"]}, nil
}

func presentFields(values map[string]any, fields []string) []string {
	return slices.DeleteFunc(slices.Clone(fields), func(field string) bool {
		_, ok := values[field]
		return !ok
	})
}

// sameSetting compares decoded JSON, and counts an omitted value and an empty
// object or list as the same setting.
func sameSetting(a, b any) bool {
	return reflect.DeepEqual(emptyToNil(a), emptyToNil(b))
}

func emptyToNil(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		if len(typed) == 0 {
			return nil
		}
	case []any:
		if len(typed) == 0 {
			return nil
		}
	}
	return value
}
