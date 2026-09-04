# 🫙 TipJar

A shareable, on-chain tip jar for Solana creators. Generate a link, drop it anywhere, and anyone can tip you SOL directly — no middleman, no custodial wallet, funds sit in a PDA only you can withdraw from.

**Live:** https://x.com/Anjolaoluw_a/status/2076020582395879869?s=20
**Demo:** https://x.com/Anjolaoluw_a/status/2076347839848862196?s=20
**Program (mainnet):** [`37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A`](https://solscan.io/account/37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A)
**Program (devnet):** [`CV75mHHfR1yKnQTowW4TmW7yNTCpk7ET8GYBeu6Wfp5P`](https://explorer.solana.com/address/CV75mHHfR1yKnQTowW4TmW7yNTCpk7ET8GYBeu6Wfp5P?cluster=devnet)

---

## How it works

Every creator gets a Program Derived Address ("jar") seeded from their wallet: `["jar", owner_pubkey]`. There's no database and no backend — the jar's balance, tip count, and owner are all read straight off the account.

- **Create your jar** — one transaction, initializes your PDA.
- **Share your link** — `tipjar.app/?owner=<your_pubkey>` renders a public tip page for anyone who opens it.
- **Get tipped** — visitors connect Phantom and send SOL straight into your jar. The jar fills visually (SVG) and a coin drops on every tip.
- **Withdraw anytime** — only the owning wallet can withdraw, and withdrawals are blocked from dropping the account below Solana's rent-exempt minimum, so the jar can never be closed out from under you accidentally.

## Why it's built this way

The frontend talks to the program with **hand-built instruction discriminators** instead of bundling the Anchor TypeScript client. That means no generated IDL client, no extra bundle weight, and no Buffer polyfill — `@solana/web3.js` is loaded straight from an import map. It's a deliberately minimal, dependency-light client for what is otherwise a very common Anchor pattern.

## Program design

The live mainnet deployment currently exposes the original three jar
instructions. This branch preserves them and adds the spending-vault
instructions that will be enabled only after devnet testing:

| Instruction | Who can call | What it does |
|---|---|---|
| `initialize` | Anyone (for their own jar) | Creates the PDA, sets owner, zeroes counters |
| `tip` | Anyone | Transfers SOL into the jar, increments `total_tipped` and `tip_count` |
| `withdraw` | Jar owner only | Pulls SOL out, enforced to never dip below rent-exempt minimum |
| `initialize_spending_vault` | Vault owner only | Creates an outgoing tip budget and its delegated policy |
| `update_spending_policy` | Vault owner only | Changes the delegate, limits, expiry or pause state |
| `deposit_to_spending_vault` | Vault owner only | Adds SOL to the outgoing tip budget |
| `withdraw_from_spending_vault` | Vault owner only | Returns available vault SOL to its owner |
| `revoke_spending_delegate` | Vault owner only | Immediately disables automated tipping |
| `delegate_tip` | Configured delegate only | Sends a policy-compliant X tip to a registered jar |
| `create_pending_tip` | Configured delegate only | Escrows a policy-compliant tip for an unregistered X user |
| `claim_pending_tip` | Recipient + claim authority | Sends a verified recipient's pending tip into their jar |
| `refund_pending_tip` | Original sender only | Recovers a pending tip after it expires |

```rust
pub struct DataAccount {
    pub user: Pubkey,       // jar owner
    pub bump: u8,
    pub total_tipped: u64,  // lifetime lamports received
    pub tip_count: u64,     // lifetime tip count
}
```

Guardrails already in place: checked arithmetic on both counters (no silent overflow), a zero-amount guard on tips and withdrawals, and an owner constraint on withdraw enforced at the account level, not just in application logic.

The new `SpendingVault` keeps its owner and delegate separate, enforces per-tip
and rolling daily limits, expires authorization, supports immediate revocation,
and rejects replayed or out-of-order X post IDs. Its SOL can be withdrawn only
to the owner wallet. Pending tips use one escrow PDA per X post, require both
the recipient wallet and the X-verification authority to claim, expire after at
most 30 days, and can then be refunded only to the original sender. The
existing `DataAccount` byte layout remains unchanged for mainnet compatibility.

## Tech stack

- **Program:** Rust, Anchor
- **Frontend:** Vanilla TypeScript (no framework), raw SVG for the jar visual
- **Wallet:** Phantom (`window.solana` provider)
- **RPC:** Helius

## Local development

```bash
# install deps
yarn install

# build the program without changing the existing mainnet program ID
cargo build-sbf --manifest-path programs/pda/Cargo.toml

# build the isolated devnet program ID
cargo build-sbf --manifest-path programs/pda/Cargo.toml --features devnet

# run policy tests
cargo test -p pda --lib

# run full local transactions against the built program in LiteSVM
cargo test -p pda --test vault_transactions

# exercise pending-tip claim and refund against the deployed devnet program
cd app
npm run smoke:devnet -- /path/to/devnet-keypair.json

# run the frontend
npm install
npm run dev
```

## Roadmap

- [ ] Tip messages / notes attached to a transaction
- [ ] Leaderboard of top tippers per jar
- [ ] Devnet deployment + toggle for testing without real SOL
- [x] Non-custodial X tipping program through owner-funded spending vaults
- [x] Expiring pending-tip escrow program for recipients who have not registered
- [ ] X OAuth account linking and command-processing backend
- [ ] Spending-vault and pending-tip frontend controls

The staged design and security invariants for X tipping are documented in
[`docs/x-tipping.md`](docs/x-tipping.md).

## License

ISC
