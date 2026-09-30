export function createAgentCreation({ namespaceId, request, isCurrent }) {
  // TODO: Persist recovery identity when recovery across closed forms is supported.
  let state;

  return {
    get uncertain() {
      return state !== undefined && !state.rejected;
    },
    async create(configuration, agent, onConfiguration) {
      function checkCurrent() {
        if (!isCurrent()) {
          throw new DOMException("The creation view was closed.", "AbortError");
        }
      }
      checkCurrent();
      let recovering = state !== undefined && !state.rejected;
      if (!recovering) {
        state = {
          configuration: state?.configuration ?? {
            ...configuration,
            idempotencyKey: crypto.randomUUID(),
          },
          agent: { ...agent, idempotencyKey: crypto.randomUUID() },
          savedConfiguration: state?.savedConfiguration,
        };
      }
      try {
        if (!state.savedConfiguration) {
          const created = await request(
            `/namespaces/${encodeURIComponent(namespaceId)}/configurations`,
            { method: "POST", body: state.configuration },
          );
          checkCurrent();
          state.savedConfiguration = created;
          recovering = false;
        }
        onConfiguration(state.savedConfiguration);
        checkCurrent();
        const created = await request(`/namespaces/${encodeURIComponent(namespaceId)}/agents`, {
          method: "POST",
          body: { ...state.agent, configurationId: state.savedConfiguration.id },
        });
        checkCurrent();
        state = undefined;
        return created;
      } catch (error) {
        // A later rejection cannot settle an earlier request whose reply was lost.
        if (!recovering && isCurrent() && [400, 401, 403, 404, 409, 429].includes(error.status)) {
          state = state.savedConfiguration ? { ...state, rejected: true } : undefined;
        }
        throw error;
      }
    },
  };
}
