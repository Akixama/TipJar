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
  connect(options?: {
    onlyIfTrusted?: boolean;
  }): Promise<{ publicKey: PublicKey }>;
  signMessage?(
    message: Uint8Array,
    display?: "utf8" | "hex"
  ): Promise<{ signature: Uint8Array }>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
}
declare global {
  interface Window {
    solana?: PhantomProvider;
  }
}

const PROGRAM_ID = new PublicKey(
  "37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A"
);
const connection = new Connection(`${location.origin}/api/rpc`, "confirmed");
const DEVNET_PROGRAM_ID = new PublicKey(
  "CV75mHHfR1yKnQTowW4TmW7yNTCpk7ET8GYBeu6Wfp5P"
);
const devnetConnection = new Connection(
  `${location.origin}/api/rpc?cluster=devnet`,
  "confirmed"
);

// sha256("global:<ix_name>")[0..8] / sha256("account:DataAccount")[0..8]
const DISC = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  tip: [77, 164, 35, 21, 36, 121, 213, 51],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  initializeVault: [215, 245, 163, 148, 85, 71, 161, 77],
  updateVault: [8, 102, 196, 202, 70, 163, 149, 137],
  depositVault: [54, 207, 133, 139, 127, 166, 188, 0],
  withdrawVault: [60, 50, 96, 26, 194, 124, 89, 168],
  revokeVault: [81, 78, 80, 13, 127, 157, 203, 124],
} as const;

interface JarAccount {
  user: PublicKey;
  bump: number;
  totalTipped: bigint;
  tipCount: bigint;
  lamports: bigint;
}

const $ = <T extends Element>(sel: string): T =>
  document.querySelector(sel) as T;
const app = $<HTMLDivElement>("#app");
const heading = $<HTMLHeadingElement>("#heading");
const modeLabel = $<HTMLParagraphElement>("#modeLabel");
const lede = $<HTMLParagraphElement>("#lede");
const statsEl = $<HTMLDivElement>("#stats");
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

function instructionData(
  discriminator: readonly number[],
  ...fields: Uint8Array[]
): Buffer {
  const length =
    discriminator.length + fields.reduce((sum, field) => sum + field.length, 0);
  const data = new Uint8Array(length);
  let offset = 0;
  data.set(discriminator, offset);
  offset += discriminator.length;
  for (const field of fields) {
    data.set(field, offset);
    offset += field.length;
  }
  return data as unknown as Buffer;
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

function deriveSpendingVault(ownerPubkey: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("spending_vault"), ownerPubkey.toBuffer()],
    DEVNET_PROGRAM_ID
  )[0];
}

async function fetchJar(pda: PublicKey): Promise<JarAccount | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda);
  } catch (error) {
    console.error("Could not load jar account:", error);
    return null;
  }
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
  fillRect.style.transform = `translateY(${(1 - pct) * 198}px)`;
}

interface SpendingVaultAccount {
  delegate: PublicKey;
  maxTipLamports: bigint;
  dailyLimitLamports: bigint;
  spentInWindow: bigint;
  authorizationExpiresAt: bigint;
  paused: boolean;
  availableLamports: bigint;
}

interface WalletLinkStatus {
  linked: boolean;
  username?: string;
}

interface XConfig {
  cluster: "devnet";
  programId: string;
  delegate: string;
}

function transactionErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/AccountNotFound/i.test(message)) {
    return "This wallet has no SOL on mainnet. Add at least 0.002 SOL, then try again.";
  }
  if (/insufficient (funds|lamports)/i.test(message)) {
    return "Your wallet needs more SOL for the transaction and network fee.";
  }
  if (/transaction simulation failed/i.test(message)) {
    return "The transaction failed Solana's safety check, so it was not sent to Phantom.";
  }
  return fallback;
}

