import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
 
// --- Phantom's injected provider (minimal shape we actually use) ----------
interface PhantomProvider {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
}
declare global {
  interface Window {
    solana?: PhantomProvider;
  }
}
 
const PROGRAM_ID = new PublicKey("37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A");
declare const HELIUS_API_KEY: string;
const connection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  "confirmed"
);

 
// sha256("global:<ix_name>")[0..8] / sha256("account:DataAccount")[0..8]
const DISC = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  tip: [77, 164, 35, 21, 36, 121, 213, 51],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const;
 
interface JarAccount {
  user: PublicKey;
  bump: number;
  totalTipped: bigint;
  tipCount: bigint;
  lamports: bigint;
}
 
const $ = <T extends Element>(sel: string): T => document.querySelector(sel) as T;
const app = $<HTMLDivElement>("#app");
const heading = $<HTMLHeadingElement>("#heading");
const modeLabel = $<HTMLParagraphElement>("#modeLabel");
const statsEl = $<HTMLParagraphElement>("#stats");
const walletBox = $<HTMLDivElement>("#walletBox");
const fillRect = $<SVGRectElement>("#fillRect");
const coin = $<SVGCircleElement>("#coin");
const toastEl = $<HTMLDivElement>("#toast");
 
let toastTimer: ReturnType<typeof setTimeout>;
function toast(html: string, ms = 4500): void {
  toastEl.innerHTML = html;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}
 
function short(pk: PublicKey): string {
  const s = pk.toBase58();
  return s.slice(0, 4) + "…" + s.slice(-4);
}
 
function u64LE(value: bigint | number): Uint8Array {
  let v = BigInt(value);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
 
function readU64LE(bytes: Uint8Array, offset: number): bigint {
  if (bytes.length < offset + 8) {
    throw new Error(
      `Not enough bytes. Need ${offset + 8}, got ${bytes.length}`
    );
  }
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(bytes[offset + i]) << (8n * BigInt(i));
  }
  return value;
}
 
function ixData(disc: readonly number[], amountLamports?: bigint): Uint8Array {
  if (amountLamports === undefined) return new Uint8Array(disc);
  const out = new Uint8Array(16);
  out.set(disc, 0);
  out.set(u64LE(amountLamports), 8);
  return out;
}
 
// TransactionInstruction types `data` as Buffer, but at runtime web3.js only
// needs a plain byte array. We deliberately don't bundle a Buffer polyfill
// (see index.html's import map), so this satisfies the type without one.
function toIxData(disc: readonly number[], amountLamports?: bigint): Buffer {
  return ixData(disc, amountLamports) as unknown as Buffer;
}
 
function deriveJar(ownerPubkey: PublicKey): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("jar"), ownerPubkey.toBuffer()],
    PROGRAM_ID
  );
  return { pda, bump };
}
 
async function fetchJar(pda: PublicKey): Promise<JarAccount | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) {
    return null;
  }
  const data = info.data;
  // Anchor discriminator + account fields
  if (data.length < 57) {
    console.error(
      "Invalid jar account length:",
      data.length,
      "Expected at least 57"
    );
    return null;
  }
  try {
    const user = new PublicKey(data.slice(8, 40));
 
    const bump = data[40];
 
    const totalTipped = readU64LE(data, 41);
 
    const tipCount = readU64LE(data, 49);
    return {
      user,
      bump,
      totalTipped,
      tipCount,
      lamports: BigInt(info.lamports),
    };
 
  } catch (err) {
    console.error("Failed decoding jar account:", err);
    return null;
  }
}
 
function setFill(lamports: bigint): void {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  const cap = Math.max(2, sol * 1.25); // soft visual scale, keeps headroom
  const pct = Math.max(0, Math.min(1, sol / cap));
  fillRect.style.transform = `translateY(${(1 - pct) * 176}px)`;
}
 
function dropCoin(): void {
  coin.classList.remove("drop");
  void coin.getBBox(); // restart animation
  coin.classList.add("drop");
}
 
// ---- Phantom ---------------------------------------------------------
const provider: PhantomProvider | null = window.solana?.isPhantom ? window.solana : null;
let connectedPubkey: PublicKey | null = null;
 
async function connectWallet(): Promise<PublicKey | null> {
  if (!provider) {
    toast('Phantom not found — <a href="https://phantom.app" target="_blank" rel="noopener">install it</a> and reload.');
    return null;
  }
  const resp = await provider.connect();
  connectedPubkey = resp.publicKey;
  walletBox.textContent = "Connected · " + short(connectedPubkey);
  return connectedPubkey;
}
 
async function sendIx(ix: TransactionInstruction, feePayer: PublicKey): Promise<string> {
  if (!provider) throw new Error("Wallet not connected");
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const { signature } = await provider.signAndSendTransaction(tx);
  toast("Confirming transaction…", 15000);
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}
 
function solscan(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}
 
// ---- Modes -------------------------------------------------------------
const params = new URLSearchParams(location.search);
const ownerParam = params.get("owner");
 
if (ownerParam) {
  void runTipMode(ownerParam);
} else {
  void runMineMode();
}
 
