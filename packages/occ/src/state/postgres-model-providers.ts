import type { ModelProvider } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { ModelProviderRepository } from "./platform-state.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

const columns =
  'id, display_name AS "displayName", base_url AS "baseUrl", protocol, models, default_model_id AS "defaultModelId", connection_template_id AS "connectionTemplateId"';

function providerFromRow(row: Record<string, unknown>): Readonly<ModelProvider> {
  const { defaultModelId, ...provider } = row;
  return immutableCopy({
    ...provider,
    ...(defaultModelId === null ? {} : { defaultModelId }),
  } as unknown as ModelProvider);
}

function parameters(p: ModelProvider) {
  return [
    p.id,
    p.displayName,
    p.baseUrl,
    p.protocol,
    JSON.stringify(p.models),
    p.defaultModelId ?? null,
    p.connectionTemplateId,
  ];
}

export function postgresModelProviders(client: PostgresQueryClient): ModelProviderRepository {
  return {
    findModelProvider: async (id) => {
      const {
        rows: [row],
      } = await client.query(`SELECT ${columns} FROM occ.model_providers WHERE id=$1`, [id]);
      return row === undefined ? undefined : providerFromRow(row as Record<string, unknown>);
    },
    listModelProviders: async () => {
      const { rows } = await client.query(
        `SELECT ${columns} FROM occ.model_providers ORDER BY id`,
        [],
      );
      return Object.freeze(rows.map((row) => providerFromRow(row as Record<string, unknown>)));
    },
    createModelProvider: async (provider) => {
      await client.query(
        `INSERT INTO occ.model_providers (id,display_name,base_url,protocol,models,default_model_id,connection_template_id)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        parameters(provider),
      );
    },
    updateModelProvider: async (provider) => {
      const { rowCount } = await client.query(
        `UPDATE occ.model_providers SET display_name=$2,base_url=$3,protocol=$4,models=$5::jsonb,
        default_model_id=$6,connection_template_id=$7 WHERE id=$1`,
        parameters(provider),
      );
      return rowCount === 1;
    },
  };
}
