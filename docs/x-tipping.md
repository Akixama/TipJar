# X tipping architecture

This document describes the staged, non-custodial X tipping design. It is not
live on mainnet until the expanded program has passed devnet testing and an
independent security review.

## Account model

| Account | Seeds | Purpose | Who can move its SOL |
| --- | --- | --- | --- |
| Creator jar | `["jar", creator_wallet]` | Holds tips a creator has received | Creator wallet only |
| Spending vault | `["spending_vault", owner_wallet]` | Holds SOL budgeted for automatic X tips | Owner can withdraw; configured delegate can only tip registered jars |
| Pending tip | `["pending_tip", spending_vault, x_post_id]` | Holds a tip for an unregistered recipient until claim or expiry | Verified recipient can claim; sender can recover after expiry |

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

The program now includes the pending-tip foundation for recipients who have not
registered. The backend calls `create_pending_tip` instead of `delegate_tip`.
This applies the same delegate, authorization, per-tip, daily-limit and replay
checks before moving the amount into a separate escrow PDA.

Each pending tip records the sender, originating vault, immutable numeric X
recipient ID, X post ID, amount, creation time, expiry, claim authority and
rent-refund address. Its lifetime must be greater than zero and no longer than
30 days; the backend should use seven days by default.

Claiming requires two signatures:

- the recipient wallet, which must own the destination TipJar jar; and
- the stored TipOnSol claim authority, which attests that OAuth verification
  linked that wallet to the escrow's numeric X user ID.

Solana cannot independently read X identity data. The claim authority is
therefore the trusted bridge for that one identity assertion; it has no
instruction that can withdraw a pending tip to itself. The sender alone can
refund the amount after expiry. Both claim and refund close the escrow, making
the paths mutually exclusive, and return the temporary account rent to the
delegate that funded it. Refunded tips still count toward the original rolling
daily limit because they consumed authorization when created.

## Rollout

1. Build and test locally.
2. Deploy the expanded program to devnet.
3. Exercise registered tips, limits, expiry, replay rejection, revocation and
   withdrawals.
4. Exercise pending-tip creation, claims, expiry and refunds on devnet.
5. Complete an independent security review.
6. Confirm control of the current program upgrade authority.
7. Upgrade the existing mainnet program and then enable the matching backend
   and frontend.

The existing `DataAccount` jar layout must not change during this work so jars
created by the current mainnet program remain compatible.

## Devnet deployment

The staged X-tipping program is deployed separately on devnet at
`CV75mHHfR1yKnQTowW4TmW7yNTCpk7ET8GYBeu6Wfp5P`. It uses the Cargo `devnet`
feature so the default build continues to declare the existing mainnet program
ID. The checked-in smoke test creates disposable actors and verifies a pending
tip claim plus an expired sender refund against the live devnet program.
