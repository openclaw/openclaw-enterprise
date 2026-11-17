import {
  credentialSourceFieldRequired as requiredFieldText,
  credentialSourceFieldUnknown as unknownFieldText,
  registrationFenceRetry as fenceRetryText,
} from "../helpers/refusal-text.mjs";

export { assertSameAnswer, refusedAnswer } from "../helpers/refusal-answers.ts";

export const credentialSourceFieldRequired: (type: string, field: string) => string =
  requiredFieldText;
export const credentialSourceFieldUnknown: (
  type: string,
  field: string,
  group: string,
  allowed: string,
) => string = unknownFieldText;
export const registrationFenceRetry: (seconds: number) => string = fenceRetryText;
