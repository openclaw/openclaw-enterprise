import type { StoredCredentialClient } from "./oauth-client.ts";
import type {
  ConnectionTemplate,
  ConnectionTemplateVersion,
  OAuthConnectionTemplateVersion,
} from "@openclaw-enterprise/contracts";

export interface ConnectionTemplateReadRepository {
  listCredentialClientCleanups(limit: number): Promise<readonly string[]>;
  findConnectionTemplate(templateId: string): Promise<Readonly<ConnectionTemplate> | undefined>;
  hasOtherConnectionIssuer(issuer: string): Promise<boolean>;
  countNamespaceConnectionTemplates(namespaceId: string): Promise<number>;
  listConnectionTemplates(): Promise<readonly Readonly<ConnectionTemplate>[]>;
  findOAuthConnectionTemplateVersion(
    templateId: string,
    version: number,
  ): Promise<Readonly<OAuthConnectionTemplateVersion> | undefined>;
  listCredentialClients(): Promise<readonly Readonly<StoredCredentialClient>[]>;
  countNamespaceCredentialClients(namespaceId: string): Promise<number>;
  findCredentialClient(
    registrationId: string,
  ): Promise<Readonly<StoredCredentialClient> | undefined>;
}

export interface ConnectionTemplateRepository extends ConnectionTemplateReadRepository {
  lockCredentialClient(id: string): Promise<Readonly<StoredCredentialClient> | undefined>;
  lockCredentialClientForCleanup(
    id: string,
    dueOnly: boolean,
  ): Promise<Readonly<StoredCredentialClient> | undefined>;
  setCredentialClientCleanup(id: string, cleanupAfter: string | null): Promise<void>;
  lockConnectionTemplate(templateId: string): Promise<Readonly<ConnectionTemplate> | undefined>;
  createCredentialClient(
    registration: StoredCredentialClient,
    cleanupAfter?: string,
  ): Promise<Readonly<StoredCredentialClient>>;
  /** False while an Agent draft, Source or pending OAuth consent still names the Client. */
  deleteCredentialClient(registrationId: string, retainForCleanup?: boolean): Promise<boolean>;
  /** Inserts the template and its first version together. */
  createConnectionTemplate(template: ConnectionTemplate): Promise<Readonly<ConnectionTemplate>>;
  /** Renames, or appends `version` as the next version and makes it current. */
  updateConnectionTemplate(
    templateId: string,
    changes: { readonly displayName?: string; readonly version?: ConnectionTemplateVersion },
  ): Promise<Readonly<ConnectionTemplate> | undefined>;
  deleteConnectionTemplate(templateId: string): Promise<boolean>;
}
