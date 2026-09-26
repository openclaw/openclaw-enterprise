export function repositoryGrant(overrides = {}) {
  return {
    providerInstanceId: "https://git.example.test",
    repositoryId: "repository-42",
    grantId: "read-policy",
    ...overrides,
  };
}

export function repositoryBinding(overrides = {}) {
  return {
    repositoryRef: "source",
    profile: "git-read",
    backendId: "source-provider",
    grant: repositoryGrant(),
    ...overrides,
  };
}

export function repositoryCredentials(overrides = {}) {
  return {
    driver: { id: "repository-credentials", implementation: "github" },
    deadlineWallMs: 1_900_000_060_000,
    bindings: [repositoryBinding()],
    ...overrides,
  };
}
