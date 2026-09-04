import { randomUUID, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { botCredentials, walletLinkByXUserId, xDatabase } from "./x-auth.mjs";
import { fetchBotMentions, replyToPost } from "./x-api.mjs";
import { formatSol, parseTipCommand } from "./tip-command.mjs";

const PROGRAM_ID = new PublicKey(
  "CV75mHHfR1yKnQTowW4TmW7yNTCpk7ET8GYBeu6Wfp5P"
);
const DISC = {
  delegateTip: [184, 159, 59, 118, 92, 158, 67, 119],
  createPendingTip: [160, 81, 116, 45, 218, 104, 3, 107],
};
const PENDING_LIFETIME_SECONDS = 7 * 86_400;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function authorizeProcessorRequest(request) {
  const expected = Buffer.from(required("CRON_SECRET"));
  const actual = Buffer.from(
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function devnetRpcUrl() {
  if (process.env.SOLANA_DEVNET_RPC_URL)
    return process.env.SOLANA_DEVNET_RPC_URL;
  return `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(
    required("HELIUS_API_KEY")
  )}`;
}

function delegateKeypair() {
  const encoded = required("TIPONSOL_DELEGATE_SECRET_KEY").trim();
  let secret;
  try {
    secret = Uint8Array.from(JSON.parse(encoded));
  } catch {
    try {
      secret = bs58.decode(encoded);
    } catch {
      secret = Uint8Array.from(Buffer.from(encoded, "base64"));
    }
  }
  const keypair = Keypair.fromSecretKey(secret);
  const configured = process.env.TIPONSOL_DELEGATE_PUBLIC_KEY;
  if (configured && keypair.publicKey.toBase58() !== configured) {
    throw new Error(
      "The delegate secret does not match its configured public key"
    );
  }
  return keypair;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function i64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value));
  return buffer;
}

function instructionData(discriminator, ...fields) {
  return Buffer.concat([Buffer.from(discriminator), ...fields]);
}

function spendingVault(owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("spending_vault"), owner.toBuffer()],
    PROGRAM_ID
  )[0];
}

function creatorJar(owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("jar"), owner.toBuffer()],
    PROGRAM_ID
  )[0];
}

function pendingTip(vault, postId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pending_tip"), vault.toBuffer(), u64(postId)],
    PROGRAM_ID
  )[0];
}

