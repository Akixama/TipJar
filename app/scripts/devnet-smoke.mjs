import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const DEVNET_RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("CV75mHHfR1yKnQTowW4TmW7yNTCpk7ET8GYBeu6Wfp5P");
const walletPath = process.argv[2];

if (!walletPath) {
  throw new Error("Usage: node scripts/devnet-smoke.mjs <deployer-keypair.json>");
}

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))),
);
const connection = new Connection(DEVNET_RPC, "confirmed");

const owner = Keypair.generate();
const recipient = Keypair.generate();
const delegate = Keypair.generate();

const discriminators = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  initializeVault: [215, 245, 163, 148, 85, 71, 161, 77],
  deposit: [54, 207, 133, 139, 127, 166, 188, 0],
  createPending: [160, 81, 116, 45, 218, 104, 3, 107],
  claimPending: [164, 233, 223, 41, 226, 13, 182, 184],
  refundPending: [217, 152, 165, 235, 199, 102, 72, 79],
};

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

function data(discriminator, ...fields) {
  return Buffer.concat([Buffer.from(discriminator), ...fields]);
}

function uniqueSigners(signers) {
  const byAddress = new Map();
  for (const signer of [payer, ...signers]) {
    byAddress.set(signer.publicKey.toBase58(), signer);
  }
  return [...byAddress.values()];
}

async function send(instructions, signers = []) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const transaction = new Transaction().add(...instructions);
      return await sendAndConfirmTransaction(
        connection,
        transaction,
        uniqueSigners(signers),
        { commitment: "confirmed" },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Blockhash not found") || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("Transaction retries exhausted");
}

async function chainTime() {
  const slot = await connection.getSlot("confirmed");
  const timestamp = await connection.getBlockTime(slot);
  if (timestamp === null) throw new Error("Devnet block time is unavailable");
  return timestamp;
}

async function waitForExpiry(expiresAt) {
  const deadline = Date.now() + 45_000;
  while ((await chainTime()) < expiresAt) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for escrow expiry");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const [recipientJar] = PublicKey.findProgramAddressSync(
  [Buffer.from("jar"), recipient.publicKey.toBuffer()],
  PROGRAM_ID,
);
const [spendingVault] = PublicKey.findProgramAddressSync(
  [Buffer.from("spending_vault"), owner.publicKey.toBuffer()],
  PROGRAM_ID,
);

const fundingSignature = await send([
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: owner.publicKey,
    lamports: 0.25 * LAMPORTS_PER_SOL,
  }),
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient.publicKey,
    lamports: 0.02 * LAMPORTS_PER_SOL,
  }),
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: delegate.publicKey,
    lamports: 0.02 * LAMPORTS_PER_SOL,
  }),
]);

const initializeJar = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: recipient.publicKey, isSigner: true, isWritable: true },
    { pubkey: recipientJar, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: data(discriminators.initialize),
});
const jarSignature = await send([initializeJar], [recipient]);

const initializeVault = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: spendingVault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: data(
    discriminators.initializeVault,
    delegate.publicKey.toBuffer(),
    u64(0.05 * LAMPORTS_PER_SOL),
    u64(0.2 * LAMPORTS_PER_SOL),
    i64(2n ** 63n - 1n),
  ),
});
const vaultSignature = await send([initializeVault], [owner]);

const deposit = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: spendingVault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: data(discriminators.deposit, u64(0.1 * LAMPORTS_PER_SOL)),
});
const depositSignature = await send([deposit], [owner]);

const recipientXUserId = 9_876_543_210n;
const claimPostId = BigInt(Date.now());
const claimAmount = 0.01 * LAMPORTS_PER_SOL;
const claimExpiry = (await chainTime()) + 600;
const [claimEscrow] = PublicKey.findProgramAddressSync(
  [Buffer.from("pending_tip"), spendingVault.toBuffer(), u64(claimPostId)],
  PROGRAM_ID,
);
const createClaimEscrow = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: delegate.publicKey, isSigner: true, isWritable: true },
    { pubkey: spendingVault, isSigner: false, isWritable: true },
    { pubkey: claimEscrow, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: data(
    discriminators.createPending,
    u64(claimPostId),
    u64(recipientXUserId),
    u64(claimAmount),
    i64(claimExpiry),
  ),
});
const createClaimSignature = await send([createClaimEscrow], [delegate]);

const claim = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: delegate.publicKey, isSigner: true, isWritable: false },
    { pubkey: recipient.publicKey, isSigner: true, isWritable: false },
    { pubkey: recipientJar, isSigner: false, isWritable: true },
    { pubkey: claimEscrow, isSigner: false, isWritable: true },
    { pubkey: delegate.publicKey, isSigner: false, isWritable: true },
  ],
  data: data(discriminators.claimPending, u64(claimPostId)),
});
const claimSignature = await send([claim], [delegate, recipient]);
if ((await connection.getAccountInfo(claimEscrow, "confirmed")) !== null) {
  throw new Error("Claimed escrow was not closed");
}

const refundPostId = claimPostId + 1n;
const refundAmount = 0.005 * LAMPORTS_PER_SOL;
const refundExpiry = (await chainTime()) + 8;
const [refundEscrow] = PublicKey.findProgramAddressSync(
  [Buffer.from("pending_tip"), spendingVault.toBuffer(), u64(refundPostId)],
  PROGRAM_ID,
);
const createRefundEscrow = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: delegate.publicKey, isSigner: true, isWritable: true },
    { pubkey: spendingVault, isSigner: false, isWritable: true },
    { pubkey: refundEscrow, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: data(
    discriminators.createPending,
    u64(refundPostId),
    u64(recipientXUserId),
    u64(refundAmount),
    i64(refundExpiry),
  ),
});
const createRefundSignature = await send([createRefundEscrow], [delegate]);

await waitForExpiry(refundExpiry);
const refund = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: refundEscrow, isSigner: false, isWritable: true },
    { pubkey: delegate.publicKey, isSigner: false, isWritable: true },
  ],
  data: data(discriminators.refundPending, u64(refundPostId)),
});
const refundSignature = await send([refund], [owner]);
if ((await connection.getAccountInfo(refundEscrow, "confirmed")) !== null) {
  throw new Error("Refunded escrow was not closed");
}

const jar = await connection.getAccountInfo(recipientJar, "confirmed");
if (!jar) throw new Error("Recipient jar is missing");
const totalTipped = jar.data.readBigUInt64LE(41);
const tipCount = jar.data.readBigUInt64LE(49);
if (totalTipped !== BigInt(claimAmount) || tipCount !== 1n) {
  throw new Error(`Unexpected jar totals: ${totalTipped} lamports, ${tipCount} tips`);
}

console.log(
  JSON.stringify(
    {
      programId: PROGRAM_ID.toBase58(),
      owner: owner.publicKey.toBase58(),
      recipient: recipient.publicKey.toBase58(),
      recipientJar: recipientJar.toBase58(),
      spendingVault: spendingVault.toBase58(),
      totalTippedLamports: totalTipped.toString(),
      tipCount: tipCount.toString(),
      signatures: {
        funding: fundingSignature,
        initializeJar: jarSignature,
        initializeVault: vaultSignature,
        deposit: depositSignature,
        createClaimEscrow: createClaimSignature,
        claim: claimSignature,
        createRefundEscrow: createRefundSignature,
        refund: refundSignature,
      },
    },
    null,
    2,
  ),
);
