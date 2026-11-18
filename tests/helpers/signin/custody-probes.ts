import { request } from "node:https";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { protectedJSON, type RehearsalCustody } from "../production-rehearsal-custody.ts";
import type { TransitionFixture } from "./transition.ts";

type Fixture = TransitionFixture<never, never>;
type FetchOptions = Omit<Parameters<Fixture["consoleFetch"]>[1], "redirect"> & {
  // Materialization uses the same transport for a discovery request without this option.
  redirect?: "manual";
};

const manifestEntry = Type.Object({
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  when: Type.Integer(),
});
const manifestEntries = Type.Array(manifestEntry, { minItems: 1 });
const migrationManifest = Type.Object({
  version: Type.Literal(1),
  entries: manifestEntries,
  compatibleLineages: Type.Optional(
    Type.Object({
      providerCompleted: Type.Optional(Type.Object({ entries: manifestEntries })),
    }),
  ),
});
const migrationReceipts = Type.Array(Type.Tuple([Type.Integer(), Type.String(), Type.Integer()]));
const sessionRow = Type.Object({ id: Type.String() });

function strictlyIncreasing<T>(entries: readonly T[], counter: (entry: T) => number) {
  let previous = 0;
  return entries.every((entry) => {
    const current = counter(entry);
    const valid = Number.isSafeInteger(current) && current > previous;
    previous = current;
    return valid;
  });
}

// Address and port come from the fixture-owned forward. Preserve HTTP Host, TLS SNI and verification.
export function fixtureFetch(origin: string, address: string, port: number, ca: string | Buffer) {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== "https:" || !isIP(address) || !ca?.length) {
    throw new Error("invalid TLS fixture");
  }
  return (url: URL, options: FetchOptions) =>
    new Promise<Response>((resolve, reject) => {
      if (url.origin !== origin || url.username || url.password) {
        throw new Error("unexpected TLS origin");
      }
      const req = request(
        {
          hostname: address,
          port,
          servername: endpoint.hostname,
          ca,
          rejectUnauthorized: true,
          path: url.pathname + url.search,
          headers: { ...options.headers, host: endpoint.host },
          method: options.method || "GET",
          signal: options.signal,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: unknown) => {
            if (!Buffer.isBuffer(chunk)) {
              res.destroy();
              reject(new Error("invalid fixture response"));
              return;
            }
            size += chunk.length;
            if (size > 262144) {
              res.destroy();
              reject(new Error("fixture response too large"));
            } else {
              chunks.push(chunk);
            }
          });
          res.on("error", () => reject(new Error("fixture response failed")));
          res.on("end", () => {
            try {
              const headers = new Headers();
              for (let i = 0; i < res.rawHeaders.length; i += 2) {
                const name = res.rawHeaders[i];
                const value = res.rawHeaders[i + 1];
                if (name === undefined || value === undefined) {
                  throw new Error("invalid fixture response");
                }
                headers.append(name, value);
              }
              resolve(
                new Response(Buffer.concat(chunks), {
                  ...(res.statusCode === undefined ? {} : { status: res.statusCode }),
                  headers,
                }),
              );
            } catch {
              reject(new Error("invalid fixture response"));
            }
          });
        },
      );
      req.on("error", () => reject(new Error("fixture TLS request failed")));
      req.end(options.body);
    });
}