function renderStats(jar: JarAccount | null): void {
  if (!jar) {
    statsEl.innerHTML = `
      <div class="stat"><span class="stat-label">Jar balance</span><strong>0.000 SOL</strong></div>
      <div class="stat"><span class="stat-label">Community</span><strong>0 tips</strong></div>
    `;
    return;
  }

  const balance = (Number(jar.lamports) / LAMPORTS_PER_SOL).toFixed(3);
  statsEl.innerHTML = `
    <div class="stat"><span class="stat-label">Jar balance</span><strong class="accent">${balance} SOL</strong></div>
    <div class="stat"><span class="stat-label">Community</span><strong>${
      jar.tipCount
    } tip${jar.tipCount === 1n ? "" : "s"}</strong></div>
  `;
}

function dropCoin(): void {
  coin.classList.remove("drop");
  void coin.getBBox(); // restart animation
  coin.classList.add("drop");
}

// ---- Phantom ---------------------------------------------------------
const provider: PhantomProvider | null = window.solana?.isPhantom
  ? window.solana
  : null;
let connectedPubkey: PublicKey | null = null;

async function connectWallet(onlyIfTrusted = false): Promise<PublicKey | null> {
  if (!provider) {
    toast(
      'Phantom not found — <a href="https://phantom.app" target="_blank" rel="noopener">install it</a> and reload.'
    );
    return null;
  }
  const resp = await provider.connect(
    onlyIfTrusted ? { onlyIfTrusted: true } : undefined
  );
  connectedPubkey = resp.publicKey;
  walletBox.classList.add("connected");
  walletBox.innerHTML = `<span></span>${short(connectedPubkey)}`;
  return connectedPubkey;
}

async function sendIxs(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  rpcConnection = connection
): Promise<string> {
  if (!provider) throw new Error("Wallet not connected");
  const tx = new Transaction().add(...instructions);
  tx.feePayer = feePayer;
  const { blockhash } = await rpcConnection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  // Catch transactions that Phantom cannot simulate before asking the user to
  // approve them. Phantom treats failed or indeterminate simulations as unsafe.
  const simulation = await rpcConnection.simulateTransaction(tx);
  if (simulation.value.err) {
    console.error(
      "Transaction simulation failed:",
      simulation.value.err,
      simulation.value.logs
    );
    const detail = JSON.stringify(simulation.value.err);
    const logs = simulation.value.logs?.join(" ") ?? "";
    throw new Error(`Transaction simulation failed: ${detail} ${logs}`);
  }

  const { signature } = await provider.signAndSendTransaction(tx);
  toast("Confirming transaction…", 15000);
  await rpcConnection.confirmTransaction(signature, "confirmed");
  return signature;
}

async function sendIx(
  ix: TransactionInstruction,
  feePayer: PublicKey,
  rpcConnection = connection
): Promise<string> {
  return sendIxs([ix], feePayer, rpcConnection);
}

function solscan(
  sig: string,
  cluster: "mainnet" | "devnet" = "mainnet"
): string {
  return `https://solscan.io/tx/${sig}${
    cluster === "devnet" ? "?cluster=devnet" : ""
  }`;
}

// ---- Modes -------------------------------------------------------------
const params = new URLSearchParams(location.search);
const ownerParam = params.get("owner");
const xSetup = params.get("x") === "setup";

if (xSetup) {
  void runXSetupMode();
} else if (ownerParam) {
  void runTipMode(ownerParam);
} else {
  void runMineMode();
}

