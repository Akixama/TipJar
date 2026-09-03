# X tipping architecture

This document describes the staged, non-custodial X tipping design. It is not
live on mainnet until the expanded program has passed devnet testing and an
independent security review.

## Account model

| Account | Seeds | Purpose | Who can move its SOL |
| --- | --- | --- | --- |
| Creator jar | `["jar", creator_wallet]` | Holds tips a creator has received | Creator wallet only |
| Spending vault | `["spending_vault", owner_wallet]` | Holds SOL budgeted for automatic X tips | Owner can withdraw; configured delegate can only tip registered jars |
| Pending tip (phase 2) | Separate PDA per pending X tip | Holds a tip for an unregistered recipient until claim or expiry | Verified recipient can claim; sender can recover after expiry |

Received earnings and the owner's outgoing tip budget remain separate. A bot
cannot invoke either jar withdrawal or spending-vault withdrawal because both
require the owner's wallet signature.

## Phase 1: registered recipients

The owner signs once to create a spending vault and chooses:

- the delegate bot public key;
- a maximum amount per tip;
- a rolling 24-hour spending limit; and
- an authorization expiry time.

The owner can later change the policy, pause it, revoke the delegate, deposit
more SOL, or withdraw available SOL. Each policy change is an on-chain
transaction signed by the owner.

For a command such as `@TipOnSol send @bob 0.05 SOL`, the backend must verify
the X command, resolve both parties by immutable X user ID, and submit the
`delegate_tip` instruction. The program then independently enforces:

1. the configured delegate signed the transaction;
2. the vault is active and unexpired;
3. the amount is within the per-tip limit;
4. total spending remains within the rolling daily limit;
5. the X post ID is newer than the last processed post for this vault; and
6. the destination is a valid TipJar jar PDA.

The backend must process each sender's commands oldest-first because X post IDs
are used as an increasing replay guard. This avoids creating a rent-bearing
receipt account for every successful tip. The transaction event remains the
on-chain audit record.

If the recipient is not registered during phase 1, no transaction is submitted
and no SOL leaves the sender's vault.

## Phase 2: pending tips

Pending tips should be introduced only after the registered-recipient flow is
stable. Each pending tip must use a separate escrow PDA and include the sender,
recipient's immutable X user ID commitment, amount, X post ID, creation time,
and expiry. Claiming requires a wallet ownership signature plus verified X
account linkage. After expiry, only the sender can recover the funds.

Claim and refund must close the escrow PDA so its rent is reclaimed, and the two
paths must be mutually exclusive.

## Rollout

1. Build and test locally.
2. Deploy the expanded program to devnet.
3. Exercise registered tips, limits, expiry, replay rejection, revocation and
   withdrawals.
4. Add and test pending-tip claim/refund behavior.
5. Complete an independent security review.
6. Confirm control of the current program upgrade authority.
7. Upgrade the existing mainnet program and then enable the matching backend
   and frontend.

The existing `DataAccount` jar layout must not change during this work so jars
created by the current mainnet program remain compatible.
