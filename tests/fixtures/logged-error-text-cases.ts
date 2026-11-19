// Texts for the log lines that keep a Compute Driver's or a dependency's message
// (`worker.compute-prepare-failed`, `compute.preflight-warning`, `http.dependency_unavailable`).

// A fake credential value, assembled so no complete credential shape appears in the source.
const FAKE_CREDENTIAL = ["Fixture", "fake", "0123456789"].join("");
const UPPER = FAKE_CREDENTIAL.toUpperCase().slice(0, 16);

/** Whether output carries the fake value, in any case. */
export function carriesFakeCredential(output: string): boolean {
  return output.toLowerCase().includes(FAKE_CREDENTIAL.toLowerCase().slice(0, 11));
}
const quoted = (text: string) => JSON.stringify(text);

/** Credential shapes the shared check withholds, each carrying the fake value. */
export const CREDENTIAL_SHAPE_TEXTS: readonly { readonly shape: string; readonly text: string }[] =
  [
    {
      shape: "JSON password",
      text: `Login refused: {${quoted("password")}:${quoted(FAKE_CREDENTIAL)}}`,
    },
    {
      shape: "JSON access token",
      text: `Upstream answered {${quoted("access_token")}: ${quoted(FAKE_CREDENTIAL)}}, retry.`,
    },
    // A Kubernetes client error carries its body as escaped JSON.
    {
      shape: "escaped JSON API key",
      text: `HTTP-Code: 401 Body: ${JSON.stringify(JSON.stringify({ apiKey: FAKE_CREDENTIAL }))}`,
    },
    {
      shape: "dictionary Authorization",
      text: `Request failed: {'Authorization': 'Token ${FAKE_CREDENTIAL}'}`,
    },
    { shape: "bare token pair", text: `Retry with token=${FAKE_CREDENTIAL}, then redeploy.` },
    // A newline or format character after `=` collapses to one space before the check.
    {
      shape: "value after a collapsed format character",
      text: `Fetch https://service.invalid/v1?token=\u200B${FAKE_CREDENTIAL} failed.`,
    },
    { shape: "bare secret pair", text: `Connect secret=${FAKE_CREDENTIAL} refused.` },
    { shape: "bare API key pair", text: `Call api_key=${FAKE_CREDENTIAL} refused.` },
    {
      shape: "hyphenated API key query",
      text: `Fetch https://service.invalid/v1?api-key=${FAKE_CREDENTIAL} failed.`,
    },
    {
      shape: "X-Amz-Signature outside a query",
      text: `Presign failed; X-Amz-Signature=${FAKE_CREDENTIAL}, retry.`,
    },
    { shape: "sig outside a query", text: `SAS sr=b sig=${FAKE_CREDENTIAL} rejected.` },
    {
      shape: "storage account key",
      text: `Connect AccountName=fixture;AccountKey=${FAKE_CREDENTIAL}+/a==; failed.`,
    },
    {
      shape: "shared access key",
      text: `Connect Endpoint=sb://bus.invalid/;SharedAccessKey=${FAKE_CREDENTIAL}= failed.`,
    },
    { shape: "Cookie header", text: `Request Cookie: sid=${FAKE_CREDENTIAL}; Path=/ refused.` },
    { shape: "Set-Cookie header", text: `Answer Set-Cookie: session=${FAKE_CREDENTIAL}; HttpOnly` },
    {
      shape: "Authorization Token scheme",
      text: `Header Authorization: Token ${FAKE_CREDENTIAL}, refused.`,
    },
    {
      shape: "Authorization Digest scheme",
      text: `Header Authorization: Digest username=${quoted("fixture")}, response=${quoted(FAKE_CREDENTIAL)}`,
    },
    {
      shape: "Authorization AWS signature",
      text: `Header Authorization: AWS4-HMAC-SHA256 Credential=fixture/x, Signature=${FAKE_CREDENTIAL}`,
    },
    { shape: "API key header", text: `Header x-api-key: ${FAKE_CREDENTIAL} refused.` },
    {
      shape: "session token header",
      text: `Header X-Amz-Security-Token: ${FAKE_CREDENTIAL} expired.`,
    },
    {
      shape: "temporary AWS access key ID",
      text: `STS key ${["AS", "IA"].join("")}${UPPER} expired.`,
    },
    {
      shape: "Google OAuth access token",
      text: `Google token ${["ya29", FAKE_CREDENTIAL].join(".")}; refresh.`,
    },
    {
      shape: "Google API key",
      text: `Key ${["AI", "za"].join("")}${FAKE_CREDENTIAL}${FAKE_CREDENTIAL.slice(0, 14)} refused.`,
    },
    { shape: "GitLab token", text: `Clone with ${["glpat", FAKE_CREDENTIAL].join("-")} failed.` },
  ];