// ===== TIP MODE: visiting someone else's jar link =======================
async function runTipMode(ownerStr: string): Promise<void> {
  modeLabel.textContent = "Support a creator";
  let ownerPubkey: PublicKey;
  try {
    ownerPubkey = new PublicKey(ownerStr);
  } catch {
    heading.textContent = "Invalid jar link";
    lede.textContent =
      "This link does not contain a valid Solana wallet address.";
    app.innerHTML = `<div class="muted">Ask the creator for a fresh TipJar link.</div>`;
    return;
  }

  heading.innerHTML = `Send a little<br><span>something good.</span>`;
  lede.innerHTML = `A direct, on-chain thank you for <span class="addr">${short(
    ownerPubkey
  )}</span>. No middleman, no platform cut.`;
  const { pda } = deriveJar(ownerPubkey);

  async function refresh(): Promise<JarAccount | null> {
    const jar = await fetchJar(pda);
    if (!jar) {
      renderStats(null);
      setFill(0n);
      return null;
    }
    renderStats(jar);
    setFill(jar.lamports);
    return jar;
  }
  await refresh();

  app.innerHTML = `
    <div class="form-heading">
      <h2>Leave a tip</h2>
      <p>Choose an amount, connect Phantom, and approve the transaction.</p>
    </div>
    <button class="btn-ghost btn-wide" id="connectBtn">Connect Phantom</button>
    <div class="panel" style="margin-top:14px;">
      <label for="amt">Choose an amount</label>
      <div class="amount-presets">
        <button type="button" class="preset-btn" data-amount="0.01">0.01 SOL</button>
        <button type="button" class="preset-btn selected" data-amount="0.05">0.05 SOL</button>
        <button type="button" class="preset-btn" data-amount="0.1">0.10 SOL</button>
      </div>
      <div class="amount-field">
        <input type="number" id="amt" aria-label="Custom tip amount in SOL" min="0.001" step="0.001" value="0.05" />
        <span class="amount-unit">SOL</span>
      </div>
      <button class="btn-brass btn-wide primary-action" id="tipBtn">Send tip</button>
      <p class="fine-print">You’ll review the exact amount in Phantom before anything is sent.</p>
    </div>
  `;

  const amountInput = $<HTMLInputElement>("#amt");
  const presetButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".preset-btn")
  );
  for (const preset of presetButtons) {
    preset.onclick = () => {
      amountInput.value = preset.dataset.amount ?? "0.05";
      for (const button of presetButtons)
        button.classList.toggle("selected", button === preset);
    };
  }
  amountInput.oninput = () => {
    for (const button of presetButtons) {
      button.classList.toggle(
        "selected",
        button.dataset.amount === amountInput.value
      );
    }
  };

  $<HTMLButtonElement>("#connectBtn").onclick = async () => {
    try {
      const pk = await connectWallet();
      if (pk)
        $<HTMLButtonElement>("#connectBtn").textContent =
          "Wallet connected · " + short(pk);
    } catch (e) {
      console.error(e);
      toast("Couldn't connect — check your connection and try again.");
    }
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
      toast(
        `Tipped ${solAmt} SOL · <a href="${solscan(
          sig
        )}" target="_blank" rel="noopener">view tx</a>`
      );
      await refresh();
    } catch (e) {
      console.error(e);
      toast(
        transactionErrorMessage(e, "Transaction failed — please try again.")
      );
    } finally {
      btn.disabled = false;
    }
  };
}

