import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSol,
  parseTipCommand,
  solAmountToLamports,
} from "../api/_lib/tip-command.mjs";
import { authorizeProcessorRequest } from "../api/_lib/x-processor.mjs";

const users = new Map([
  ["1", { id: "1", username: "TippOnSol" }],
  ["2", { id: "2", username: "alice" }],
  ["3", { id: "3", username: "bob" }],
]);

function parse(text, overrides = {}) {
  return parseTipCommand({
    text,
    botUsername: "TippOnSol",
    botUserId: "1",
    authorUsername: "alice",
    users,
    ...overrides,
  });
}

test("parses an explicit recipient after the amount", () => {
  assert.deepEqual(parse("@TippOnSol send 0.05 SOL to @bob"), {
    amountLamports: 50_000_000n,
    recipientXUserId: "3",
    recipientUsername: "bob",
  });
});

test("parses an explicit recipient immediately after send", () => {
  assert.equal(
    parse("@TippOnSol send @bob .5 sol").amountLamports,
    500_000_000n
  );
});

test("uses the replied-to user when no recipient is tagged", () => {
  const replyUsers = new Map([
    ["1", { id: "1", username: "TippOnSol" }],
    ["2", { id: "2", username: "alice" }],
    ["3", { id: "3", username: "bob" }],
  ]);
  assert.equal(
    parse("@TippOnSol send 0.1 SOL", {
      users: replyUsers,
      inReplyToUserId: "3",
    }).recipientXUserId,
    "3"
  );
});

test("ignores ordinary mentions that are not tip commands", () => {
  assert.equal(parse("hello @TippOnSol"), null);
});

test("rejects ambiguous or over-precise amounts", () => {
  assert.throws(() => parse("@TippOnSol send 1.1234567891 SOL to @bob"));
  assert.throws(() => parse("@TippOnSol send 1 SOL and 2 SOL to @bob"));
});

test("converts SOL without floating-point rounding", () => {
  assert.equal(solAmountToLamports("0.000000001"), 1n);
  assert.equal(formatSol(1_230_000_000n), "1.23");
});

test("requires the exact processor bearer secret", () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "processor-secret";
  try {
    assert.equal(
      authorizeProcessorRequest(
        new Request("https://tiponsol.com/api/x/process", {
          headers: { Authorization: "Bearer processor-secret" },
        })
      ),
      true
    );
    assert.equal(
      authorizeProcessorRequest(
        new Request("https://tiponsol.com/api/x/process", {
          headers: { Authorization: "Bearer wrong-secret" },
        })
      ),
      false
    );
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