// Same private psql transport as rehearsePopulatedReturn. No bearer tokens or credential columns selected.
export function retainedCatalog(
  custody: Pick<RehearsalCustody, "postgres">,
  userId: string,
  installationId: string,
  completedHistory: () => Promise<void>,
  expectedManifest: unknown,
) {
  const literal = (v: string) => {
    if (typeof v !== "string" || !/^[A-Za-z0-9:._|-]{1,255}$/.test(v)) {
      throw new Error("invalid fixture identifier");
    }
    return "'" + v + "'";
  };
  const uid = literal(userId);
  const iid = literal(installationId);
  async function sql(query: string) {
    return (
      await custody.postgres(
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "--dbname=openclaw_enterprise",
        "-c",
        query,
      )
    ).trim();
  }
  const equal = (a: unknown, b: unknown) => {
    if (!isDeepStrictEqual(a, b)) {
      throw new Error("retained state mismatch");
    }
  };
  let ledger: string | undefined;
  let account: string | undefined;
  const sessionFacts = new Map<string, string>();
  const readSessions = (ids: readonly string[]) =>
    sql(`SELECT row_to_json(t) FROM (
    SELECT s.id, s.user_id, s.created_at, s.expires_at, h.method_id, h.version, h.method_version
    FROM occ.session s JOIN occ.human_authentication_sessions h ON h.session_id=s.id
    WHERE s.id IN (${ids.map(literal).join(",")}) AND s.user_id=${uid}) t ORDER BY t.id`);
  const readAccount = () =>
    sql(`SELECT row_to_json(t) FROM (
    SELECT a.*, u.email, i.issuer, i.subject, i.kind,
      (SELECT json_agg(json_build_array(m.id,m.provider_id,m.account_id,m.authentication_version)
      ORDER BY m.id) FROM occ.account m WHERE m.user_id=a.user_id) methods
    FROM occ.human_authentication_accounts a JOIN occ."user" u ON u.id=a.user_id
    JOIN occ.iam_identities i ON i.id=a.principal_id WHERE a.user_id=${uid} AND a.installation_id=${iid}) t`);
  return {
    async assertCatalog() {
      await completedHistory();
      const current = await sql(
        "SELECT COALESCE(json_agg(json_build_array(id, hash, created_at) ORDER BY id), '[]'::json) FROM drizzle.__drizzle_migrations",
      );
      if (!current.length) {
        throw new Error("empty migration ledger");
      }
      if (ledger === undefined) {
        if (
          !Check(migrationManifest, expectedManifest) ||
          !strictlyIncreasing(expectedManifest.entries, (entry) => entry.when)
        ) {
          throw new Error("invalid expected migration manifest");
        }
        const histories = [expectedManifest.entries];
        const provider = expectedManifest.compatibleLineages?.providerCompleted;
        if (provider !== undefined) {
          if (
            !strictlyIncreasing(provider.entries, (entry) => entry.when) ||
            provider.entries.length > expectedManifest.entries.length
          ) {
            throw new Error("invalid expected migration manifest");
          }
          histories.push([
            ...provider.entries,
            ...expectedManifest.entries.slice(provider.entries.length),
          ]);
        }
        const receipts = protectedJSON<unknown>(current);
        const matches =
          Check(migrationReceipts, receipts) &&
          strictlyIncreasing(receipts, ([id]) => id) &&
          histories.some(
            (entries) =>
              receipts.length === entries.length &&
              receipts.every(
                ([, hash, when], index) =>
                  hash === entries[index]?.sha256 && when === entries[index]?.when,
              ),
          );
        if (!matches) {
          throw new Error("migration ledger differs from expected manifest");
        }
        ledger = current;
      }
      equal(ledger, current);
      equal(
        await sql(`SELECT pg_get_userbyid(c.relowner)='occ_migrator'
        AND ARRAY(SELECT privilege_type FROM aclexplode(c.relacl)
          WHERE grantee='occ_app'::regrole ORDER BY 1)=ARRAY['DELETE','INSERT','SELECT']
        AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) WHERE grantee=0)
        AND has_table_privilege('occ_app',c.oid,'SELECT')
        AND has_table_privilege('occ_app',c.oid,'INSERT')
        AND has_table_privilege('occ_app',c.oid,'DELETE')
        AND NOT has_table_privilege('occ_app',c.oid,'UPDATE')
        FROM pg_class c WHERE oid='occ.human_authentication_results'::regclass`),
        "t",
      );
    },
    async checkpointState() {
      const current = await readAccount();
      if (!current.length) {
        throw new Error("missing account");
      }
      if (account !== undefined) {
        equal(account, current);
      }
      account = current;
    },
    async assertRetainedState() {
      equal(account, await readAccount());
      if (sessionFacts.size) {
        const rows = (await readSessions([...sessionFacts.keys()])).split("\n");
        equal(rows.length, sessionFacts.size);
        for (const row of rows) {
          const parsed = protectedJSON<unknown>(row);
          if (!Check(sessionRow, parsed)) {
            throw new Error("invalid retained session");
          }
          equal(sessionFacts.get(parsed.id), row);
        }
      }
    },
    async assertResultRow(...[login, expected]: Parameters<Fixture["assertResultRow"]>) {
      const { sessionId, providerId, attemptId, deadline } = login;
      if (
        !["present", "absent", "original-or-pruned"].includes(expected) ||
        !Number.isSafeInteger(deadline)
      ) {
        throw new Error("invalid result expectation");
      }
      const expiry = literal(new Date(deadline).toISOString());
      const row = await sql(`SELECT session_id, provider_id, expires_at = ${expiry}::timestamptz
        FROM occ.human_authentication_results WHERE installation_id=${iid} AND attempt_id=${literal(attemptId)}`);
      if (expected !== "original-or-pruned" || row !== "") {
        equal(row, expected === "absent" ? "" : [sessionId, providerId, "t"].join("|"));
      }
      const facts = await readSessions([sessionId]);
      if (!facts) {
        throw new Error("missing session");
      }
      if (sessionFacts.has(sessionId)) {
        equal(sessionFacts.get(sessionId), facts);
      } else {
        sessionFacts.set(sessionId, facts);
      }
    },
  };
}
