# Scenario 3 — real-IdP client-credentials proof

**Result: passed.** The tokens the real gateway validated were minted by a
real Keycloak 26.7.5 (the repository-pinned digest), not the in-process wire
fixtures, and the failure modes behave as specified.

## Setup

- Keycloak realm `oc4024` with a confidential client for OCC
  (`serviceAccountsEnabled`, client-credentials only), an audience mapper
  adding `openshell-cli` to the access token, and realm roles
  `openshell-user`/`openshell-admin` mapped through `realm_access.roles`.
- The gateway validates bearer tokens with
  `issuer = https://<issuer>:8443/realms/oc4024`, `audience = openshell-cli`,
  `roles_claim = realm_access.roles`, trusting the issuer's TLS through the
  same proof CA.

## Evidence

1. **The grant works end to end.** The worker's token exchange (observed as
   Keycloak traffic) and the gateway's `Health` and `CreateWorkspace` RPCs
   with HTTP 200 (Scenario 1's gateway log) prove the minted tokens validate.
   A decoded token (value never printed) carries
   `aud: [openshell-cli, account]` and
   `realm_access.roles: [openshell-user, openshell-admin, ...]`.
2. **A wrong client secret is rejected by the issuer.** A token request with
   an incorrect secret answers HTTP 401
   `{"error":"unauthorized_client","error_description":"Invalid client or
   Invalid client credentials"}` — this is the permanent, clear-message path
   the token source maps to
   `OpenShell OIDC token endpoint rejected the client credentials (HTTP 401)`.
3. **A valid token without the required role is refused by the gateway.**
   Before the realm roles were assigned, the worker's namespace
   reconciliation failed with
   `OpenShell refused the controller gateway identity with gRPC PERMISSION_DENIED`
   — the gateway authenticated the token and denied it on RBAC. This is live
   proof the gateway enforces the OIDC identity, not just presence of a
   token.
4. **Private-CA trust flows through the PR's inputs.** The worker verified
   the issuer's TLS with the `/etc/openclaw/openshell/ca.crt` bundle mounted
   from `OCC_DEVELOPMENT_OPENSHELL_CA_FILE` (the probe in Scenario 2), and
   the gateway verified the same issuer through its own CA input. This
   exercised the `rootCertificatePath` token-request trust added in this PR:
   with the chart's `NODE_EXTRA_CA_CERTS` serving the private routing CA, the
   token request only verified once the Backend's root bundle was used.
