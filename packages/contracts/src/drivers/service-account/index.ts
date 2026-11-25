import type { Driver } from "../index.ts";
import type { ServiceAccount } from "../../index.ts";

export interface ServiceAccountDriver extends Driver {
  readonly capability: "service_account";
  create(account: ServiceAccount): Promise<void>;
  createCredential(account: ServiceAccount): Promise<string>;
  delete(account: ServiceAccount): Promise<void>;
}
