import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecipients, validTeamRecipients } from "../lib/team-recipients";

test("one address on either team is enough and blank optional fields are ignored", () => {
  assert.deepEqual(normalizeRecipients(["", "", "Player@Gmail.com", ""]), [
    "player@gmail.com",
  ]);
  assert.equal(validTeamRecipients(["", "", "player@gmail.com", ""]), true);
  assert.equal(validTeamRecipients(["", "", "", ""]), false);
});

test("additional recipients must be valid and different", () => {
  assert.deepEqual(
    normalizeRecipients([
      "one@gmail.com",
      "two@gmail.com",
      "",
      "four@gmail.com",
    ]),
    ["one@gmail.com", "two@gmail.com", "four@gmail.com"],
  );
  assert.equal(normalizeRecipients(["same@gmail.com", "same@gmail.com"]), null);
  assert.equal(normalizeRecipients(["good@gmail.com", "not-an-email"]), null);
});
