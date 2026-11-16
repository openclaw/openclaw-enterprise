import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { wholeNumber } from "./observations.mts";

const directory = "/home/node/.openclaw/agents/main/agent";
const database = new DatabaseSync(directory + "/openclaw-agent.sqlite", { readOnly: true });
try {
  const version = wholeNumber(database.prepare("PRAGMA user_version").get()?.user_version);
  const backups = readdirSync(directory)
    .filter((name) => name.includes(".pre-startup-migration-"))
    .sort();
  process.stdout.write(JSON.stringify({ version, backups }));
} finally {
  database.close();
}
