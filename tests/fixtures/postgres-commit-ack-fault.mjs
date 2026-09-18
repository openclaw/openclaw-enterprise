import pg from "pg";

let installed = false;
let originalQuery;
const armedClients = new WeakSet();

function queryText(query) {
  if (typeof query === "string") {
    return query;
  }
  if (query && typeof query === "object" && typeof query.text === "string") {
    return query.text;
  }
  return undefined;
}

export function installPostgresCommitAcknowledgementFault() {
  if (installed) {
    throw new Error("PostgreSQL COMMIT acknowledgement fault is already installed.");
  }
  installed = true;
  originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = async function faultedQuery(...args) {
    const text = queryText(args[0])?.trim();
    const insertsInstallation = /^INSERT\s+INTO\s+occ\.installation\b/i.test(text ?? "");
    const commitsArmedInstallation = text?.toUpperCase() === "COMMIT" && armedClients.has(this);
    const result = await originalQuery.apply(this, args);
    if (insertsInstallation) {
      armedClients.add(this);
    }
    if (!commitsArmedInstallation) {
      return result;
    }
    armedClients.delete(this);
    const error = new Error("connection lost after PostgreSQL COMMIT completed");
    error.code = "08006";
    throw error;
  };
  return () => {
    pg.Client.prototype.query = originalQuery;
    originalQuery = undefined;
    installed = false;
  };
}

if (process.env.OCC_TEST_POSTGRES_COMMIT_ACK_FAULT === "installation-bootstrap") {
  installPostgresCommitAcknowledgementFault();
}
