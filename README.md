# 🫙 TipJar

A shareable, on-chain tip jar for Solana creators. Generate a link, drop it anywhere, and anyone can tip you SOL directly — no middleman, no custodial wallet, funds sit in a PDA only you can withdraw from.

**Live:** [add deployed link]
**Demo:** [add 60s walkthrough video]
**Program (mainnet):** [`37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A`](https://solscan.io/account/37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A)

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

Three instructions, one account type:

| Instruction | Who can call | What it does |
|---|---|---|
| `initialize` | Anyone (for their own jar) | Creates the PDA, sets owner, zeroes counters |
| `tip` | Anyone | Transfers SOL into the jar, increments `total_tipped` and `tip_count` |
| `withdraw` | Jar owner only | Pulls SOL out, enforced to never dip below rent-exempt minimum |

```rust
pub struct DataAccount {
    pub user: Pubkey,       // jar owner
    pub bump: u8,
    pub total_tipped: u64,  // lifetime lamports received
    pub tip_count: u64,     // lifetime tip count
}
```

Guardrails already in place: checked arithmetic on both counters (no silent overflow), a zero-amount guard on tips and withdrawals, and an owner constraint on withdraw enforced at the account level, not just in application logic.

## Tech stack

- **Program:** Rust, Anchor
- **Frontend:** Vanilla TypeScript (no framework), raw SVG for the jar visual
- **Wallet:** Phantom (`window.solana` provider)
- **RPC:** Helius

## Local development

```bash
# install deps
yarn install

# build the program
anchor build

# run tests (mainnet-cluster config — point Anchor.toml at devnet/localnet first if testing changes)
anchor test

# run the frontend
cd app
npm install
npm run dev
```

## Roadmap

- [ ] Tip messages / notes attached to a transaction
- [ ] Leaderboard of top tippers per jar
- [ ] Devnet deployment + toggle for testing without real SOL

## License

ISC