// ===== MINE MODE: manage your own jar ====================================
async function runMineMode(): Promise<void> {
  modeLabel.textContent = "Your creator page";
  heading.innerHTML = `Turn appreciation<br><span>into momentum.</span>`;
  lede.textContent =
    "Create your on-chain jar, share one link, and receive SOL directly from the people who value your work.";
  renderStats(null);
  app.innerHTML = `
    <div class="form-heading">
      <h2>Open your jar</h2>
      <p>Connect Phantom to create a jar or manage one you already own.</p>
    </div>
    <button class="btn-brass btn-wide primary-action" id="connectBtn">Connect Phantom</button>
    <p class="fine-print">Free to use. You only pay Solana network fees.</p>
  `;

  $<HTMLButtonElement>("#connectBtn").onclick = async () => {
    try {
      const pk = await connectWallet();
      if (pk) await loadMine(pk);
    } catch (e) {
      console.error(e);
      toast("Couldn't load your jar — check your connection and try again.");
    }
  };
}
async function loadMine(ownerPubkey: PublicKey): Promise<void> {
  const { pda } = deriveJar(ownerPubkey);
  const jar = await fetchJar(pda);
  const shareLink = `${location.origin}${
    location.pathname
  }?owner=${ownerPubkey.toBase58()}`;

  if (!jar) {
    renderStats(null);
    setFill(0n);
    app.innerHTML = `
      <div class="form-heading">
        <h2>Your jar is ready to begin</h2>
        <p>One small on-chain transaction creates a permanent jar tied to your wallet.</p>
      </div>
      <button class="btn-brass btn-wide primary-action" id="createBtn">Create my TipJar</button>
      <a class="btn-ghost btn-link btn-wide" href="?x=setup">Set up X tipping · Devnet pilot</a>
      <p class="fine-print">Your wallet remains the only authority that can withdraw.</p>
    `;
    $<HTMLButtonElement>("#createBtn").onclick = async () => {
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: ownerPubkey, isSigner: true, isWritable: true },
          { pubkey: pda, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: toIxData(DISC.initialize),
      });
      const btn = $<HTMLButtonElement>("#createBtn");
      btn.disabled = true;
      try {
        const sig = await sendIx(ix, ownerPubkey);
        toast(
          `Jar created · <a href="${solscan(
            sig
          )}" target="_blank" rel="noopener">view tx</a>`
        );
        await loadMine(ownerPubkey);
      } catch (e) {
        console.error(e);
        toast(
          transactionErrorMessage(
            e,
            "Couldn't create your jar — please try again."
          )
        );
        btn.disabled = false;
      }
    };
    return;
  }

  renderStats(jar);
  setFill(jar.lamports);

  app.innerHTML = `
    <div class="form-heading">
      <h2>Your jar is live</h2>
      <p>Share your personal link or withdraw from your available balance.</p>
    </div>
    <div class="panel">
      <label>Your tip link</label>
      <div class="copy-field">
        <input type="text" id="link" readonly value="${shareLink}" />
        <button class="btn-ghost" id="copyBtn">Copy</button>
      </div>
    </div>
    <div class="panel">
      <label for="wAmt">Withdraw funds</label>
      <div class="amount-field">
        <input type="number" id="wAmt" min="0.001" step="0.001" value="0.01" />
        <span class="amount-unit">SOL</span>
      </div>
      <button class="btn-brass btn-wide primary-action" id="withdrawBtn">Withdraw to wallet</button>
      <p class="fine-print">The rent-exempt minimum stays in the jar so it remains active.</p>
    </div>
    <a class="btn-ghost btn-link btn-wide" href="?x=setup">Set up X tipping · Devnet pilot</a>
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
      toast(
        `Withdrew ${solAmt} SOL · <a href="${solscan(
          sig
        )}" target="_blank" rel="noopener">view tx</a>`
      );
      await loadMine(ownerPubkey);
    } catch (e) {
      console.error(e);
      toast(
        transactionErrorMessage(
          e,
          "Withdraw failed — check the amount doesn't dip below the rent-exempt minimum."
        )
      );
    } finally {
      btn.disabled = false;
    }
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[character] ?? character)
  );
}

function solValue(lamports: bigint, digits = 3): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(digits);
}

function inputLamports(id: string): bigint {
  const value = Number($<HTMLInputElement>(`#${id}`).value);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("Enter an amount greater than zero.");
  return BigInt(Math.round(value * LAMPORTS_PER_SOL));
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}

async function fetchSpendingVault(
  owner: PublicKey
): Promise<SpendingVaultAccount | null> {
  const address = deriveSpendingVault(owner);
  const info = await devnetConnection.getAccountInfo(address);
  if (!info) return null;
  if (info.data.length < 122)
    throw new Error("The spending vault data is invalid.");
  const rent = await devnetConnection.getMinimumBalanceForRentExemption(
    info.data.length
  );
  return {
    delegate: new PublicKey(info.data.slice(40, 72)),
    maxTipLamports: readU64LE(info.data, 72),
    dailyLimitLamports: readU64LE(info.data, 80),
    spentInWindow: readU64LE(info.data, 88),
    authorizationExpiresAt: readU64LE(info.data, 104),
    paused: info.data[121] !== 0,
    availableLamports: BigInt(Math.max(0, info.lamports - rent)),
  };
}

