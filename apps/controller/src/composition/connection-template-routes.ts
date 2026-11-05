import { googleWorkspaceDestinations } from "../drivers/plugin/google-workspace/operations.ts";
import {
  connectionTemplateHandlers,
  listConnectionTemplates,
} from "../http/connection-templates.ts";

export const connectionTemplateRoutes: typeof connectionTemplateHandlers = {
  ...connectionTemplateHandlers,
  listConnectionTemplates: listConnectionTemplates(googleWorkspaceDestinations),
};
