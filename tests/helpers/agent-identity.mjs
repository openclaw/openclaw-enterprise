// The admitted document of a deployment whose Configuration omits the roster: deployment serves
// the main Agent under the OCC Agent name (withAgentIdentityName).
export function servedAs(values, name) {
  return { ...values, agents: { ...values.agents, entries: { main: { identity: { name } } } } };
}