async function ensureProcessorTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS x_processor_state (
      singleton_id SMALLINT PRIMARY KEY CHECK (singleton_id = 1),
      newest_mention_id TEXT,
      lease_token TEXT,
      lease_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS x_tip_commands (
      post_id TEXT PRIMARY KEY,
      sender_x_user_id TEXT NOT NULL,
      sender_username TEXT NOT NULL,
      recipient_x_user_id TEXT,
      recipient_username TEXT,
      amount_lamports NUMERIC(20, 0),
      status TEXT NOT NULL,
      delivery_kind TEXT,
      transaction_signature TEXT,
      response_post_id TEXT,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    INSERT INTO x_processor_state (singleton_id)
    VALUES (1)
    ON CONFLICT (singleton_id) DO NOTHING
  `;
}

async function acquireLease(sql) {
  const token = randomUUID();
  const rows = await sql`
    UPDATE x_processor_state
    SET lease_token = ${token}, lease_until = NOW() + INTERVAL '55 seconds', updated_at = NOW()
    WHERE singleton_id = 1 AND (lease_until IS NULL OR lease_until < NOW())
    RETURNING newest_mention_id
  `;
  return rows[0] ? { token, cursor: rows[0].newest_mention_id } : null;
}

async function releaseLease(sql, token) {
  await sql`
    UPDATE x_processor_state
    SET lease_token = NULL, lease_until = NULL, updated_at = NOW()
    WHERE singleton_id = 1 AND lease_token = ${token}
  `;
}

async function updateCursor(sql, token, postId) {
  await sql`
    UPDATE x_processor_state
    SET newest_mention_id = ${postId}, updated_at = NOW()
    WHERE singleton_id = 1 AND lease_token = ${token}
  `;
}

async function beginCommand(sql, post, author) {
  const rows = await sql`
    INSERT INTO x_tip_commands (
      post_id, sender_x_user_id, sender_username, status
    ) VALUES (${post.id}, ${post.author_id}, ${author.username}, 'processing')
    ON CONFLICT (post_id) DO UPDATE SET
      status = 'processing', failure_reason = NULL, updated_at = NOW()
    WHERE x_tip_commands.status = 'retryable'
      OR (x_tip_commands.status = 'processing' AND x_tip_commands.updated_at < NOW() - INTERVAL '5 minutes')
    RETURNING post_id
  `;
  return Boolean(rows[0]);
}

async function finishCommand(sql, postId, values) {
  await sql`
    UPDATE x_tip_commands
    SET recipient_x_user_id = ${values.recipientXUserId ?? null},
        recipient_username = ${values.recipientUsername ?? null},
        amount_lamports = ${values.amountLamports?.toString() ?? null},
        status = ${values.status},
        delivery_kind = ${values.deliveryKind ?? null},
        transaction_signature = ${values.signature ?? null},
        response_post_id = ${values.responsePostId ?? null},
        failure_reason = ${values.failureReason ?? null},
        updated_at = NOW()
    WHERE post_id = ${postId}
  `;
}

async function safeReply(text, postId) {
  try {
    return await replyToPost(text.slice(0, 280), postId);
  } catch (error) {
    console.error(`Could not reply to X post ${postId}:`, error);
    return null;
  }
}

async function submitTip({ senderWallet, recipient, postId, amountLamports }) {
  const connection = new Connection(devnetRpcUrl(), "confirmed");
  const delegate = delegateKeypair();
  const owner = new PublicKey(senderWallet);
  const vault = spendingVault(owner);
  const recipientLink = await walletLinkByXUserId(recipient.id);
  let instruction;
  let deliveryKind;

  if (recipientLink) {
    const recipientWallet = new PublicKey(recipientLink.wallet_pubkey);
    const jar = creatorJar(recipientWallet);
    const jarInfo = await connection.getAccountInfo(jar, "confirmed");
    if (jarInfo?.owner.equals(PROGRAM_ID)) {
      instruction = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: delegate.publicKey, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: jar, isSigner: false, isWritable: true },
        ],
        data: instructionData(
          DISC.delegateTip,
          u64(postId),
          u64(amountLamports)
        ),
      });
      deliveryKind = "jar";
    }
  }

  if (!instruction) {
    const escrow = pendingTip(vault, postId);
    const expiresAt = BigInt(
      Math.floor(Date.now() / 1000) + PENDING_LIFETIME_SECONDS
    );
    instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: delegate.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: instructionData(
        DISC.createPendingTip,
        u64(postId),
        u64(recipient.id),
        u64(amountLamports),
        i64(expiresAt)
      ),
    });
    deliveryKind = "pending";
  }

  const transaction = new Transaction().add(instruction);
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [delegate],
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      maxRetries: 3,
    }
  );
  return { signature, deliveryKind };
}

async function processMention(sql, post, users, bot) {
  const author = users.get(post.author_id);
  if (!author?.username) return { terminal: true, outcome: "ignored" };
  let parsed;
  try {
    parsed = parseTipCommand({
      text: post.text,
      botUsername: bot.username,
      botUserId: bot.x_user_id,
      authorUsername: author.username,
      inReplyToUserId: post.in_reply_to_user_id,
      users,
    });
  } catch (error) {
    if (!(await beginCommand(sql, post, author))) {
      return { terminal: true, outcome: "duplicate" };
    }
    const failureReason =
      error instanceof Error ? error.message : "Invalid command";
    const responsePostId = await safeReply(
      `Couldn’t read that tip: ${failureReason}`,
      post.id
    );
    await finishCommand(sql, post.id, {
      status: "rejected",
      failureReason,
      responsePostId,
    });
    return { terminal: true, outcome: "rejected" };
  }
  if (!parsed) return { terminal: true, outcome: "ignored" };
  if (!(await beginCommand(sql, post, author))) {
    return { terminal: true, outcome: "duplicate" };
  }

  const senderLink = await walletLinkByXUserId(post.author_id);
  if (!senderLink) {
    const failureReason = "Sender has not linked a TipOnSol wallet";
    const responsePostId = await safeReply(
      "Link your wallet and create a devnet vault at https://tiponsol.com/?x=setup before tipping.",
      post.id
    );
    await finishCommand(sql, post.id, {
      ...parsed,
      status: "rejected",
      failureReason,
      responsePostId,
    });
    return { terminal: true, outcome: "rejected" };
  }

  try {
    const result = await submitTip({
      senderWallet: senderLink.wallet_pubkey,
      recipient: {
        id: parsed.recipientXUserId,
        username: parsed.recipientUsername,
      },
      postId: BigInt(post.id),
      amountLamports: parsed.amountLamports,
    });
    const amount = formatSol(parsed.amountLamports);
    const response =
      result.deliveryKind === "jar"
        ? `✅ Sent ${amount} devnet SOL to @${parsed.recipientUsername}. https://solscan.io/tx/${result.signature}?cluster=devnet`
        : `⏳ Reserved ${amount} devnet SOL for @${parsed.recipientUsername} for 7 days. Claim support is being enabled next.`;
    const responsePostId = await safeReply(response, post.id);
    await finishCommand(sql, post.id, {
      ...parsed,
      status: result.deliveryKind === "jar" ? "confirmed" : "pending",
      deliveryKind: result.deliveryKind,
      signature: result.signature,
      responsePostId,
    });
    return { terminal: true, outcome: result.deliveryKind };
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : "Tip submission failed";
    await finishCommand(sql, post.id, {
      ...parsed,
      status: "retryable",
      failureReason,
    });
    console.error(`Could not process X post ${post.id}:`, error);
    return { terminal: false, outcome: "retryable" };
  }
}

export async function processXMentions() {
  const sql = xDatabase();
  await ensureProcessorTables(sql);
  const lease = await acquireLease(sql);
  if (!lease) return { busy: true, processed: 0 };

  try {
    const bot = await botCredentials();
    const { mentions, users, truncated } = await fetchBotMentions({
      botUserId: bot.x_user_id,
      sinceId: lease.cursor,
    });
    if (truncated) {
      throw new Error("The X mention backlog is too large to process safely");
    }
    const ordered = mentions.sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0
    );

    if (!lease.cursor) {
      const newest = ordered.at(-1)?.id;
      if (newest) await updateCursor(sql, lease.token, newest);
      return {
        initialized: true,
        skippedHistorical: ordered.length,
        processed: 0,
      };
    }

    const outcomes = [];
    for (const post of ordered) {
      const result = await processMention(sql, post, users, bot);
      outcomes.push({ postId: post.id, outcome: result.outcome });
      if (!result.terminal) break;
      await updateCursor(sql, lease.token, post.id);
    }
    return { processed: outcomes.length, outcomes };
  } finally {
    await releaseLease(sql, lease.token);
  }
}
