---
kind: reference
---

# Installation network policy ceiling

The Installation stores one versioned network policy ceiling in PostgreSQL.
Preview, save, application admission, and deployment admission use its current
rules. Pending worker applications recheck them before provider effects. The
ceiling grants no access by itself; an empty ceiling permits no additions.
Changes do not revoke running access or replace Sandbox Driver defaults.

`GET` and `PUT /installation/sandbox-network-policy-ceiling` require `administer`
on the server-selected Installation. The read returns `installationId`, `version`,
`rules`, `updatedAt`, and `updatedBy` in the standard data envelope. PUT takes
`{ expectedVersion, rules }`. A stale version returns a conflict. Successful
changes and attributable audit evidence commit together.

`POST /installation/sandbox-network-policy-ceiling/validate` takes the same fields
with a draft `rules` value. It requires the same authority and checks the
version and shared rule validation without saving. The data envelope contains
`{ success: true, data: { rules } }` or
`{ success: false, error: { details } }`. Preview success grants no authority to
PUT, which repeats its checks.

Ordinary Agent policy reads expose the rules through their existing Agent and
SandboxPolicy permissions, without update attribution.

Trusted startup configuration seeds version 1 once from
`sandboxNetworkPolicyCeiling`. An omitted seed initializes an empty list.
Subsequent starts preserve saved rules, including an explicitly empty list;
a different seed produces a diagnostic, without replacing them. Missing,
unreadable, or invalid state causes dependent operations to fail explicitly.
Workers refuse startup until the API has initialized the ceiling. They never
initialize it or fall back to their startup configuration.

Saved state is the only runtime authority. Startup never reconciles existing
rules or disables administrator edits. API replicas need no ceiling ownership
lease or coordinated restart to change the saved rules. The retired
`sandboxNetworkPolicyCeilingOverwriteOnStartup` setting is rejected.

Each rule has `id`, an exact absolute `binary` path, a DNS `host`, and `ports`
containing inclusive `{from,to}` ranges. For example, this startup seed permits
future requests for one service:

```yaml
sandboxNetworkPolicyCeiling:
  - id: approved-service
    binary: /usr/bin/python3.11
    host: service.example.com
    ports:
      - from: 443
        to: 443
```

The complete requested scope must fit the ceiling. Executable paths must match
exactly; a symlink or alternate interpreter path is a different executable.
`*.example.com` covers one DNS label, not the apex or deeper subdomains. A
wildcard addition requires that exact wildcard in the ceiling. Port coverage may
combine adjacent ceiling ranges; gaps remain unauthorized. Drivers reject
unsupported constraints. Policy documents allow at most 32 grants and 16 ranges
per grant. OpenShell additionally limits each grant to 1024 distinct ports.

Default rules, generated workspace access, model credential delivery, and Compute
isolation remain controlled by their existing owners. Users cannot submit
arbitrary provider policy YAML, alter defaults, share policies, or change their
Agent/Namespace association. Policy identities use `sbp_` and the owner's UUID.
Policies are created and removed with the Agent; there is no standalone
create/delete or policy-reference API. Exact policy AccessBindings and
Restrictions are removed with their policy.