function vaultPolicyData(
  discriminator: readonly number[],
  delegate: PublicKey,
  maxTip: bigint,
  dailyLimit: bigint,
  expiresAt: bigint,
  paused?: boolean
): Buffer {
  const fields = [
    delegate.toBytes(),
    u64LE(maxTip),
    u64LE(dailyLimit),
    u64LE(expiresAt),
  ];
  if (paused !== undefined) fields.push(new Uint8Array([paused ? 1 : 0]));
  return instructionData(discriminator, ...fields);
}

async function runXSetupMode(): Promise<void> {
  modeLabel.textContent = "X tipping · Devnet pilot";
  heading.innerHTML = `Tip from a post.<br><span>Stay in control.</span>`;
  lede.textContent =
    "Link X to your wallet, set a separate SOL budget, and cap what the bot may send. Your main wallet remains inaccessible.";
  const networkPill = document.querySelector<HTMLElement>(".network-pill");
  if (networkPill)
    networkPill.innerHTML = `<span class="network-dot testnet"></span>Solana devnet pilot`;
  statsEl.innerHTML = `
    <div class="stat"><span class="stat-label">Vault budget</span><strong>Not created</strong></div>
    <div class="stat"><span class="stat-label">24h usage</span><strong>0.000 SOL</strong></div>
  `;
  app.classList.add("x-setup-area");
  app.innerHTML = `
    <div class="form-heading">
      <span class="pilot-badge">Safe test mode</span>
      <h2>Connect your wallet</h2>
      <p>This pilot uses devnet SOL only. Nothing here can spend mainnet SOL.</p>
    </div>
    <button class="btn-brass btn-wide primary-action" id="connectBtn">Connect Phantom</button>
    <p class="wallet-help">Already connected on TipJar? We’ll restore it automatically. Need a wallet? Create or import one inside <a href="https://phantom.app" target="_blank" rel="noopener">Phantom</a>—TipOnSol never sees your recovery phrase.</p>
    <a class="quiet-link" href="/">Back to my TipJar</a>
  `;
  $<HTMLButtonElement>("#connectBtn").onclick = async () => {
    try {
      const owner = await connectWallet();
      if (owner) await renderXSetup(owner);
    } catch (error) {
      console.error(error);
      toast("Couldn't connect your wallet.");
    }
  };

  if (provider) {
    try {
      const trustedOwner = await connectWallet(true);
      if (trustedOwner) await renderXSetup(trustedOwner);
    } catch {
      // A silent reconnect is intentionally optional. The explicit button
      // remains available if Phantom has not trusted this origin yet.
    }
  }
}

async function renderXSetup(owner: PublicKey): Promise<void> {
  app.innerHTML = `<div class="loading-state"><span class="spinner"></span><span>Loading X setup</span></div>`;
  try {
    const [link, config, vault] = await Promise.all([
      jsonRequest<WalletLinkStatus>(
        `/api/x/link/status?wallet=${encodeURIComponent(owner.toBase58())}`
      ),
      jsonRequest<XConfig>("/api/x/config"),
      fetchSpendingVault(owner),
    ]);
    const delegate = new PublicKey(config.delegate);
    renderXStats(vault);
    app.innerHTML = `${xIdentityPanel(link)}${
      vault ? existingVaultPanel(vault) : newVaultPanel(link.linked)
    }`;
    wireXIdentityAction(owner, link);
    if (vault) wireExistingVaultActions(owner, vault, delegate);
    else wireNewVaultAction(owner, delegate, link.linked);
  } catch (error) {
    console.error(error);
    app.innerHTML = `
      <div class="form-heading"><h2>Setup unavailable</h2><p>We couldn't load the devnet pilot configuration.</p></div>
      <button class="btn-ghost btn-wide" id="retryXBtn">Try again</button>
    `;
    $<HTMLButtonElement>("#retryXBtn").onclick = () => void renderXSetup(owner);
  }
}

