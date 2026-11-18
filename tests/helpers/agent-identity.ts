type ConfigurationDocument = Record<string, unknown> & { agents?: Record<string, unknown> };
type AgentFields<T extends ConfigurationDocument> = T extends { agents: Record<string, unknown> }
  ? Omit<T["agents"], "entries">
  : Partial<Omit<NonNullable<T["agents"]>, "entries">>;
type ServedDocument<T extends ConfigurationDocument> = Omit<T, "agents"> & {
  agents: AgentFields<T> & { entries: { main: { identity: { name: string } } } };
};

// The admitted document of a deployment whose Configuration omits the roster: deployment serves
// the main Agent under the OCC Agent name (withAgentIdentityName).
export function servedAs<T extends ConfigurationDocument>(
  values: T,
  name: string,
): ServedDocument<T>;
export function servedAs(values: ConfigurationDocument, name: string) {
  return {
    ...values,
    agents: {
      ...values.agents,
      entries: { main: { identity: { name } } },
    },
  };
}
