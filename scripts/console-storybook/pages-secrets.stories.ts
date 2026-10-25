import { story } from "./story.ts";

export default { title: "Pages/Secrets" };

export const Populated = story("secrets");
export const Mobile = story("secretsMobile", { frameHeight: "844px" });
export const NoSearchMatches = story("secretsSearch");
export const Empty = story("secretsEmpty");
export const Loading = story("secretsLoading");
export const Unavailable = story("secretsUnavailable");
export const NoNamespace = story("secretsNoNamespace");
export const NamespaceNotReady = story("secretsNamespaceNotReady");
export const Create = story("secretsCreate");
export const MissingValue = story("secretsMissingValue");
export const CreateDenied = story("secretsCreateDenied");
export const UnknownSave = story("secretsUnknownSave");
export const Consumers = story("secretsConsumers");
export const Replace = story("secretsReplace");
export const ReplaceDenied = story("secretsReplaceDenied");
export const Delete = story("secretsDelete");
export const DeleteConflict = story("secretsDeleteConflict");
export const DeletionUnconfirmed = story("secretsDeletionUnconfirmed");
