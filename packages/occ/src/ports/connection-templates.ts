import type { StoredOAuthClient } from "./oauth-client.ts";
import type {
  ConnectionTemplate,
  ConnectionTemplateVersion,
  OAuthConnectionTemplateVersion,
} from "@openclaw-enterprise/contracts";

export interface ConnectionTemplateReadRepository {
  listOAuthClientCleanups(limit: number): Promise<readonly string[]>;
  findConnectionTemplate(templateId: string): Promise<Readonly<ConnectionTemplate> | undefined>;
  hasOtherConnectionIssuer(issuer: string): Promise<boolean>;
  countNamespaceConnectionTemplates(namespaceId: string): Promise<number>;
  listConnectionTemplates(): Promise<readonly Readonly<ConnectionTemplate>[]>;
  findStaticConnectionTemplateVersion(
    templateId: string,
    version: number,
  ): Promise<Readonly<Extract<ConnectionTemplateVersion, { mode: "static_bearer" }>> | undefined>;
  findOAuthConnectionTemplateVersion(
    templateId: string,
    version: number,
  ): Promise<Readonly<OAuthConnectionTemplateVersion> | undefined>;
  listOAuthClients(): Promise<readonly Readonly<StoredOAuthClient>[]>;
  countNamespaceOAuthClients(namespaceId: string): Promise<number>;
  findOAuthClient(registrationId: string): Promise<Readonly<StoredOAuthClient> | undefined>;
}

export interface ConnectionTemplateRepository extends ConnectionTemplateReadRepository {
  lockOAuthClient(id: string): Promise<Readonly<StoredOAuthClient> | undefined>;
  lockOAuthClientForCleanup(
    id: string,
    dueOnly: boolean,
  ): Promise<Readonly<StoredOAuthClient> | undefined>;
  setOAuthClientCleanup(id: string, cleanupAfter: string | null): Promise<void>;
  lockConnectionTemplate(templateId: string): Promise<Readonly<ConnectionTemplate> | undefined>;
  createOAuthClient(
    registration: StoredOAuthClient,
    cleanupAfter?: string,
  ): Promise<Readonly<StoredOAuthClient>>;
  /** False while a connection template version still names the registration. */
  deleteOAuthClient(registrationId: string, retainForCleanup?: boolean): Promise<boolean>;
  /** Inserts the template and its first version together. */
  createConnectionTemplate(template: ConnectionTemplate): Promise<Readonly<ConnectionTemplate>>;
  /** Renames, or appends `version` as the next version and makes it current. */
  updateConnectionTemplate(
    templateId: string,
    changes: { readonly displayName?: string; readonly version?: ConnectionTemplateVersion },
  ): Promise<Readonly<ConnectionTemplate> | undefined>;
  deleteConnectionTemplate(templateId: string): Promise<boolean>;
}