function renderXStats(vault: SpendingVaultAccount | null): void {
  statsEl.innerHTML = `
    <div class="stat"><span class="stat-label">Vault budget</span><strong class="accent">${
      vault ? `${solValue(vault.availableLamports)} SOL` : "Not created"
    }</strong></div>
    <div class="stat"><span class="stat-label">24h usage</span><strong>${
      vault ? `${solValue(vault.spentInWindow)} SOL` : "0.000 SOL"
    }</strong></div>
  `;
}

function xIdentityPanel(link: WalletLinkStatus): string {
  return `
    <div class="setup-step ${link.linked ? "complete" : ""}">
      <div class="step-number">${link.linked ? "✓" : "1"}</div>
      <div class="step-copy"><strong>${
        link.linked
          ? `@${escapeHtml(link.username ?? "X account")}`
          : "Link your X identity"
      }</strong><span>${
    link.linked
      ? "Verified for this wallet"
      : "Sign a message, then approve X access"
  }</span></div>
      <button class="btn-ghost compact-btn" id="linkXBtn">${
        link.linked ? "Change" : "Link X"
      }</button>
    </div>
  `;
}

function newVaultPanel(linked: boolean): string {
  return `
    <div class="setup-step ${linked ? "" : "locked"}">
      <div class="step-number">2</div>
      <div class="step-copy"><strong>Create your spending vault</strong><span>A separate, owner-controlled devnet budget</span></div>
    </div>
    <div class="panel vault-form">
      <div class="field-grid">
        <div><label for="maxTip">Maximum per tip</label><div class="amount-field"><input id="maxTip" type="number" min="0.001" step="0.001" value="0.05"><span class="amount-unit">SOL</span></div></div>
        <div><label for="dailyLimit">Maximum per 24h</label><div class="amount-field"><input id="dailyLimit" type="number" min="0.001" step="0.001" value="0.20"><span class="amount-unit">SOL</span></div></div>
      </div>
      <label for="initialDeposit">Initial test budget</label>
      <div class="amount-field"><input id="initialDeposit" type="number" min="0.001" step="0.001" value="0.20"><span class="amount-unit">SOL</span></div>
      <button class="btn-brass btn-wide primary-action" id="createVaultBtn" ${
        linked ? "" : "disabled"
      }>Create and fund vault</button>
      <p class="fine-print">Authorization lasts 30 days. You can pause, change limits, withdraw, or revoke at any time.</p>
    </div>
    <a class="quiet-link" href="/">Back to my TipJar</a>
  `;
}

function existingVaultPanel(vault: SpendingVaultAccount): string {
  const isRevoked = vault.delegate.equals(PublicKey.default);
  const status = isRevoked ? "Revoked" : vault.paused ? "Paused" : "Active";
  const expires = new Date(
    Number(vault.authorizationExpiresAt) * 1000
  ).toLocaleDateString();
  return `
    <div class="setup-step complete">
      <div class="step-number">✓</div>
      <div class="step-copy"><strong>Spending vault</strong><span>${status} · authorization until ${escapeHtml(
    expires
  )}</span></div>
      <span class="status-chip ${status.toLowerCase()}">${status}</span>
    </div>
    <div class="panel vault-form">
      <label>Spending limits</label>
      <div class="field-grid">
        <div><label for="maxTip">Per tip</label><div class="amount-field"><input id="maxTip" type="number" min="0.001" step="0.001" value="${solValue(
          vault.maxTipLamports,
          4
        )}"><span class="amount-unit">SOL</span></div></div>
        <div><label for="dailyLimit">Per 24h</label><div class="amount-field"><input id="dailyLimit" type="number" min="0.001" step="0.001" value="${solValue(
          vault.dailyLimitLamports,
          4
        )}"><span class="amount-unit">SOL</span></div></div>
      </div>
      <button class="btn-ghost btn-wide" id="savePolicyBtn">Save limits · renew 30 days</button>
    </div>
    <div class="panel vault-form">
      <label for="fundAmount">Vault funds</label>
      <div class="amount-field"><input id="fundAmount" type="number" min="0.001" step="0.001" value="0.10"><span class="amount-unit">SOL</span></div>
      <div class="button-grid"><button class="btn-brass" id="depositVaultBtn">Add funds</button><button class="btn-ghost" id="withdrawVaultBtn">Withdraw</button></div>
    </div>
    <div class="button-grid danger-zone">
      <button class="btn-ghost" id="pauseVaultBtn">${
        vault.paused || isRevoked ? "Resume access" : "Pause access"
      }</button>
      <button class="btn-danger" id="revokeVaultBtn" ${
        isRevoked ? "disabled" : ""
      }>Revoke bot</button>
    </div>
    <p class="fine-print">Only this wallet can change policy or withdraw. The bot can only tip within these limits.</p>
    <a class="quiet-link" href="/">Back to my TipJar</a>
  `;
}

