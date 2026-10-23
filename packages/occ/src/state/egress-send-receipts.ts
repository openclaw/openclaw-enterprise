import { isDeepStrictEqual } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceStateConflictError } from "../errors.ts";
import {
  attempt,
  authorizedSend,
  observation,
  object,
  outcome,
  receipt,
  type EgressSendReceiptRepository,
  type SendAttempt,
  type StoredSendReceipt,
} from "../egress-send-receipts.ts";

function key(input: SendAttempt): readonly unknown[] {
  return [input.sender.id, input.sender.generation, input.instanceId, input.useId, input.attemptId];
}

function initial(input: SendAttempt): StoredSendReceipt {
  return {
    ...input,
    authorization: null,
    observation: null,
    outcome: { kind: "uncertain", dispatch: "possible" },
    settled: false,
    feedback: null,
  };
}

export function memoryEgressSendReceipts(
  rows: Map<string, StoredSendReceipt>,
): EgressSendReceiptRepository {
  const id = (input: SendAttempt) => JSON.stringify(key(input));
  return {
    find: async (input) => rows.get(id(input)),
    insert: async (input) => {
      if (rows.has(id(input))) {
        return false;
      }
      rows.set(id(input), immutableCopy(initial(attempt(input, input.sender))));
      return true;
    },
    authorize: async (input, value) => {
      const previous = rows.get(id(input));
      const authorization = authorizedSend(value);
      const start = Date.parse(authorization.sendStartBy);
      const at = Date.parse(authorization.authorizedAt);
      if (
        !previous ||
        previous.authorization !== null ||
        previous.settled ||
        previous.observation !== null
      ) {
        return false;
      }
      if (
        authorization.requestDigest.length !== 64 ||
        authorization.injectionDigest.length !== 64 ||
        input.material === null ||
        start <= at ||
        start > at + 1000 ||
        start > Date.parse(input.deadlineAt) ||
        (input.material.kind === "no_material_required"
          ? authorization.injectionDigest !==
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ||
            authorization.association.execution.agentId !== input.material.isolationId ||
            authorization.association.installation.authorityScope !== "execution"
          : start > Date.parse(input.material.usableUntil)) ||
        !isDeepStrictEqual(previous.material, input.material) ||
        authorization.association.installation.instanceId !== input.instanceId ||
        authorization.association.execution.installationId !== input.material.source.installationId
      ) {
        throw new ResourceStateConflictError("Invalid authorized send bounds.");
      }
      rows.set(id(input), immutableCopy({ ...previous, authorization }));
      return true;
    },
    save: async (value) => {
      const previous = rows.get(id(value));
      if (previous === undefined) {
        return;
      }
      const saved = {
        ...previous,
        outcome: outcome(value.outcome),
        observation: value.observation === null ? null : observation(value.observation),
        settled: value.settled,
        feedback: value.feedback,
      };
      // Mirror the SQL receipt constraints in the database substitute.
      if (
        (!saved.settled && saved.outcome.kind !== "uncertain") ||
        ((saved.outcome.kind === "provider_rejected" ||
          saved.observation?.kind === "provider_rejected") &&
          saved.feedback !== "fenced") ||
        (saved.observation !== null &&
          saved.settled &&
          saved.outcome.kind !== "uncertain" &&
          !isDeepStrictEqual(saved.observation, saved.outcome)) ||
        (saved.feedback !== null &&
          (saved.feedback !== "fenced" ||
            saved.material === null ||
            saved.material.kind === "no_material_required" ||
            (saved.observation === null &&
              (!saved.settled ||
                saved.outcome.kind === "refused" ||
                saved.outcome.kind === "uncertain"))))
      ) {
        throw new ResourceStateConflictError("The send receipt input or recorded state conflicts.");
      }
      rows.set(id(value), immutableCopy(saved));
    },
  };
}

export function postgresEgressSendReceipts(client: {
  query(sql: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}): EgressSendReceiptRepository {
  const where =
    "sender_id=$1 AND sender_generation=$2 AND instance_id=$3 AND use_id=$4 AND attempt_id=$5";
  return {
    find: async (input) => {
      const result = await client.query(
        "SELECT * FROM occ.egress_send_receipts WHERE " + where + " FOR UPDATE",
        [...key(input)],
      );
      const found = result.rows[0];
      if (found === undefined) {
        return undefined;
      }
      const row = object(found);
      return receipt(
        {
          ...object(row.binding),
          authorization: row.authorized_dispatch,
          outcome: row.outcome,
          observation: row.observation,
          settled: row.settled,
          feedback: row.feedback,
        },
        input,
      );
    },
    insert: async (input) => {
      const result = await client.query(
        "INSERT INTO occ.egress_send_receipts (sender_id,sender_generation,instance_id,use_id,attempt_id,binding,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING sender_id",
        [...key(input), input, initial(input).outcome],
      );
      return result.rows.length === 1;
    },
    authorize: async (input, authorization) => {
      const result = await client.query(
        "UPDATE occ.egress_send_receipts SET authorized_dispatch=$6 WHERE " +
          where +
          " AND authorized_dispatch IS NULL AND NOT settled AND observation IS NULL RETURNING sender_id",
        [...key(input), authorization],
      );
      return result.rows.length === 1;
    },
    save: async (value) => {
      await client.query(
        "UPDATE occ.egress_send_receipts SET outcome=$6, observation=$7, settled=$8, feedback=$9 WHERE " +
          where,
        [...key(value), value.outcome, value.observation, value.settled, value.feedback],
      );
    },
  };
}
