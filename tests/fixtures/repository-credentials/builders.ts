import type { RepositoryCredentialClientConfiguration } from "../../../apps/controller/src/drivers/repo/access/client-contracts.ts";

// These are validator inputs. Tests can override individual fields with malformed values.
type ConfigurationLayer = Readonly<Record<string, unknown>>;

// A supplied field replaces its default. An optional field can leave the default in place.
type WithOverrides<Defaults, Overrides> = Overrides extends ConfigurationLayer
  ? string extends keyof Overrides
    ? ConfigurationLayer
    : Omit<Defaults, keyof Overrides> &
        Omit<Overrides, keyof Defaults> & {
          [K in keyof Defaults & keyof Overrides]: Overrides extends Record<K, unknown>
            ? Overrides[K]
            : Defaults[K] | Overrides[K];
        }
  : Defaults;

function fixtureBuilder<Defaults extends ConfigurationLayer>(defaults: () => Defaults) {
  function build(): Defaults;
  function build<Overrides extends ConfigurationLayer | undefined>(
    overrides: Overrides,
  ): WithOverrides<Defaults, Overrides>;
  function build(overrides?: ConfigurationLayer) {
    return { ...defaults(), ...overrides };
  }
  return build;
}

export function serviceConfigurationData({
  gateway = {},
  sessionPolicy = {},
  limits = {},
}: {
  gateway?: ConfigurationLayer;
  sessionPolicy?: ConfigurationLayer;
  limits?: ConfigurationLayer;
} = {}): {
  gateway: ConfigurationLayer;
  sessionPolicy: ConfigurationLayer;
  limits: ConfigurationLayer;
} {
  return {
    gateway: {
      publicOrigin: "https://credentials.example",
      listen: "127.0.0.1:443",
      controlSocket: "/run/credentials/control.sock",
      ...gateway,
    },
    sessionPolicy: {
      maximumDurationSeconds: 86400,
      defaultProfile: "git-write",
      allowedProfiles: ["git-read", "git-write", "git-full"],
      ...sessionPolicy,
    },
    limits: { ...limits },
  };
}

export const githubConfigurationData = fixtureBuilder(() => ({
  kind: "github-app",
  providerInstanceId: "github-test",
  configVersion: "1",
  appId: "12345",
  installationId: "41",
  repositoryId: "73",
  repository: "fixture/repository",
  privateKeyFile: "/protected/app.pem",
}));

export const githubTokenConfigurationData = fixtureBuilder(() => ({
  kind: "github-token",
  providerInstanceId: "github-test",
  configVersion: "1",
  repositoryId: "73",
  repository: "fixture/repository",
  tokenFile: "/protected/token",
  developmentOnly: true,
  pushRefAllowlist: ["refs/heads/agent/*"],
}));

// A session's client settings (client.json) for `repository` behind the fixture gateway
// origin. `overrides` adds or replaces settings, such as pushRefAllowlist.
export function repositoryClientData({
  repository = "example/project",
  ...overrides
}: Partial<RepositoryCredentialClientConfiguration> = {}): RepositoryCredentialClientConfiguration {
  return {
    gatewayOrigin: "https://credentials.example.test",
    gitRemote: `https://credentials.example.test/${repository}.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository,
    ...overrides,
  };
}

const api = "https://api.github.com/repos/fixture/repository";
function repositoryItem() {
  return {
    comments_url: `${api}/issues/1/comments`,
    title: `${api}/labels/bug`,
    body: `${api}/milestones/1`,
    html_url: "https://github.com/fixture/repository/pull/1",
    labels: [{ id: 1, name: "bug", url: `${api}/labels/bug` }],
    milestone: { url: `${api}/milestones/1`, title: "Release", description: `${api}/issues/1` },
    user: { url: "https://api.github.com/users/person" },
  };
}

export const issueResponse = fixtureBuilder(() => ({
  ...repositoryItem(),
  url: `${api}/issues/1`,
  pull_request: {
    url: `${api}/pulls/1`,
    html_url: "https://github.com/fixture/repository/pull/1",
    diff_url: "https://github.com/fixture/repository/pull/1.diff",
  },
}));

export const pullResponse = fixtureBuilder(() => ({
  ...repositoryItem(),
  url: `${api}/pulls/1`,
  issue_url: `${api}/issues/1`,
  // PR review comments, commits and head repository metadata are informational here.
  review_comments_url: `${api}/pulls/1/comments`,
  commits_url: `${api}/pulls/1/commits`,
  head: { repo: { url: api, labels_url: `${api}/labels{/name}` } },
}));

/** Custody limits for driver tests: two slots and callbacks, 16 KiB access and renewal bodies. */
export const custodyLimits = Object.freeze({
  maximumSlots: 2,
  maximumAccessBytes: 16384,
  maximumRenewalBytes: 16384,
  maximumCallbacks: 2,
});
