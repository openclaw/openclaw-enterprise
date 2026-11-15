import { isPromise } from "node:util/types";
import pg, { type Client } from "pg";

let restoreInstalledFault: (() => void) | undefined;

function queryText(query: unknown): string | undefined {
  if (typeof query === "string") {
    return query;
  }
  if (query && typeof query === "object" && "text" in query && typeof query.text === "string") {
    return query.text;
  }
  return undefined;
}

export function installPostgresCommitAcknowledgementFault(): () => void {
  if (restoreInstalledFault) {
    throw new Error("PostgreSQL COMMIT acknowledgement fault is already installed.");
  }

  const originalQuery = pg.Client.prototype.query;
  const armedClients = new WeakSet<Client>();
  // Keep pg's overloads and call the real method with its receiver and arguments.
  pg.Client.prototype.query = new Proxy(originalQuery, {
    apply(target, client: Client, args: readonly unknown[]): unknown {
      const result: unknown = Reflect.apply(target, client, args);
      // pg returns void for callbacks and returns the submittable itself for streams.
      if (result === args[0] || !isPromise(result)) {
        return result;
      }

      const text = queryText(args[0])?.trim();
      if (/^INSERT\s+INTO\s+occ\.installation\b/i.test(text ?? "")) {
        return result.then((value) => {
          armedClients.add(client);
          return value;
        });
      }
      if (text?.toUpperCase() === "COMMIT" && armedClients.has(client)) {
        return result.then((value) => {
          // Consume the fault only after the server succeeds, even with queued COMMITs.
          if (armedClients.delete(client)) {
            throw Object.assign(new Error("connection lost after PostgreSQL COMMIT completed"), {
              code: "08006",
            });
          }
          return value;
        });
      }
      return result;
    },
  });

  function restore() {
    if (restoreInstalledFault === restore) {
      pg.Client.prototype.query = originalQuery;
      restoreInstalledFault = undefined;
    }
  }
  restoreInstalledFault = restore;
  return restore;
}

if (process.env.OCC_TEST_POSTGRES_COMMIT_ACK_FAULT === "installation-bootstrap") {
  installPostgresCommitAcknowledgementFault();
}