const statusProxyWarning = (cidr: string) =>
  `Plugin status proxy CIDR ${cidr} covers more than one address: every Pod in it ` +
  "can reach the Agent status port. Use the API server /32 or /128 source addresses.";
const modelEgressWarning = (blocked: string) =>
  `Model provider endpoint ${blocked}: the generated policy will not admit it unless another NetworkPolicy does.`;

/**
 * Text OCC's own code sends to these lines, which must be kept verbatim: the bundled Kubernetes
 * Compute Driver's preflight warnings and preparation failures, and renderings of the
 * interpolating DependencyUnavailableError construction sites, plus prose that names
 * credentials.
 */
export const LEGITIMATE_DIAGNOSTIC_TEXTS: readonly string[] = [
  ...["100.64.0.0/10", "0.0.0.0/0", "fd00::/8"].map(statusProxyWarning),
  modelEgressWarning("uses port 8443 but Harness model egress allows only TCP/443"),
  modelEgressWarning(
    "uses port 8443 but Harness model egress allows only TCP/443 and is an IPv6 address but Harness model egress allows only IPv4",
  ),
  modelEgressWarning("has an IPv4 host in 169.254.0.0/16 which Harness model egress excludes"),
  "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
  "The Kubernetes API rejected revision preparation.",
  "Node credential unconfirmed. Stop Agent; wait for shutdown. Delete only node Secret " +
    "ns-a/node-a, then redeploy. Preserve node identity and workspace storage.",
  "Harness environment variable GITHUB_TOKEN must be a literal or SecretKeyRef.",
  "Configuration setting models.providers.openai.apiKey must be a string: a dedicated Codex Gateway cannot apply it otherwise.",
  "Gateway routing native configuration contains unsupported auth field password.",
  "An explicit modelProvider override requires source-backed OpenAI API-key authentication.",
  "Provider-owned Harness must mount its ServicePrincipal token read-only at the approved path.",
  "Runtime credential delivery is unavailable.",
  "ChatGPT Admin API POST request was unavailable.",
  "ChatGPT Admin API DELETE request failed with HTTP 503.",
  "The Kubernetes Secret create failed.",
  "The Kubernetes Secret replace outcome is unknown after timeout.",
  "The Kubernetes Secret delete was cancelled.",
  "The Kubernetes ConfigMap create outcome is unknown after timeout.",
  "The exact AgentRevision gateway could not apply its workspace node (WORKSPACE_NODE_FAILED).",
  "The Credential Refresh Driver did not mint a token (CREDENTIAL_REFRESH_ROTATION_FAILED).",
  "OpenShell accepted deletion of Sandbox sbx-0123abcd but did not finish it within 30 s.",
  "OpenShell CreateSandbox failed with gRPC status 14: connection refused",
  "OpenShell UpdateConfig failed with gRPC status 10 (reason RESOURCE_VERSION_CONFLICT).",
  "OpenShell GetSandbox failed: TypeError",
  "The selected secret Driver is unavailable.",
  "Persisted saved configuration is invalid.",
  "Persisted AgentRevision plugin state is invalid.",
  "The Agent runtime credential Kubernetes namespace is unavailable.",
  "Basic authentication with the registry failed.",
  "Uses basic OpenShell sandboxing.",
  "Basic ServiceAccount token projection failed.",
  "The ServiceAccount credential Secret create outcome is unknown, and its cleanup could not finish.",
  "Fetch https://registry.example.test/v2/token?scope=pull failed.",
  "Cluster https://kubernetes.default.svc:443/api answered 503.",
  "Authorization: denied for this caller; the token expired.",
  "Set-Cookie: rejected by the browser policy.",
];
