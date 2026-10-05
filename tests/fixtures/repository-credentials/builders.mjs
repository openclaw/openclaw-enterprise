export function serviceConfigurationData({ gateway = {}, sessionPolicy = {}, limits = {} } = {}) {
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

export function githubConfigurationData(overrides = {}) {
  return {
    kind: "github-app",
    providerInstanceId: "github-test",
    configVersion: "1",
    appId: "12345",
    installationId: "41",
    repositoryId: "73",
    repository: "fixture/repository",
    privateKeyFile: "/protected/app.pem",
    ...overrides,
  };
}

export function githubTokenConfigurationData(overrides = {}) {
  return {
    kind: "github-token",
    providerInstanceId: "github-test",
    configVersion: "1",
    repositoryId: "73",
    repository: "fixture/repository",
    tokenFile: "/protected/token",
    developmentOnly: true,
    pushRefAllowlist: ["refs/heads/agent/*"],
    ...overrides,
  };
}

// Keep raw targets byte-for-byte, including deliberately invalid protocol inputs.
export function requestHead(
  method,
  rawTarget,
  headers = {},
  {
    receivedMonoMs = 0,
    contentEncoding = "identity",
    framing = { kind: "none", bytes: undefined },
  } = {},
) {
  return {
    method,
    rawTarget,
    headers: {
      ...(["POST", "PATCH"].includes(method) ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    receivedMonoMs,
    contentEncoding,
    framing,
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

export function issueResponse(overrides = {}) {
  return {
    ...repositoryItem(),
    url: `${api}/issues/1`,
    pull_request: {
      url: `${api}/pulls/1`,
      html_url: "https://github.com/fixture/repository/pull/1",
      diff_url: "https://github.com/fixture/repository/pull/1.diff",
    },
    ...overrides,
  };
}

export function pullResponse(overrides = {}) {
  return {
    ...repositoryItem(),
    url: `${api}/pulls/1`,
    issue_url: `${api}/issues/1`,
    // PR review comments, commits and head repository metadata are informational here.
    review_comments_url: `${api}/pulls/1/comments`,
    commits_url: `${api}/pulls/1/commits`,
    head: { repo: { url: api, labels_url: `${api}/labels{/name}` } },
    ...overrides,
  };
}
