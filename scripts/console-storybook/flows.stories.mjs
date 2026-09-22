import { story } from "./story.mjs";

export default { title: "Flows" };

export const CreateFlow = { ...story("createFlow"), name: "Create and deploy an Agent" };
export const UpdateFlow = { ...story("updateFlow"), name: "Update an Agent" };
export const StopFlow = { ...story("stopFlow"), name: "Stop an Agent — unavailable" };
export const DeleteFlow = { ...story("deleteFlow"), name: "Delete an Agent" };
