import { Client, Pool } from "pg";
import type {
  SchemaAuthBindingFactoryV1,
  SchemaAuthBoundaryV1,
} from "./schema-auth-boundary-v1.ts";

/** Bind the caller's pool to the original complete schema without acquiring it. */
export const createPostgresAuthBinding: SchemaAuthBindingFactoryV1 = async (pool) => {
  if (!(pool instanceof Pool)) {
    throw new TypeError("PostgreSQL auth requires a node-postgres Pool instance.");
  }
  return bindDatabase(pool);
};

/** Join the original State transaction without taking ownership of its client. */
export function createPostgresAuthTransactionBinding(
  client: unknown,
  run: <T>(query: () => Promise<T>) => Promise<T>,
): Promise<SchemaAuthBoundaryV1> {
  if (!(client instanceof Client)) {
    throw new TypeError("PostgreSQL auth requires the original node-postgres transaction client.");
  }
  return bindDatabase(
    new Proxy(client, {
      get(target, name, receiver) {
        if (name === "query") {
          // Drizzle issues promise-based node-postgres queries with the full query config.
          return (...args: unknown[]) =>
            run(() => Reflect.apply(target.query, target, args) as Promise<unknown>);
        }
        return Reflect.get(target, name, receiver);
      },
    }),
  );
}

async function bindDatabase(client: Pool | Client): Promise<SchemaAuthBoundaryV1> {
  const [{ drizzle }, schema] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("../state/postgres-schema.ts"),
  ]);

  // An explicit client keeps caller-added fields separate from Drizzle config.
  return { schema, database: drizzle({ client, schema }) };
}