function wireXIdentityAction(owner: PublicKey, link: WalletLinkStatus): void {
  const button = $<HTMLButtonElement>("#linkXBtn");
  button.onclick = async () => {
    if (!provider?.signMessage) {
      toast(
        "This wallet cannot sign verification messages. Open TipOnSol in Phantom."
      );
      return;
    }
    button.disabled = true;
    try {
      const challenge = await jsonRequest<{
        challengeId: string;
        message: string;
      }>("/api/x/link/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: owner.toBase58() }),
      });
      const signed = await provider.signMessage(
        new TextEncoder().encode(challenge.message),
        "utf8"
      );
      let binary = "";
      for (const byte of signed.signature) binary += String.fromCharCode(byte);
      const verified = await jsonRequest<{ authorizationUrl: string }>(
        "/api/x/link/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            wallet: owner.toBase58(),
            signature: btoa(binary),
          }),
        }
      );
      location.assign(verified.authorizationUrl);
    } catch (error) {
      console.error(error);
      toast("X linking was cancelled or could not be verified.");
      button.disabled = false;
    }
  };
}

function wireNewVaultAction(
  owner: PublicKey,
  delegate: PublicKey,
  linked: boolean
): void {
  if (!linked) return;
  $<HTMLButtonElement>("#createVaultBtn").onclick = async () => {
    const button = $<HTMLButtonElement>("#createVaultBtn");
    try {
      const maxTip = inputLamports("maxTip");
      const dailyLimit = inputLamports("dailyLimit");
      const deposit = inputLamports("initialDeposit");
      if (dailyLimit < maxTip)
        throw new Error(
          "The 24-hour limit must be at least the per-tip limit."
        );
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
      const vault = deriveSpendingVault(owner);
      const initialize = new TransactionInstruction({
        programId: DEVNET_PROGRAM_ID,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: vaultPolicyData(
          DISC.initializeVault,
          delegate,
          maxTip,
          dailyLimit,
          expiresAt
        ),
      });
      const fund = new TransactionInstruction({
        programId: DEVNET_PROGRAM_ID,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: instructionData(DISC.depositVault, u64LE(deposit)),
      });
      button.disabled = true;
      const signature = await sendIxs(
        [initialize, fund],
        owner,
        devnetConnection
      );
      toast(
        `Vault created · <a href="${solscan(
          signature,
          "devnet"
        )}" target="_blank" rel="noopener">view devnet tx</a>`
      );
      await renderXSetup(owner);
    } catch (error) {
      console.error(error);
      toast(
        error instanceof Error
          ? escapeHtml(error.message)
          : "Vault creation failed."
      );
      button.disabled = false;
    }
  };
}

function manageVaultInstruction(
  owner: PublicKey,
  data: Buffer
): TransactionInstruction {
  return new TransactionInstruction({
    programId: DEVNET_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: deriveSpendingVault(owner), isSigner: false, isWritable: true },
    ],
    data,
  });
}

