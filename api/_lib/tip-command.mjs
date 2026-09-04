const LAMPORTS_PER_SOL = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;

export function solAmountToLamports(value) {
  if (
    typeof value !== "string" ||
    !/^(?:\d+(?:\.\d{0,9})?|\.\d{1,9})$/.test(value)
  ) {
    throw new Error("Use a positive SOL amount with no more than 9 decimals");
  }
  const [wholeValue, fractionValue = ""] = value.split(".");
  const whole = BigInt(wholeValue || "0");
  const fraction = BigInt((fractionValue + "000000000").slice(0, 9));
  const lamports = whole * LAMPORTS_PER_SOL + fraction;
  if (lamports <= 0n || lamports > U64_MAX) {
    throw new Error("The SOL amount is outside the supported range");
  }
  return lamports;
}

export function formatSol(lamports) {
  const value = BigInt(lamports);
  const whole = value / LAMPORTS_PER_SOL;
  const fraction = (value % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseTipCommand({
  text,
  botUsername,
  botUserId,
  authorUsername,
  inReplyToUserId,
  users = new Map(),
}) {
  if (typeof text !== "string") return null;
  const bot = botUsername.replace(/^@/, "").toLowerCase();
  if (!new RegExp(`@${escapeRegex(bot)}\\b`, "i").test(text)) return null;
  if (!/\bsend\b/i.test(text) || !/\bsol\b/i.test(text)) return null;

  const amounts = [
    ...text.matchAll(/(?:^|\s)(\d+(?:\.\d{0,9})?|\.\d{1,9})\s*sol\b/gi),
  ];
  if (amounts.length !== 1) {
    throw new Error(
      "Use one amount, for example: @TippOnSol send 0.05 SOL to @alice"
    );
  }
  const amountLamports = solAmountToLamports(amounts[0][1]);

  const author = authorUsername?.replace(/^@/, "").toLowerCase();
  const explicit = text.match(/\bto\s+@([a-z0-9_]{1,15})\b/i)?.[1];
  const afterSend = text.match(/\bsend\s+@([a-z0-9_]{1,15})\b/i)?.[1];
  const requestedUsername = explicit ?? afterSend;
  let recipient = requestedUsername
    ? findUserByUsername(users, requestedUsername)
    : null;

  if (!recipient) {
    const mentioned = [...users.values()].filter((user) => {
      const username = user.username?.toLowerCase();
      return username && username !== bot && username !== author;
    });
    if (requestedUsername) {
      throw new Error(`Could not resolve @${requestedUsername}`);
    }
    if (mentioned.length === 1) recipient = mentioned[0];
  }

  if (!recipient && inReplyToUserId && inReplyToUserId !== botUserId) {
    recipient = users.get(inReplyToUserId) ?? {
      id: inReplyToUserId,
      username: "recipient",
    };
  }
  if (!recipient || recipient.username?.toLowerCase() === bot) {
    throw new Error("Tag one recipient or reply to their post");
  }

  return {
    amountLamports,
    recipientXUserId: recipient.id,
    recipientUsername: recipient.username,
  };
}

function findUserByUsername(users, username) {
  const expected = username.toLowerCase();
  return [...users.values()].find(
    (user) => user.username?.toLowerCase() === expected
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
