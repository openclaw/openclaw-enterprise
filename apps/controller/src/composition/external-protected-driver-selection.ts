/** Identity of one registration shared by the external protected capability views. */
export function externalProtectedDriverSelection(
  selection: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: unknown;
  },
  repositoryAuthorityIdentity?: string,
) {
  return repositoryAuthorityIdentity === undefined
    ? selection
    : {
        ...selection,
        configuration: { sandbox: selection.configuration, repositoryAuthorityIdentity },
      };
}
