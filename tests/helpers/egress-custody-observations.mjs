import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { repository, repositoryPath } from "../fixtures/egress-custody-repository-origin.mjs";

// The same exact refusal covers each dispatch state; the retry hint is advisory.
export const refusal =
  "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\nx-should-retry: false\r\n\r\n";

export function faultObserver(socket, command = "status") {
  return new Promise((resolve, reject) => {
    let reply = "";
    const connection = createConnection(socket, () => connection.end(command));
    connection.setTimeout(3000, () =>
      connection.destroy(new Error("missing dispatch fault observer")),
    );
    connection.on("error", reject).on("data", (data) => {
      reply += data;
    });
    connection.on("end", () => {
      try {
        const status = JSON.parse(reply);
        assert.equal(typeof status.authorizations, "number", "observer must confirm selection");
        resolve(status);
      } catch (error) {
        reject(error);
      }
    });
  });
}

// Deliberately project truth predicates, never return a proof, custody nonce,
// credential, or provider response. use_id joins the real supplier request ID.
export async function receipts(pool, installation, selection = "prepared_github") {
  const {
    enforcement: { instanceId, peerKeyId },
    sandboxId,
    plan: { execution },
  } = installation;
  const rows = (
    await pool.query(
      `
    WITH actual AS (
      SELECT use_id AS id, observation, outcome, settled, binding,
        authorized_dispatch AS dispatch, authorized_dispatch->'association' AS a
      FROM occ.egress_send_receipts WHERE instance_id=$1
    )
    SELECT id, observation, outcome, settled,
      (a->'execution'=$2::jsonb AND a->'installation'->>'sandboxId'=$3 AND
       a->'installation'->>'instanceId'=$1 AND a->'installation'->>'peerKeyId'=$4 AND
       length(a->>'exchangeId') > 0 AND length(a->>'responseId') > 0 AND length(a->>'custodyId') > 0 AND
       count(*) over (partition by a->>'custodyId')=1 AND
       a->'installation'->>'authorityScope'='execution' AND a->'installation'->>'policyHash'=$6 AND
       binding->'material'->>'kind'=$5 AND CASE WHEN $5='no_material_required' THEN
       (binding->'material') - ARRAY['kind','source','binding','grantHash','isolationId'] = '{}'::jsonb AND
       binding #>> '{material,source,provider,id}' = 'credential-free-repository-metadata' AND
       dispatch->>'injectionDigest' = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
       ELSE
       (binding->'material'->>'ownerEpoch')::bigint > 0 AND
       (binding->'material'->'family'->>'generation')::bigint > 0 END AND length(dispatch->>'requestDigest')=64 AND
       length(dispatch->>'injectionDigest')=64 AND
       (dispatch->>'sendStartBy')::timestamptz <= (binding->>'deadlineAt')::timestamptz) AS exact
    FROM actual ORDER BY id`,
      [instanceId, execution, sandboxId, peerKeyId, selection, installation.enforcement.policyHash],
    )
  ).rows;
  return rows;
}

export function agentClients({ inAgent }, origin, path = repositoryPath) {
  const target = origin + path;
  // Ordinary independent clients. Neither conveys an identity, credential, binding,
  // executable assertion or capture hook. Both must receive exactly the selected identity.
  const curl = () =>
    inAgent(
      "curl",
      "-q",
      "--silent",
      "--show-error",
      "--include",
      "--raw",
      // Wait for FIN, including in the simultaneous authorized curl/Node comparison.
      "--ignore-content-length",
      "--max-time",
      "90",
      "--header",
      "Connection: close",
      target,
    );
  const node = () =>
    inAgent(
      "node",
      "-e",
      `
    const https=require("node:https");
    const req=https.get(process.argv[1], {headers:{connection:"close"}}, res => {
      const authorized = res.socket.authorized; let body=""; res.on("data",c=>body+=c); res.on("end",()=> {
        if (!res.complete || Object.keys(res.trailers).length || !authorized) process.exitCode=3;
        process.stdout.write(JSON.stringify({status:res.statusCode,body}));
      });
    }); req.on("error",()=>{process.exitCode=4}); req.setTimeout(28000,()=>req.destroy());
  `,
      target,
    );
  // Observe the TLS socket through FIN, including bytes beyond Content-Length.
  // No caller pin, proof, private trust override, or HTTP parser stopping at the head.
  const throughFin = () =>
    inAgent("node", "-e", "(" + readTlsThroughFin.toString() + ")(process.argv[1])", target);
  return { curl, node, throughFin, inAgent };
}

