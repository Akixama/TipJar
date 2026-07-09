import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
const PROGRAM_ID = new PublicKey("37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A");
const connection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${"9c739f9f-5bf0-48b6-8dc6-c917fce51545"}`,
  "confirmed"
);
const DISC = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  tip: [77, 164, 35, 21, 36, 121, 213, 51],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34]
};
const $ = (sel) => document.querySelector(sel);
const app = $("#app");
const heading = $("#heading");
const modeLabel = $("#modeLabel");
const statsEl = $("#stats");
const walletBox = $("#walletBox");
const fillRect = $("#fillRect");
const coin = $("#coin");
const toastEl = $("#toast");
let toastTimer;
function toast(html, ms = 4500) {
  toastEl.innerHTML = html;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}
function short(pk) {
  const s = pk.toBase58();
  return s.slice(0, 4) + "\u2026" + s.slice(-4);
}
function u64LE(value) {
  let v = BigInt(value);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function readU64LE(bytes, offset) {
  if (bytes.length < offset + 8) {
    throw new Error(
      `Not enough bytes. Need ${offset + 8}, got ${bytes.length}`
    );
  }
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(bytes[offset + i]) << 8n * BigInt(i);
  }
  return value;
}
function ixData(disc, amountLamports) {
  if (amountLamports === void 0) return new Uint8Array(disc);
  const out = new Uint8Array(16);
  out.set(disc, 0);
  out.set(u64LE(amountLamports), 8);
  return out;
}
function toIxData(disc, amountLamports) {
  return ixData(disc, amountLamports);
}
function deriveJar(ownerPubkey) {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("jar"), ownerPubkey.toBuffer()],
    PROGRAM_ID
  );
  return { pda, bump };
}
async function fetchJar(pda) {
  const info = await connection.getAccountInfo(pda);
  if (!info) {
    return null;
  }
  const data = info.data;
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
      lamports: BigInt(info.lamports)
    };
  } catch (err) {
    console.error("Failed decoding jar account:", err);
    return null;
  }
}
function setFill(lamports) {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  const cap = Math.max(2, sol * 1.25);
  const pct = Math.max(0, Math.min(1, sol / cap));
  fillRect.style.transform = `translateY(${(1 - pct) * 176}px)`;
}
function dropCoin() {
  coin.classList.remove("drop");
  void coin.getBBox();
  coin.classList.add("drop");
}
const provider = window.solana?.isPhantom ? window.solana : null;
let connectedPubkey = null;
async function connectWallet() {
  if (!provider) {
    toast('Phantom not found \u2014 <a href="https://phantom.app" target="_blank" rel="noopener">install it</a> and reload.');
    return null;
  }
  const resp = await provider.connect();
  connectedPubkey = resp.publicKey;
  walletBox.textContent = "Connected \xB7 " + short(connectedPubkey);
  return connectedPubkey;
}
async function sendIx(ix, feePayer) {
  if (!provider) throw new Error("Wallet not connected");
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const { signature } = await provider.signAndSendTransaction(tx);
  toast("Confirming transaction\u2026", 15e3);
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}
function solscan(sig) {
  return `https://solscan.io/tx/${sig}`;
}
const params = new URLSearchParams(location.search);
const ownerParam = params.get("owner");
if (ownerParam) {
  void runTipMode(ownerParam);
} else {
  void runMineMode();
}
async function runTipMode(ownerStr) {
  modeLabel.textContent = "Tip Jar \xB7 Mainnet";
  let ownerPubkey;
  try {
    ownerPubkey = new PublicKey(ownerStr);
  } catch {
    heading.textContent = "Invalid jar link";
    return;
  }
  heading.innerHTML = `Tip <span class="addr">${short(ownerPubkey)}</span>`;
  const { pda } = deriveJar(ownerPubkey);
  async function refresh() {
    const jar = await fetchJar(pda);
    if (!jar) {
      statsEl.textContent = "This creator hasn't set up their jar yet.";
      setFill(0n);
      return null;
    }
    statsEl.innerHTML = `<b>${(Number(jar.lamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL</b> in the jar \xB7 ${jar.tipCount} tip${jar.tipCount === 1n ? "" : "s"}`;
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
  $("#connectBtn").onclick = async () => {
    const pk = await connectWallet();
    if (pk) $("#connectBtn").textContent = "Connected \xB7 " + short(pk);
  };
  $("#tipBtn").onclick = async () => {
    if (!connectedPubkey) {
      const pk = await connectWallet();
      if (!pk) return;
    }
    const solAmt = parseFloat($("#amt").value);
    if (!(solAmt > 0)) {
      toast("Enter an amount greater than 0.");
      return;
    }
    const lamports = BigInt(Math.round(solAmt * LAMPORTS_PER_SOL));
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: connectedPubkey, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: toIxData(DISC.tip, lamports)
    });
    const btn = $("#tipBtn");
    btn.disabled = true;
    try {
      const sig = await sendIx(ix, connectedPubkey);
      dropCoin();
      toast(`Tipped ${solAmt} SOL \xB7 <a href="${solscan(sig)}" target="_blank" rel="noopener">view tx</a>`);
      await refresh();
    } catch (e) {
      console.error(e);
      toast("Transaction failed \u2014 see console for details.");
    } finally {
      btn.disabled = false;
    }
  };
}
async function runMineMode() {
  modeLabel.textContent = "Tip Jar \xB7 Mainnet";
  heading.textContent = "My Jar";
  statsEl.textContent = "Connect your wallet to view your jar.";
  app.innerHTML = `<button class="btn-brass btn-wide" id="connectBtn">Connect wallet</button>`;
  $("#connectBtn").onclick = async () => {
    const pk = await connectWallet();
    if (pk) await loadMine(pk);
  };
}
async function loadMine(ownerPubkey) {
  const { pda } = deriveJar(ownerPubkey);
  const jar = await fetchJar(pda);
  const shareLink = `${location.origin}${location.pathname}?owner=${ownerPubkey.toBase58()}`;
  if (!jar) {
    statsEl.textContent = "You don't have a jar yet.";
    setFill(0n);
    app.innerHTML = `<button class="btn-brass btn-wide" id="createBtn">Create my jar</button>`;
    $("#createBtn").onclick = async () => {
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: ownerPubkey, isSigner: true, isWritable: true },
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        data: toIxData(DISC.initialize)
      });
      const btn = $("#createBtn");
      btn.disabled = true;
      try {
        const sig = await sendIx(ix, ownerPubkey);
        toast(`Jar created \xB7 <a href="${solscan(sig)}" target="_blank" rel="noopener">view tx</a>`);
        await loadMine(ownerPubkey);
      } catch (e) {
        console.error(e);
        toast("Couldn't create your jar \u2014 see console.");
        btn.disabled = false;
      }
    };
    return;
  }
  statsEl.innerHTML = `<b>${(Number(jar.lamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL</b> in the jar \xB7 ${jar.tipCount} tip${jar.tipCount === 1n ? "" : "s"}`;
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
  $("#copyBtn").onclick = async () => {
    await navigator.clipboard.writeText(shareLink);
    toast("Link copied.");
  };
  $("#withdrawBtn").onclick = async () => {
    const solAmt = parseFloat($("#wAmt").value);
    if (!(solAmt > 0)) {
      toast("Enter an amount greater than 0.");
      return;
    }
    const lamports = BigInt(Math.round(solAmt * LAMPORTS_PER_SOL));
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true }
      ],
      data: toIxData(DISC.withdraw, lamports)
    });
    const btn = $("#withdrawBtn");
    btn.disabled = true;
    try {
      const sig = await sendIx(ix, ownerPubkey);
      toast(`Withdrew ${solAmt} SOL \xB7 <a href="${solscan(sig)}" target="_blank" rel="noopener">view tx</a>`);
      await loadMine(ownerPubkey);
    } catch (e) {
      console.error(e);
      toast("Withdraw failed \u2014 check the amount doesn't dip below the rent-exempt minimum.");
    } finally {
      btn.disabled = false;
    }
  };
}
