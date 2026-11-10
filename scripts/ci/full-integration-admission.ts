const minute = 60_000;
const shaPattern = /^[0-9a-f]{40}$/;

export type PreviousFull =
  | { status: "none" | "active" | "unknown" }
  | { status: "finished"; startedAt: number; finishedAt: number };

type AdmissionInput = {
  now: number;
  eventSha: string;
  mainSha: string | null;
  previousFull: PreviousFull;
  lastExercisedSha: string | null;
};

type Admission =
  | { result: "admit"; testedSha: string }
  | { result: "skip"; reason: "unchanged-main" | "stale-event" | "active-full" }
  | { result: "skip"; reason: "cooldown"; eligibleAt: number }
  | { result: "hold"; reason: "uncertain-metadata" };

export function decideAdmission(input: AdmissionInput): Admission {
  const { now, eventSha, mainSha, previousFull, lastExercisedSha } = input;
  const uncertain: Admission = { result: "hold", reason: "uncertain-metadata" };
  if (
    !Number.isSafeInteger(now) ||
    !mainSha ||
    !shaPattern.test(mainSha) ||
    !shaPattern.test(eventSha) ||
    (lastExercisedSha !== null && !shaPattern.test(lastExercisedSha))
  ) {
    return uncertain;
  }
  if (previousFull.status === "unknown") {
    return uncertain;
  }
  if (previousFull.status === "active") {
    return { result: "skip", reason: "active-full" };
  }
  if (previousFull.status === "finished") {
    const { startedAt, finishedAt } = previousFull;
    if (
      !Number.isSafeInteger(startedAt) ||
      !Number.isSafeInteger(finishedAt) ||
      startedAt > finishedAt ||
      finishedAt > now
    ) {
      return uncertain;
    }
    const eligibleAt = Math.max(startedAt + 60 * minute, finishedAt + 15 * minute);
    if (now < eligibleAt) {
      return { result: "skip", reason: "cooldown", eligibleAt };
    }
  }
  if (eventSha !== mainSha) {
    return { result: "skip", reason: "stale-event" };
  }
  if (mainSha === lastExercisedSha) {
    return { result: "skip", reason: "unchanged-main" };
  }
  return { result: "admit", testedSha: mainSha };
}