function readTlsThroughFin(target) {
  const url = new URL(target);
  const { connect } = require("node:tls");
  const socket = connect({
    host: url.hostname,
    port: url.port || 443,
    servername: url.hostname,
    rejectUnauthorized: true,
  });
  const received = [];
  let fin = false;
  socket.once("secureConnect", () => {
    const lines = ["GET " + url.pathname + " HTTP/1.1", "Host: " + url.host, "Connection: close"];
    socket.write([...lines, "", ""].join("\r\n"));
  });
  socket.on("data", (chunk) => received.push(chunk));
  socket.once("end", () => (fin = true));
  socket.setTimeout(90000, () => socket.destroy(new Error("no recipient FIN")));
  socket.once("error", () => (process.exitCode = 2));
  socket.once("close", () => {
    if (!fin || !socket.authorized || process.exitCode) {
      process.exitCode = 3;
    } else {
      process.stdout.write(Buffer.concat(received));
    }
  });
}

export function assertIdentityResponse(raw, expected = repository) {
  const identity = JSON.stringify(expected);
  const [headers, body, ...extra] = raw.split("\r\n\r\n");
  const [status, ...fields] = headers.split("\r\n");
  assert.ok(status === "HTTP/1.1 200 OK", "expected approved provider status");
  assert.deepEqual(
    fields.map((value) => value.toLowerCase()).sort(),
    [
      "cache-control: no-store",
      "connection: close",
      "content-length: " + Buffer.byteLength(identity),
      "content-type: application/json",
    ].sort(),
  );
  assert.ok(body === identity && extra.length === 0, "complete exact approved bytes only");
}

// Bypass the protected HTTP transport entirely. Connect by IP to the *same* live,
// permitted TCP target. Even a connection that wrote no HTTP would fail this test.
export async function tryDirectTcp(provider, configuration, inAgent) {
  const { bindHost: host, bindPort: port } = configuration;
  const control = () =>
    new Promise((resolve, reject) => {
      const peer = createConnection({ host, port }, () => peer.end());
      peer.setTimeout(3000, () => peer.destroy(new Error("observer positive control unreachable")));
      peer.on("error", reject).on("close", resolve);
    });
  const start = provider.tcpConnections;
  await control();
  assert.equal(
    provider.tcpConnections,
    start + 1,
    "independent positive reachability of exact bypass target",
  );
  const outcome = JSON.parse(
    await inAgent(
      "node",
      "-e",
      `
    const net=require("node:net");
    const socket=net.connect({host:process.argv[1], port:Number(process.argv[2])});
    let outcome="no-observation"; socket.setTimeout(4000,()=>{outcome="timed-out";socket.destroy()});
    socket.on("error", (e)=>{outcome=e.code||"unclassified-error"});
    socket.on("connect", ()=>socket.write("OCE unmanaged bypass probe\\r\\n"));
    socket.on("data", ()=>{outcome="local-reply";socket.destroy()});
    socket.on("end", ()=>{outcome="peer-refused"});
    socket.on("close", ()=>process.stdout.write(JSON.stringify(outcome)));
  `,
      host,
      String(port),
    ),
  );
  assert.ok(
    ["timed-out", "ECONNREFUSED", "ECONNRESET", "EACCES", "peer-refused", "local-reply"].includes(
      outcome,
    ),
    "workload must execute actual direct connection attempt",
  );
  await control();
  assert.equal(
    provider.tcpConnections,
    start + 2,
    "direct workload bypass reached the independently observed permitted TCP target",
  );
  return { directWorkloadOutcome: outcome, observerControls: 2, directWorkloadConnections: 0 };
}
