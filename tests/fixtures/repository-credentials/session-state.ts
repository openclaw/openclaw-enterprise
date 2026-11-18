import type {
  AdmittedRepositoryBinding,
  RepositoryCredentialGrantIdentity,
  RepositoryRevisionState,
} from "@openclaw-enterprise/contracts";

export function repositoryGrant(overrides: Partial<RepositoryCredentialGrantIdentity> = {}) {
  return {
    providerInstanceId: "https://git.example.test",
    repositoryId: "repository-42",
    grantId: "read-policy",
    ...overrides,
  };
}

function defaultBinding() {
  return {
    repositoryRef: "source",
    profile: "git-read",
    backendId: "source-provider",
    grant: repositoryGrant(),
  } satisfies AdmittedRepositoryBinding;
}

export function repositoryBinding(overrides?: undefined): ReturnType<typeof defaultBinding>;
export function repositoryBinding(
  overrides?: Partial<AdmittedRepositoryBinding>,
): AdmittedRepositoryBinding;
export function repositoryBinding(overrides: Partial<AdmittedRepositoryBinding> = {}) {
  return { ...defaultBinding(), ...overrides };
}

function defaultCredentials() {
  return {
    driver: { id: "repository-credentials", implementation: "github" },
    deadlineWallMs: 1_900_000_060_000,
    bindings: [repositoryBinding()],
  } satisfies RepositoryRevisionState;
}

export function repositoryCredentials(overrides?: undefined): ReturnType<typeof defaultCredentials>;
export function repositoryCredentials(
  overrides?: Partial<RepositoryRevisionState>,
): RepositoryRevisionState;
export function repositoryCredentials(overrides: Partial<RepositoryRevisionState> = {}) {
  return { ...defaultCredentials(), ...overrides };
}
