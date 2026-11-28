import type {
  ConnectionTemplate,
  ConnectionTemplateVersion,
  OAuthConnectionTemplateVersion,
} from "@openclaw-enterprise/contracts";

export interface ConnectionTemplateReadRepository {
  findConnectionTemplate(templateId: string): Promise<Readonly<ConnectionTemplate> | undefined>;
  hasOtherConnectionIssuer(issuer: string): Promise<boolean>;
  countNamespaceConnectionTemplates(namespaceId: string): Promise<number>;
  listConnectionTemplates(): Promise<readonly Readonly<ConnectionTemplate>[]>;
  findOAuthConnectionTemplateVersion(
    templateId: string,
    version: number,
  ): Promise<Readonly<OAuthConnectionTemplateVersion> | undefined>;
}

export interface ConnectionTemplateRepository extends ConnectionTemplateReadRepository {
  lockConnectionTemplate(templateId: string): Promise<Readonly<ConnectionTemplate> | undefined>;
  /** Inserts the template and its first version together. */
  createConnectionTemplate(template: ConnectionTemplate): Promise<Readonly<ConnectionTemplate>>;
  /** Renames, or appends `version` as the next version and makes it current. */
  updateConnectionTemplate(
    templateId: string,
    changes: { readonly displayName?: string; readonly version?: ConnectionTemplateVersion },
  ): Promise<Readonly<ConnectionTemplate> | undefined>;
  deleteConnectionTemplate(templateId: string): Promise<boolean>;
}
