import type { requestFailure } from "../../apps/controller/src/http/errors.ts";
import {
  assertSameAnswer as compareRefusedAnswers,
  refusedAnswer as formatRefusedAnswer,
} from "../helpers/refusal-answers.mjs";
import {
  credentialSourceFieldRequired as requiredFieldText,
  credentialSourceFieldUnknown as unknownFieldText,
  registrationFenceRetry as fenceRetryText,
} from "../helpers/refusal-text.mjs";

// Give the shared JavaScript helpers typed inputs and outputs for this suite's flat HTTP answers.
type RefusedWork = () => Promise<unknown>;
type RefusalAnswer = Pick<ReturnType<typeof requestFailure>, "status" | "code" | "message">;

export const refusedAnswer: (
  work: RefusedWork,
  options?: Parameters<typeof requestFailure>[1],
) => Promise<RefusalAnswer> = formatRefusedAnswer;

export const assertSameAnswer: (
  send: (id: string) => Promise<RefusalAnswer>,
  ids: readonly string[],
  options?: { status?: number; label?: string },
) => Promise<unknown> = compareRefusedAnswers;

export const credentialSourceFieldRequired: (type: string, field: string) => string =
  requiredFieldText;
export const credentialSourceFieldUnknown: (
  type: string,
  field: string,
  group: string,
  allowed: string,
) => string = unknownFieldText;
export const registrationFenceRetry: (seconds: number) => string = fenceRetryText;
