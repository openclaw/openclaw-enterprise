// One order for Kubernetes events in CI and test diagnostics (findings 2224 and 2225). Events
// written through core/v1 carry a whole-second lastTimestamp, those written through
// events.k8s.io a microsecond eventTime, so comparing the text put "10:00:05.4Z" before
// "10:00:05Z". Times are compared as instants instead, to every digit the API sent.

const RFC3339_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:)(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

// kubectl JSON preserves timestamp text, unlike SDK models that decode it into Dates.
// Both core/v1 and events.k8s.io events can omit or explicitly null these fields.
interface EventTimestamps {
  series?: { lastObservedTime?: string | null } | null;
  lastTimestamp?: string | null;
  eventTime?: string | null;
  firstTimestamp?: string | null;
  metadata?: { creationTimestamp?: string | null } | null;
}

type EventTime = string | null | undefined;

/** When an event was last observed: its series' last sighting, else the newest time it carries. */
export function eventObservedTime(event: EventTimestamps | null | undefined): EventTime {
  return (
    event?.series?.lastObservedTime ??
    event?.lastTimestamp ??
    event?.eventTime ??
    event?.firstTimestamp ??
    event?.metadata?.creationTimestamp
  );
}

function rfc3339Instant(value: string) {
  const match = RFC3339_TIMESTAMP.exec(value);
  if (match === null) {
    return undefined;
  }
  const seconds = Date.parse(`${match[1]}${match[2]}${match[4]}`) / 1_000;
  if (!Number.isSafeInteger(seconds)) {
    return undefined;
  }
  return { seconds, fraction: match[3] ?? "" };
}

/**
 * Orders two event times, oldest first. A missing or unreadable time sorts before every
 * readable one, and two of them are ordered by their text. Equal instants compare as 0, so a
 * stable sort keeps the API's order for them.
 */
export function compareEventTimes(left: EventTime, right: EventTime): number {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  const leftInstant = rfc3339Instant(leftText);
  const rightInstant = rfc3339Instant(rightText);
  if (leftInstant === undefined || rightInstant === undefined) {
    if (leftInstant === rightInstant) {
      return leftText.localeCompare(rightText);
    }
    return leftInstant === undefined ? -1 : 1;
  }
  if (leftInstant.seconds !== rightInstant.seconds) {
    return leftInstant.seconds - rightInstant.seconds;
  }
  const width = Math.max(leftInstant.fraction.length, rightInstant.fraction.length);
  const leftFraction = leftInstant.fraction.padEnd(width, "0");
  const rightFraction = rightInstant.fraction.padEnd(width, "0");
  if (leftFraction === rightFraction) {
    return 0;
  }
  return leftFraction < rightFraction ? -1 : 1;
}

/** Orders two Kubernetes events by eventObservedTime, oldest first. */
export function compareEvents(
  left: EventTimestamps | null | undefined,
  right: EventTimestamps | null | undefined,
): number {
  return compareEventTimes(eventObservedTime(left), eventObservedTime(right));
}
