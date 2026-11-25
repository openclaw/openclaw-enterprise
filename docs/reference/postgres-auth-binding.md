# PostgreSQL authentication binding

The controller connects Better Auth to OCC's canonical PostgreSQL schema through
`createPostgresAuthBinding` from `@openclaw-enterprise/occ`. This public API replaces
controller lookups into OCC's source tree and private dependency installation.

## Composition

Supply the application's node-postgres `Pool`. OCC returns a Drizzle database
bound to that pool and the complete canonical schema. The controller passes both
to its Better Auth adapter:

```ts
import { createPostgresAuthBinding } from "@openclaw-enterprise/occ";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

const binding = await createPostgresAuthBinding(pool);
const database = drizzleAdapter(binding.database, {
  provider: "pg",
  schema: binding.schema,
  camelCase: true,
  transaction: true,
});
```

```mermaid
flowchart LR
  Application[Application-owned pool] --> Binding[OCC auth binding]
  Schema[Canonical OCC schema] --> Binding
  Binding --> Adapter[Controller-owned Better Auth adapter]
  Adapter --> Authentication[Accounts, sessions, service keys]
```

Structural pool wrappers and checked-out clients are rejected: Drizzle must
recognize the pool to use one dedicated connection per transaction. Construction
performs no database I/O and creates no pool. The application owns migrations
and pool shutdown. Construction failures reject without a memory fallback.

Sharing a pool does not join Better Auth transactions to OCC transactions.
See [authentication](authentication.md) for account, session, API key, and
authorization behavior.

## Type contracts

`@openclaw-enterprise/occ` exports the binding, factory, adapter-option, and
complete-schema types. The schema type retains each canonical table's inferred
columns and query results. `CoreSchemaRootV1`, `CoreResourceSchemaV1`, and
`AuthTableSchemaV1` expose the original root and narrow readonly type views. The
core view includes Installation, Namespace, Configuration, Secret, and
ServiceAccount tables; the auth view includes user, session, account,
verification, and API-key tables. These views preserve original column types
and do not replace the complete runtime schema passed to the adapter.

Consumers import these types from the package root. Earlier proposed subpath
imports are not part of the current package export map.

The PostgreSQL Controller options now require a real node-postgres `Pool`, rather
than the broader structural pool interface used by State. Existing production and
development composition use `createPostgresPool`, which returns that real pool.
Callers supplying structural wrappers or checked-out clients must supply the
owning pool instead; their objects cannot preserve the adapter's transaction
connection selection.

For test setup, focused checks, and database failure diagnosis, see
[PostgreSQL tests](../testing/postgresql.md#authentication-binding).
