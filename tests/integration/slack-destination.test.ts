import assert from "node:assert/strict";
import test from "node:test";
import { assertSlackChannelDestination } from "../helpers/slack-delivery.mjs";

const channelId = "C123TEST";
const publicChannel = {
  id: channelId,
  is_channel: true,
  is_private: false,
  is_im: false,
  is_mpim: false,
  is_member: true,
};
const legacyPrivate = {
  id: channelId,
  is_channel: false,
  is_group: true,
  is_private: true,
  is_im: false,
  is_mpim: false,
  is_member: true,
};
const failure = {
  name: "Error",
  message:
    "Slack destination-type failure: conversations.info must identify the exact configured public or private channel, not a DM or MPIM.",
};

// Membership alone admitted DMs. Each refusal retains membership to isolate
// destination validation, and checks the fixed diagnostic instead of payload data.
function refuses(channel: unknown) {
  assert.throws(() => assertSlackChannelDestination({ channel }, channelId), failure);
}

test("Slack destination accepts modern public channels with an optional group flag", () => {
  for (const flags of [{}, { is_group: false }]) {
    assert.doesNotThrow(() =>
      assertSlackChannelDestination({ channel: { ...publicChannel, ...flags } }, channelId),
    );
  }
});

test("Slack destination accepts modern private channels independent of ID prefix", () => {
  for (const id of ["C123TEST", "G123TEST"]) {
    assert.doesNotThrow(() =>
      assertSlackChannelDestination({ channel: { ...publicChannel, id, is_private: true } }, id),
    );
  }
});

test("Slack destination accepts legacy private channels with explicit IM and MPIM exclusions", () => {
  assert.doesNotThrow(() => assertSlackChannelDestination({ channel: legacyPrivate }, channelId));
});

test("Slack destination refuses IMs even with a positive channel flag", () => {
  refuses({ id: channelId, is_im: true, is_member: true });
  refuses({ ...publicChannel, is_im: true });
  refuses({ ...legacyPrivate, is_im: true });
});

test("Slack destination refuses MPIMs including legacy group shapes", () => {
  refuses({ id: channelId, is_mpim: true, is_member: true });
  refuses({ ...publicChannel, is_mpim: true });
  refuses({ ...legacyPrivate, is_mpim: true });
});

for (const [shape, fixture] of [
  ["modern", publicChannel],
  ["legacy", legacyPrivate],
] as const) {
  for (const flag of ["is_im", "is_mpim"] as const) {
    test(`Slack destination refuses ${shape} channels missing ${flag}`, () => {
      const channel: Record<string, unknown> = { ...fixture };
      delete channel[flag];
      refuses(channel);
    });
  }
}

test("Slack destination requires the exact configured ID", () => {
  refuses({ ...publicChannel, id: "COTHER" });
  refuses({ ...legacyPrivate, id: "GOTHER" });
  refuses({ ...publicChannel, id: undefined });
});

test("Slack destination refuses ambiguous, contradictory and malformed responses", () => {
  for (const channel of [
    undefined,
    null,
    [],
    "synthetic-response-data",
    {},
    { id: channelId, is_member: true },
    { ...publicChannel, is_channel: false },
    { ...publicChannel, is_group: true },
    { ...legacyPrivate, is_private: false },
  ]) {
    refuses(channel);
  }
  for (const flag of ["is_channel", "is_private", "is_group", "is_im", "is_mpim"]) {
    for (const value of [undefined, null, "false", 0, {}, []]) {
      refuses({ ...publicChannel, [flag]: value });
    }
  }
  for (const flag of ["is_channel", "is_private"]) {
    const channel: Record<string, unknown> = { ...publicChannel };
    delete channel[flag];
    refuses(channel);
  }
  for (const response of [undefined, null, {}, { channel: null }]) {
    assert.throws(() => assertSlackChannelDestination(response, channelId), failure);
  }
  // A genuine channel without membership must reach the existing invitation diagnostic.
  assert.doesNotThrow(() =>
    assertSlackChannelDestination({ channel: { ...publicChannel, is_member: false } }, channelId),
  );
});
