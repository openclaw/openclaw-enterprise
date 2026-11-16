# Remote prepared Git issuer

Deploy a separate issuer for the fixed online `github-repository` profile. This
profile uses GitHub ref protection and registry permissions.

## Package and configure the Worker

Use bundled Kubernetes Compute and an external package that registers both
Sandbox and Credential Proxy. The controller image includes the issuer CLI.
Include the same package at its exact installed version as a direct controller
production dependency in both runtime dependency graphs. The Worker loads the
package. The issuer uses its installed metadata to resolve the registration.

In `repository.preparedGitHub`, set `issuerEndpoint` to a canonical HTTPS origin.
Mount the issuer CA, Worker client certificate and Worker client key at
`issuerCaPath`, `workerCertificatePath` and `workerPrivateKeyPath`. Remove the
native sender and co-located key options. Omit bundled OpenShell repository
delivery, Credential Gateway and Credential Refresh.

Set `repository.preparedGitHub.enrollment` with `namespaceId`, `agentId` and
`servicePrincipalId`. Deployment admission checks that repository
delivery matches the enrolled Namespace, Agent and ServicePrincipal.

Create or select a dedicated Agent in the Installation before you configure
its enrollment. Use the Agent's current ServicePrincipal ID. Start the
issuer and Worker with the matching enrollment before deploying the Agent
with repository bindings. Issuer startup requires the Agent record. You can
start it before any revision, recipient witness, or token exists.

To deploy with repository selections, save them on the enrolled Agent and
deploy it. Ordinary deploy and first deploy return `409 RESOURCE_CONFLICT` for an
Agent with repository selections outside the enrollment, before preparing its
Configuration or checking Channel credentials. Deploy the enrolled Agent with
your repository selections, or remove the selections and try again. You can
still recover a saved first-deployment receipt with current access to the Agent
and Configuration.

A fresh guided provisioning request with repository selections returns the same
conflict before Configuration or Channel preparation because it creates a new
Agent and ServicePrincipal. Guided provisioning accepts requests without
repository selections.

## Configure and start the issuer

From the controller image working directory, run
`node apps/controller/src/prepared-git-issuer.ts /absolute/issuer.json` with
`NODE_ENV=production`, `OCC_DATABASE_URL` for the application role and
`OCC_CONFIG_PATH` for the same Installation and registry.

The issuer JSON requires `listenHost` (specific IP), `listenPort`,
`serverCertificatePath`, `serverPrivateKeyPath`, `workerCaPath`,
`workerFingerprintSha256` (64 lowercase hex digits), `workerInstanceId` (v4 UUID),
`installationId`, `namespaceId`, `agentId`, `servicePrincipalId`,
`privateKeyPath` and `custodyKeyPath`. Use the same Namespace, Agent and ServicePrincipal IDs in both
configurations. The issuer compares the private Installation ID with the
singleton in PostgreSQL. Optional `apiOrigin` and `issuerCaPath` select the upstream
GitHub API and its CA. Use canonical absolute paths.

Set `workerInstanceId` once for the enrollment. Keep it when the Worker or issuer
restarts and when you rotate the Worker certificate. Update the issuer's
fingerprint for the replacement certificate. For an intentional UUID change,
stop the enrolled Agent and retire the old revision's repository delivery before
changing the issuer configuration. Then redeploy the Agent to create a fresh
revision and witness. The issuer preserves the earlier witness's owner.

Mount the GitHub App private key and custody key only on the issuer. Mount its
server TLS key and certificate and the CA for Worker client certificates there.

Stage the issuer JSON and both TLS private keys as regular files readable by
their process, with no group or other permissions. Use mode `0600` and assign
ownership to the process user. Use parent directories owned by that user or root
with no group or other write permissions. The private-file loader rejects
symlinks in these paths, including ordinary projected Secret paths.

## Allow network access and check startup

Allow Worker egress to the issuer HTTPS host and port, and allow issuer ingress
from the Worker. Allow issuer egress to the Installation database and the
configured GitHub API (`https://api.github.com` by default). Helm's
`preparedGitHub.issuerCidrs` and `preparedGitHub.issuerPort` configure GitHub API
egress for the co-located Worker. Supply the remote issuer runtime, mounts and
network rules in your deployment.

The issuer checks that its enrollment matches the Installation configuration
and verifies the database Installation, custody schema, and application role
grants for claim, issuance, retirement, and recipient custody before accepting
probes. The Worker requires the issuer’s versioned response over mutual TLS
before binding its sender. See the [production startup flow](../../flows/production-startup.md).

## Recover a lost reservation reply

The Worker requests a reservation before installing material. If its first reply
is lost, the same Worker call can collect the committed fence once. The issuer
holds up to 64 reservation records, including used records, for 30 seconds each
and checks the current session, enrolled Worker, recipient and material before
returning a fence. It declines new reservations while the table is full. The
Worker and issuer must support the same protocol version.

If the collection reply is lost or either process restarts mid-reservation, the
pending delivery can still represent an unconfirmed installation. The issuer
refuses to issue another fence for that delivery. To resume Git access, stop the
Agent, allow the old revision and repository delivery to retire, then deploy a
fresh revision. The enrolled UUID can stay the same.
