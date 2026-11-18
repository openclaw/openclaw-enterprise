// The admitted document of a deployment whose Configuration omits the roster: deployment serves
// the main Agent under the OCC Agent name (withAgentIdentityName).
export function servedAs<T extends Record<string, unknown>>(values: T, name: string) {
  return {
    ...values,
    agents: {
      ...Object.assign({}, values.agents),
      entries: { main: { identity: { name } } },
    },
  };
}
