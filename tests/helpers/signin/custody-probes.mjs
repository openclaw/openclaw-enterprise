import { isDeepStrictEqual } from "node:util";
import { request } from "node:https";
import { isIP } from "node:net";

// Address and port come from the fixture-owned forward. Preserve HTTP Host, TLS SNI and verification.
export function fixtureFetch(origin, address, port, ca) {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== "https:" || !isIP(address) || !ca?.length) {
    throw new Error("invalid TLS fixture");
  }
  return (url, options) =>
    new Promise((resolve, reject) => {
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
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
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
                headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
              }
              resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
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
  custody,
  userId,
  installationId,
  completedHistory,
  expectedManifest,
) {
  const literal = (v) => {
    if (typeof v !== "string" || !/^[A-Za-z0-9:._|-]{1,255}$/.test(v)) {
      throw new Error("invalid fixture identifier");
    }
    return "'" + v + "'";
  };
  const uid = literal(userId);
  const iid = literal(installationId);
  async function sql(query) {
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
  const equal = (a, b) => {
    if (!isDeepStrictEqual(a, b)) {
      throw new Error("retained state mismatch");
    }
  };
  let ledger;
  let account;
  const sessionFacts = new Map();
  const readSessions = (ids) =>
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
        const validEntries = (entries) =>
          Array.isArray(entries) &&
          entries.length > 0 &&
          entries.every(
            (entry, index) =>
              /^[a-f0-9]{64}$/.test(entry?.sha256) &&
              Number.isSafeInteger(entry.when) &&
              entry.when > (index === 0 ? 0 : entries[index - 1].when),
          );
        if (expectedManifest?.version !== 1 || !validEntries(expectedManifest.entries)) {
          throw new Error("invalid expected migration manifest");
        }
        const histories = [expectedManifest.entries];
        const provider = expectedManifest.compatibleLineages?.providerCompleted;
        if (provider !== undefined) {
          if (
            !validEntries(provider.entries) ||
            provider.entries.length > expectedManifest.entries.length
          ) {
            throw new Error("invalid expected migration manifest");
          }
          histories.push([
            ...provider.entries,
            ...expectedManifest.entries.slice(provider.entries.length),
          ]);
        }
        const receipts = JSON.parse(current);
        const matches =
          Array.isArray(receipts) &&
          histories.some(
            (entries) =>
              receipts.length === entries.length &&
              receipts.every(
                (receipt, index) =>
                  Array.isArray(receipt) &&
                  receipt.length === 3 &&
                  Number.isSafeInteger(receipt[0]) &&
                  receipt[0] > (index === 0 ? 0 : receipts[index - 1][0]) &&
                  receipt[1] === entries[index].sha256 &&
                  receipt[2] === entries[index].when,
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
          equal(sessionFacts.get(JSON.parse(row).id), row);
        }
      }
    },
    async assertResultRow(login, expected) {
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