// ===== TIP MODE: visiting someone else's jar link =======================
async function runTipMode(ownerStr: string): Promise<void> {
  modeLabel.textContent = "Tip Jar";
  let ownerPubkey: PublicKey;
  try {
    ownerPubkey = new PublicKey(ownerStr);
  } catch {
    heading.textContent = "Invalid jar link";
    return;
  }
 
  heading.innerHTML = `Tip <span class="addr">${short(ownerPubkey)}</span>`;
  const { pda } = deriveJar(ownerPubkey);
 
  async function refresh(): Promise<JarAccount | null> {
    const jar = await fetchJar(pda);
    if (!jar) {
      statsEl.textContent = "This creator hasn't set up their jar yet.";
      setFill(0n);
      return null;
    }
    statsEl.innerHTML = `<b>${(Number(jar.lamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL</b> in the jar · ${jar.tipCount} tip${jar.tipCount === 1n ? "" : "s"}`;
    setFill(jar.lamports);
    return jar;
  }
  await refresh();
 
  app.innerHTML = `
    <button class="btn-ghost btn-wide" id="connectBtn" style="margin-bottom:12px;">Connect wallet</button>
    <div class="panel">
      <label for="amt">Tip amount (SOL)</label>
      <div class="row">
        <input type="number" id="amt" min="0.001" step="0.001" value="0.05" />
        <button class="btn-brass" id="tipBtn">Send tip</button>
      </div>
    </div>
  `;
 
  $<HTMLButtonElement>("#connectBtn").onclick = async () => {
    const pk = await connectWallet();
    if (pk) $<HTMLButtonElement>("#connectBtn").textContent = "Connected · " + short(pk);
  };
 
  $<HTMLButtonElement>("#tipBtn").onclick = async () => {
    if (!connectedPubkey) {
      const pk = await connectWallet();
      if (!pk) return;
    }
    const solAmt = parseFloat($<HTMLInputElement>("#amt").value);
    if (!(solAmt > 0)) {
      toast("Enter an amount greater than 0.");
      return;
    }
    const lamports = BigInt(Math.round(solAmt * LAMPORTS_PER_SOL));
 
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: connectedPubkey!, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: toIxData(DISC.tip, lamports),
    });
 
    const btn = $<HTMLButtonElement>("#tipBtn");
    btn.disabled = true;
    try {
      const sig = await sendIx(ix, connectedPubkey!);
      dropCoin();
      toast(`Tipped ${solAmt} SOL · <a href="${solscan(sig)}" target="_blank" rel="noopener">view tx</a>`);
      await refresh();
    } catch (e) {
      console.error(e);
      toast("Transaction failed — see console for details.");
    } finally {
      btn.disabled = false;
    }
  };
}
 
// ===== MINE MODE: manage your own jar ====================================
async function runMineMode(): Promise<void> {
  modeLabel.textContent = "Tip Jar";
  heading.textContent = "My Jar";
  statsEl.textContent = "Connect your wallet to view your jar.";
  app.innerHTML = `<button class="btn-brass btn-wide" id="connectBtn">Connect wallet</button>`;
 
  $<HTMLButtonElement>("#connectBtn").onclick = async () => {
    const pk = await connectWallet();
    if (pk) await loadMine(pk);
  };
}
 
async function loadMine(ownerPubkey: PublicKey): Promise<void> {
  const { pda } = deriveJar(ownerPubkey);
  const jar = await fetchJar(pda);
  const shareLink = `${location.origin}${location.pathname}?owner=${ownerPubkey.toBase58()}`;
 
  if (!jar) {
    statsEl.textContent = "You don't have a jar yet.";
    setFill(0n);
    app.innerHTML = `<button class="btn-brass btn-wide" id="createBtn">Create my jar</button>`;
    $<HTMLButtonElement>("#createBtn").onclick = async () => {
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: ownerPubkey, isSigner: true, isWritable: true },
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: toIxData(DISC.initialize),
      });
      const btn = $<HTMLButtonElement>("#createBtn");
      btn.disabled = true;
      try {
        const sig = await sendIx(ix, ownerPubkey);
        toast(`Jar created · <a href="${solscan(sig)}" target="_blank" rel="noopener">view tx</a>`);
        await loadMine(ownerPubkey);
      } catch (e) {
        console.error(e);
        toast("Couldn't create your jar — see console.");
        btn.disabled = false;
      }
    };
    return;
  }
 
  statsEl.innerHTML = `<b>${(Number(jar.lamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL</b> in the jar · ${jar.tipCount} tip${jar.tipCount === 1n ? "" : "s"}`;
  setFill(jar.lamports);
 
  app.innerHTML = `
    <div class="panel" style="margin-bottom:14px;">
      <label>Your tip link</label>
      <div class="row">
        <input type="text" id="link" readonly value="${shareLink}" style="font-size:12px;" />
        <button class="btn-ghost" id="copyBtn" style="white-space:nowrap;">Copy</button>
      </div>
    </div>
    <div class="panel">
      <label for="wAmt">Withdraw (SOL)</label>
      <div class="row">
        <input type="number" id="wAmt" min="0.001" step="0.001" value="0.01" />
        <button class="btn-brass" id="withdrawBtn">Withdraw</button>
      </div>
    </div>
  `;
 
  $<HTMLButtonElement>("#copyBtn").onclick = async () => {
    await navigator.clipboard.writeText(shareLink);
    toast("Link copied.");
  };
 
  $<HTMLButtonElement>("#withdrawBtn").onclick = async () => {
    const solAmt = parseFloat($<HTMLInputElement>("#wAmt").value);
    if (!(solAmt > 0)) {
      toast("Enter an amount greater than 0.");
      return;
    }
    const lamports = BigInt(Math.round(solAmt * LAMPORTS_PER_SOL));
 
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true },
      ],
      data: toIxData(DISC.withdraw, lamports),
    });
 
    const btn = $<HTMLButtonElement>("#withdrawBtn");
    btn.disabled = true;
    try {
      const sig = await sendIx(ix, ownerPubkey);
      toast(`Withdrew ${solAmt} SOL · <a href="${solscan(sig)}" target="_blank" rel="noopener">view tx</a>`);
      await loadMine(ownerPubkey);
    } catch (e) {
      console.error(e);
      toast("Withdraw failed — check the amount doesn't dip below the rent-exempt minimum.");
    } finally {
      btn.disabled = false;
    }
  };
}