function wireExistingVaultActions(
  owner: PublicKey,
  vault: SpendingVaultAccount,
  delegate: PublicKey
): void {
  const savePolicy = async (paused: boolean) => {
    const maxTip = inputLamports("maxTip");
    const dailyLimit = inputLamports("dailyLimit");
    if (dailyLimit < maxTip)
      throw new Error("The 24-hour limit must be at least the per-tip limit.");
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
    const ix = manageVaultInstruction(
      owner,
      vaultPolicyData(
        DISC.updateVault,
        delegate,
        maxTip,
        dailyLimit,
        expiresAt,
        paused
      )
    );
    const signature = await sendIx(ix, owner, devnetConnection);
    toast(
      `Vault policy updated · <a href="${solscan(
        signature,
        "devnet"
      )}" target="_blank" rel="noopener">view tx</a>`
    );
    await renderXSetup(owner);
  };

  $<HTMLButtonElement>("#savePolicyBtn").onclick = async () => {
    const button = $<HTMLButtonElement>("#savePolicyBtn");
    button.disabled = true;
    try {
      await savePolicy(vault.paused);
    } catch (error) {
      console.error(error);
      toast(
        error instanceof Error
          ? escapeHtml(error.message)
          : "Could not update limits."
      );
      button.disabled = false;
    }
  };

  $<HTMLButtonElement>("#depositVaultBtn").onclick = async () => {
    const button = $<HTMLButtonElement>("#depositVaultBtn");
    button.disabled = true;
    try {
      const amount = inputLamports("fundAmount");
      const ix = new TransactionInstruction({
        programId: DEVNET_PROGRAM_ID,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          {
            pubkey: deriveSpendingVault(owner),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: instructionData(DISC.depositVault, u64LE(amount)),
      });
      const signature = await sendIx(ix, owner, devnetConnection);
      toast(
        `Funds added · <a href="${solscan(
          signature,
          "devnet"
        )}" target="_blank" rel="noopener">view tx</a>`
      );
      await renderXSetup(owner);
    } catch (error) {
      console.error(error);
      toast(
        error instanceof Error ? escapeHtml(error.message) : "Deposit failed."
      );
      button.disabled = false;
    }
  };

  $<HTMLButtonElement>("#withdrawVaultBtn").onclick = async () => {
    const button = $<HTMLButtonElement>("#withdrawVaultBtn");
    button.disabled = true;
    try {
      const amount = inputLamports("fundAmount");
      if (amount > vault.availableLamports)
        throw new Error("That is more than the available vault budget.");
      const ix = manageVaultInstruction(
        owner,
        instructionData(DISC.withdrawVault, u64LE(amount))
      );
      const signature = await sendIx(ix, owner, devnetConnection);
      toast(
        `Funds withdrawn · <a href="${solscan(
          signature,
          "devnet"
        )}" target="_blank" rel="noopener">view tx</a>`
      );
      await renderXSetup(owner);
    } catch (error) {
      console.error(error);
      toast(
        error instanceof Error
          ? escapeHtml(error.message)
          : "Withdrawal failed."
      );
      button.disabled = false;
    }
  };

  $<HTMLButtonElement>("#pauseVaultBtn").onclick = async () => {
    const button = $<HTMLButtonElement>("#pauseVaultBtn");
    button.disabled = true;
    try {
      await savePolicy(
        false === vault.paused && !vault.delegate.equals(PublicKey.default)
      );
    } catch (error) {
      console.error(error);
      toast(
        error instanceof Error
          ? escapeHtml(error.message)
          : "Could not change vault access."
      );
      button.disabled = false;
    }
  };

  $<HTMLButtonElement>("#revokeVaultBtn").onclick = async () => {
    const button = $<HTMLButtonElement>("#revokeVaultBtn");
    button.disabled = true;
    try {
      const signature = await sendIx(
        manageVaultInstruction(owner, instructionData(DISC.revokeVault)),
        owner,
        devnetConnection
      );
      toast(
        `Bot access revoked · <a href="${solscan(
          signature,
          "devnet"
        )}" target="_blank" rel="noopener">view tx</a>`
      );
      await renderXSetup(owner);
    } catch (error) {
      console.error(error);
      toast("Could not revoke bot access.");
      button.disabled = false;
    }
  };
}
