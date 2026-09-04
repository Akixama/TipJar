use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A");

const DAY_SECONDS: i64 = 86_400;
const MAX_PENDING_TIP_LIFETIME_SECONDS: i64 = 30 * DAY_SECONDS;

#[program]
pub mod tip_jar {
    use super::*;

    // Existing jar instructions and account layout are intentionally unchanged so
    // jars created by the currently deployed mainnet program remain readable.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let account_data = &mut ctx.accounts.pda_account;

        account_data.user = ctx.accounts.signer.key();
        account_data.bump = ctx.bumps.pda_account;
        account_data.total_tipped = 0;
        account_data.tip_count = 0;

        Ok(())
    }

    pub fn tip(ctx: Context<Tip>, amount: u64) -> Result<()> {
        require!(amount > 0, TipJarError::InvalidAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.tipper.to_account_info(),
                    to: ctx.accounts.pda_account.to_account_info(),
                },
            ),
            amount,
        )?;

        record_received_tip(&mut ctx.accounts.pda_account, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, TipJarError::InvalidAmount);

        transfer_program_lamports(
            &ctx.accounts.pda_account.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            amount,
        )
    }

    pub fn initialize_spending_vault(
        ctx: Context<InitializeSpendingVault>,
        delegate: Pubkey,
        max_tip_lamports: u64,
        daily_limit_lamports: u64,
        authorization_expires_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_policy(
            &delegate,
            max_tip_lamports,
            daily_limit_lamports,
            authorization_expires_at,
            now,
        )?;

        let vault = &mut ctx.accounts.spending_vault;
        vault.owner = ctx.accounts.owner.key();
        vault.delegate = delegate;
        vault.max_tip_lamports = max_tip_lamports;
        vault.daily_limit_lamports = daily_limit_lamports;
        vault.spent_in_window = 0;
        vault.window_started_at = now;
        vault.authorization_expires_at = authorization_expires_at;
        vault.last_processed_x_post_id = 0;
        vault.bump = ctx.bumps.spending_vault;
        vault.paused = false;

        emit!(VaultPolicyChanged {
            vault: vault.key(),
            owner: vault.owner,
            delegate,
            max_tip_lamports,
            daily_limit_lamports,
            authorization_expires_at,
            paused: false,
        });

        Ok(())
    }

    pub fn update_spending_policy(
        ctx: Context<ManageSpendingVault>,
        delegate: Pubkey,
        max_tip_lamports: u64,
        daily_limit_lamports: u64,
        authorization_expires_at: i64,
        paused: bool,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_policy(
            &delegate,
            max_tip_lamports,
            daily_limit_lamports,
            authorization_expires_at,
            now,
        )?;

        let vault = &mut ctx.accounts.spending_vault;
        vault.delegate = delegate;
        vault.max_tip_lamports = max_tip_lamports;
        vault.daily_limit_lamports = daily_limit_lamports;
        vault.authorization_expires_at = authorization_expires_at;
        vault.paused = paused;

        emit!(VaultPolicyChanged {
            vault: vault.key(),
            owner: vault.owner,
            delegate,
            max_tip_lamports,
            daily_limit_lamports,
            authorization_expires_at,
            paused,
        });

        Ok(())
    }

    pub fn deposit_to_spending_vault(
        ctx: Context<DepositToSpendingVault>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, TipJarError::InvalidAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.spending_vault.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(VaultDeposited {
            vault: ctx.accounts.spending_vault.key(),
            owner: ctx.accounts.owner.key(),
            amount,
        });

        Ok(())
    }

    pub fn withdraw_from_spending_vault(
        ctx: Context<ManageSpendingVault>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, TipJarError::InvalidAmount);

        transfer_program_lamports(
            &ctx.accounts.spending_vault.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            amount,
        )?;

        emit!(VaultWithdrawn {
            vault: ctx.accounts.spending_vault.key(),
            owner: ctx.accounts.owner.key(),
            amount,
        });

        Ok(())
    }

    pub fn revoke_spending_delegate(ctx: Context<ManageSpendingVault>) -> Result<()> {
        let vault = &mut ctx.accounts.spending_vault;
        vault.delegate = Pubkey::default();
        vault.authorization_expires_at = Clock::get()?.unix_timestamp;
        vault.paused = true;

        emit!(VaultDelegateRevoked {
            vault: vault.key(),
            owner: vault.owner,
        });

        Ok(())
    }

    /// Executes a tip that was authorized by an X post.
    ///
    /// X post IDs must arrive in ascending order for each sender vault. This gives
    /// us replay protection without creating a rent-bearing receipt account for
    /// every tip. The backend must process each sender's commands oldest-first.
    pub fn delegate_tip(ctx: Context<DelegateTip>, x_post_id: u64, amount: u64) -> Result<()> {
        require!(x_post_id > 0, TipJarError::InvalidPostId);
        require!(amount > 0, TipJarError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        let vault = &mut ctx.accounts.spending_vault;

        require_keys_eq!(
            vault.delegate,
            ctx.accounts.delegate.key(),
            TipJarError::UnauthorizedDelegate
        );
        authorize_spend(vault, x_post_id, amount, now)?;

        transfer_program_lamports(
            &vault.to_account_info(),
            &ctx.accounts.recipient_jar.to_account_info(),
            amount,
        )?;

        record_received_tip(&mut ctx.accounts.recipient_jar, amount)?;

        emit!(DelegatedTipExecuted {
            x_post_id,
            vault: vault.key(),
            recipient_jar: ctx.accounts.recipient_jar.key(),
            amount,
            executed_at: now,
        });

        Ok(())
    }

    /// Locks a policy-compliant tip for an X recipient who has not registered yet.
    pub fn create_pending_tip(
        ctx: Context<CreatePendingTip>,
        x_post_id: u64,
        recipient_x_user_id: u64,
        amount: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(x_post_id > 0, TipJarError::InvalidPostId);
        require!(recipient_x_user_id > 0, TipJarError::InvalidXUserId);
        require!(amount > 0, TipJarError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        validate_pending_tip_expiration(expires_at, now)?;

        let vault = &mut ctx.accounts.spending_vault;
        require_keys_eq!(
            vault.delegate,
            ctx.accounts.delegate.key(),
            TipJarError::UnauthorizedDelegate
        );
        authorize_spend(vault, x_post_id, amount, now)?;

        transfer_program_lamports(
            &vault.to_account_info(),
            &ctx.accounts.pending_tip.to_account_info(),
            amount,
        )?;

        let pending_tip = &mut ctx.accounts.pending_tip;
        pending_tip.sender = vault.owner;
        pending_tip.spending_vault = vault.key();
        pending_tip.claim_authority = ctx.accounts.delegate.key();
        pending_tip.rent_refund = ctx.accounts.delegate.key();
        pending_tip.recipient_x_user_id = recipient_x_user_id;
        pending_tip.x_post_id = x_post_id;
        pending_tip.amount = amount;
        pending_tip.created_at = now;
        pending_tip.expires_at = expires_at;
        pending_tip.bump = ctx.bumps.pending_tip;

        emit!(PendingTipCreated {
            pending_tip: pending_tip.key(),
            vault: vault.key(),
            sender: vault.owner,
            recipient_x_user_id,
            x_post_id,
            amount,
            created_at: now,
            expires_at,
        });

        Ok(())
    }

    /// Claims a pending tip after the backend verifies that the recipient wallet
    /// controls the X account recorded on the escrow.
    pub fn claim_pending_tip(ctx: Context<ClaimPendingTip>, x_post_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pending_tip = &ctx.accounts.pending_tip;
        require!(now < pending_tip.expires_at, TipJarError::PendingTipExpired);

        let amount = pending_tip.amount;
        let recipient_x_user_id = pending_tip.recipient_x_user_id;
        let pending_tip_key = pending_tip.key();

        transfer_program_lamports(
            &pending_tip.to_account_info(),
            &ctx.accounts.recipient_jar.to_account_info(),
            amount,
        )?;
        record_received_tip(&mut ctx.accounts.recipient_jar, amount)?;

        emit!(PendingTipClaimed {
            pending_tip: pending_tip_key,
            recipient: ctx.accounts.recipient.key(),
            recipient_jar: ctx.accounts.recipient_jar.key(),
            recipient_x_user_id,
            x_post_id,
            amount,
            claimed_at: now,
        });

        Ok(())
    }

    /// Returns an expired pending tip to its sender. The delegate-funded rent is
    /// returned separately by Anchor's account-close handling.
    pub fn refund_pending_tip(ctx: Context<RefundPendingTip>, x_post_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pending_tip = &ctx.accounts.pending_tip;
        require!(
            now >= pending_tip.expires_at,
            TipJarError::PendingTipNotExpired
        );

        let amount = pending_tip.amount;
        let pending_tip_key = pending_tip.key();
        transfer_program_lamports(
            &pending_tip.to_account_info(),
            &ctx.accounts.sender.to_account_info(),
            amount,
        )?;

        emit!(PendingTipRefunded {
            pending_tip: pending_tip_key,
            sender: ctx.accounts.sender.key(),
            x_post_id,
            amount,
            refunded_at: now,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        seeds = [b"jar", signer.key().as_ref()],
        bump,
        space = 8 + DataAccount::INIT_SPACE + 64, // reserved headroom for future fields
    )]
    pub pda_account: Account<'info, DataAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Tip<'info> {
    #[account(mut)]
    pub tipper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"jar", pda_account.user.as_ref()],
        bump = pda_account.bump,
    )]
    pub pda_account: Account<'info, DataAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"jar", owner.key().as_ref()],
        bump = pda_account.bump,
        constraint = pda_account.user == owner.key(),
    )]
    pub pda_account: Account<'info, DataAccount>,
}

#[derive(Accounts)]
pub struct InitializeSpendingVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        seeds = [b"spending_vault", owner.key().as_ref()],
        bump,
        space = 8 + SpendingVault::INIT_SPACE,
    )]
    pub spending_vault: Account<'info, SpendingVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageSpendingVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"spending_vault", owner.key().as_ref()],
        bump = spending_vault.bump,
        constraint = spending_vault.owner == owner.key() @ TipJarError::UnauthorizedOwner,
    )]
    pub spending_vault: Account<'info, SpendingVault>,
}

#[derive(Accounts)]
pub struct DepositToSpendingVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"spending_vault", owner.key().as_ref()],
        bump = spending_vault.bump,
        constraint = spending_vault.owner == owner.key() @ TipJarError::UnauthorizedOwner,
    )]
    pub spending_vault: Account<'info, SpendingVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DelegateTip<'info> {
    #[account(mut)]
    pub delegate: Signer<'info>,

    #[account(
        mut,
        seeds = [b"spending_vault", spending_vault.owner.as_ref()],
        bump = spending_vault.bump,
    )]
    pub spending_vault: Account<'info, SpendingVault>,

    #[account(
        mut,
        seeds = [b"jar", recipient_jar.user.as_ref()],
        bump = recipient_jar.bump,
    )]
    pub recipient_jar: Account<'info, DataAccount>,
}

#[derive(Accounts)]
#[instruction(x_post_id: u64)]
pub struct CreatePendingTip<'info> {
    #[account(mut)]
    pub delegate: Signer<'info>,

    #[account(
        mut,
        seeds = [b"spending_vault", spending_vault.owner.as_ref()],
        bump = spending_vault.bump,
    )]
    pub spending_vault: Account<'info, SpendingVault>,

    #[account(
        init,
        payer = delegate,
        seeds = [b"pending_tip", spending_vault.key().as_ref(), &x_post_id.to_le_bytes()],
        bump,
        space = 8 + PendingTip::INIT_SPACE,
    )]
    pub pending_tip: Account<'info, PendingTip>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(x_post_id: u64)]
pub struct ClaimPendingTip<'info> {
    pub claim_authority: Signer<'info>,

    pub recipient: Signer<'info>,

    #[account(
        mut,
        seeds = [b"jar", recipient.key().as_ref()],
        bump = recipient_jar.bump,
        constraint = recipient_jar.user == recipient.key() @ TipJarError::UnauthorizedRecipient,
    )]
    pub recipient_jar: Account<'info, DataAccount>,

    #[account(
        mut,
        close = rent_refund,
        seeds = [b"pending_tip", pending_tip.spending_vault.as_ref(), &x_post_id.to_le_bytes()],
        bump = pending_tip.bump,
        constraint = pending_tip.x_post_id == x_post_id @ TipJarError::InvalidPostId,
        constraint = pending_tip.claim_authority == claim_authority.key() @ TipJarError::UnauthorizedClaimAuthority,
    )]
    pub pending_tip: Account<'info, PendingTip>,

    /// CHECK: The address is stored in the pending tip and receives only reclaimed rent.
    #[account(
        mut,
        constraint = pending_tip.rent_refund == rent_refund.key() @ TipJarError::InvalidRentRefund,
    )]
    pub rent_refund: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(x_post_id: u64)]
pub struct RefundPendingTip<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        close = rent_refund,
        seeds = [b"pending_tip", pending_tip.spending_vault.as_ref(), &x_post_id.to_le_bytes()],
        bump = pending_tip.bump,
        constraint = pending_tip.x_post_id == x_post_id @ TipJarError::InvalidPostId,
        constraint = pending_tip.sender == sender.key() @ TipJarError::UnauthorizedOwner,
    )]
    pub pending_tip: Account<'info, PendingTip>,

    /// CHECK: The address is stored in the pending tip and receives only reclaimed rent.
    #[account(
        mut,
        constraint = pending_tip.rent_refund == rent_refund.key() @ TipJarError::InvalidRentRefund,
    )]
    pub rent_refund: UncheckedAccount<'info>,
}

/// The original mainnet jar layout. Do not reorder or change these fields.
#[account]
#[derive(InitSpace)]
pub struct DataAccount {
    pub user: Pubkey,
    pub bump: u8,
    pub total_tipped: u64,
    pub tip_count: u64,
}

#[account]
#[derive(InitSpace)]
pub struct SpendingVault {
    pub owner: Pubkey,
    pub delegate: Pubkey,
    pub max_tip_lamports: u64,
    pub daily_limit_lamports: u64,
    pub spent_in_window: u64,
    pub window_started_at: i64,
    pub authorization_expires_at: i64,
    pub last_processed_x_post_id: u64,
    pub bump: u8,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct PendingTip {
    pub sender: Pubkey,
    pub spending_vault: Pubkey,
    pub claim_authority: Pubkey,
    pub rent_refund: Pubkey,
    pub recipient_x_user_id: u64,
    pub x_post_id: u64,
    pub amount: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

#[event]
pub struct VaultPolicyChanged {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub delegate: Pubkey,
    pub max_tip_lamports: u64,
    pub daily_limit_lamports: u64,
    pub authorization_expires_at: i64,
    pub paused: bool,
}

#[event]
pub struct VaultDeposited {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultDelegateRevoked {
    pub vault: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct DelegatedTipExecuted {
    pub x_post_id: u64,
    pub vault: Pubkey,
    pub recipient_jar: Pubkey,
    pub amount: u64,
    pub executed_at: i64,
}

#[event]
pub struct PendingTipCreated {
    pub pending_tip: Pubkey,
    pub vault: Pubkey,
    pub sender: Pubkey,
    pub recipient_x_user_id: u64,
    pub x_post_id: u64,
    pub amount: u64,
    pub created_at: i64,
    pub expires_at: i64,
}

#[event]
pub struct PendingTipClaimed {
    pub pending_tip: Pubkey,
    pub recipient: Pubkey,
    pub recipient_jar: Pubkey,
    pub recipient_x_user_id: u64,
    pub x_post_id: u64,
    pub amount: u64,
    pub claimed_at: i64,
}

#[event]
pub struct PendingTipRefunded {
    pub pending_tip: Pubkey,
    pub sender: Pubkey,
    pub x_post_id: u64,
    pub amount: u64,
    pub refunded_at: i64,
}

fn validate_policy(
    delegate: &Pubkey,
    max_tip_lamports: u64,
    daily_limit_lamports: u64,
    authorization_expires_at: i64,
    now: i64,
) -> Result<()> {
    require_keys_neq!(*delegate, Pubkey::default(), TipJarError::InvalidDelegate);
    require!(max_tip_lamports > 0, TipJarError::InvalidLimit);
    require!(
        daily_limit_lamports >= max_tip_lamports,
        TipJarError::InvalidLimit
    );
    require!(
        authorization_expires_at > now,
        TipJarError::InvalidExpiration
    );

    Ok(())
}

fn refresh_spending_window(vault: &mut SpendingVault, now: i64) {
    if now.saturating_sub(vault.window_started_at) >= DAY_SECONDS {
        vault.window_started_at = now;
        vault.spent_in_window = 0;
    }
}

fn validate_pending_tip_expiration(expires_at: i64, now: i64) -> Result<()> {
    require!(expires_at > now, TipJarError::InvalidExpiration);
    let latest_expiration = now
        .checked_add(MAX_PENDING_TIP_LIFETIME_SECONDS)
        .ok_or(TipJarError::Overflow)?;
    require!(
        expires_at <= latest_expiration,
        TipJarError::PendingTipLifetimeTooLong
    );
    Ok(())
}

fn authorize_spend(vault: &mut SpendingVault, x_post_id: u64, amount: u64, now: i64) -> Result<()> {
    require!(!vault.paused, TipJarError::VaultPaused);
    require!(
        now < vault.authorization_expires_at,
        TipJarError::AuthorizationExpired
    );
    require!(
        amount <= vault.max_tip_lamports,
        TipJarError::PerTipLimitExceeded
    );
    require!(
        x_post_id > vault.last_processed_x_post_id,
        TipJarError::PostAlreadyProcessed
    );

    refresh_spending_window(vault, now);
    let new_window_total = vault
        .spent_in_window
        .checked_add(amount)
        .ok_or(TipJarError::Overflow)?;
    require!(
        new_window_total <= vault.daily_limit_lamports,
        TipJarError::DailyLimitExceeded
    );

    vault.spent_in_window = new_window_total;
    vault.last_processed_x_post_id = x_post_id;
    Ok(())
}

fn record_received_tip(jar: &mut Account<DataAccount>, amount: u64) -> Result<()> {
    jar.total_tipped = jar
        .total_tipped
        .checked_add(amount)
        .ok_or(TipJarError::Overflow)?;
    jar.tip_count = jar.tip_count.checked_add(1).ok_or(TipJarError::Overflow)?;

    Ok(())
}

fn transfer_program_lamports(
    source: &AccountInfo,
    destination: &AccountInfo,
    amount: u64,
) -> Result<()> {
    let rent_exempt_minimum = Rent::get()?.minimum_balance(source.data_len());
    let source_balance = source.lamports();
    let remaining = source_balance
        .checked_sub(amount)
        .ok_or(TipJarError::InsufficientFunds)?;

    require!(
        remaining >= rent_exempt_minimum,
        TipJarError::InsufficientFunds
    );

    let destination_balance = destination
        .lamports()
        .checked_add(amount)
        .ok_or(TipJarError::Overflow)?;

    **source.try_borrow_mut_lamports()? = remaining;
    **destination.try_borrow_mut_lamports()? = destination_balance;

    Ok(())
}

#[error_code]
pub enum TipJarError {
    #[msg("Tip amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Math overflow.")]
    Overflow,
    #[msg("Withdrawal or tip would drop the account below its rent-exempt minimum.")]
    InsufficientFunds,
    #[msg("The delegate public key is invalid.")]
    InvalidDelegate,
    #[msg("The spending limits are invalid.")]
    InvalidLimit,
    #[msg("The authorization expiration must be in the future.")]
    InvalidExpiration,
    #[msg("Only the vault owner may perform this action.")]
    UnauthorizedOwner,
    #[msg("This signer is not the vault's authorized delegate.")]
    UnauthorizedDelegate,
    #[msg("The spending vault is paused.")]
    VaultPaused,
    #[msg("The delegate authorization has expired.")]
    AuthorizationExpired,
    #[msg("The tip exceeds the vault's per-tip limit.")]
    PerTipLimitExceeded,
    #[msg("The tip exceeds the vault's rolling daily limit.")]
    DailyLimitExceeded,
    #[msg("The X post ID must be greater than zero.")]
    InvalidPostId,
    #[msg("This X post was already processed or arrived out of order.")]
    PostAlreadyProcessed,
    #[msg("The recipient X user ID must be greater than zero.")]
    InvalidXUserId,
    #[msg("A pending tip cannot remain open for longer than 30 days.")]
    PendingTipLifetimeTooLong,
    #[msg("This pending tip has expired and can no longer be claimed.")]
    PendingTipExpired,
    #[msg("This pending tip has not expired and cannot be refunded yet.")]
    PendingTipNotExpired,
    #[msg("This signer cannot verify claims for the pending tip.")]
    UnauthorizedClaimAuthority,
    #[msg("The recipient wallet does not own the destination jar.")]
    UnauthorizedRecipient,
    #[msg("The rent-refund account does not match the pending tip.")]
    InvalidRentRefund,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_vault() -> SpendingVault {
        SpendingVault {
            owner: Pubkey::new_unique(),
            delegate: Pubkey::new_unique(),
            max_tip_lamports: 50_000_000,
            daily_limit_lamports: 100_000_000,
            spent_in_window: 0,
            window_started_at: 1_000,
            authorization_expires_at: 200_000,
            last_processed_x_post_id: 0,
            bump: 255,
            paused: false,
        }
    }

    #[test]
    fn accepts_a_valid_policy() {
        let delegate = Pubkey::new_unique();
        assert!(validate_policy(&delegate, 10, 100, 2_000, 1_000).is_ok());
    }

    #[test]
    fn preserves_the_existing_mainnet_jar_layout() {
        assert_eq!(DataAccount::INIT_SPACE, 49);
    }

    #[test]
    fn rejects_invalid_policy_values() {
        assert!(validate_policy(&Pubkey::default(), 10, 100, 2_000, 1_000).is_err());
        assert!(validate_policy(&Pubkey::new_unique(), 0, 100, 2_000, 1_000).is_err());
        assert!(validate_policy(&Pubkey::new_unique(), 101, 100, 2_000, 1_000).is_err());
        assert!(validate_policy(&Pubkey::new_unique(), 10, 100, 1_000, 1_000).is_err());
    }

    #[test]
    fn accumulates_spending_inside_the_window() {
        let mut vault = active_vault();

        assert!(authorize_spend(&mut vault, 100, 40_000_000, 1_100).is_ok());
        assert!(authorize_spend(&mut vault, 101, 50_000_000, 1_200).is_ok());
        assert_eq!(vault.spent_in_window, 90_000_000);
        assert!(authorize_spend(&mut vault, 102, 20_000_000, 1_300).is_err());
    }

    #[test]
    fn resets_spending_after_a_full_day() {
        let mut vault = active_vault();
        vault.spent_in_window = vault.daily_limit_lamports;

        assert!(authorize_spend(&mut vault, 100, 25_000_000, 1_000 + DAY_SECONDS).is_ok());
        assert_eq!(vault.spent_in_window, 25_000_000);
        assert_eq!(vault.window_started_at, 1_000 + DAY_SECONDS);
    }

    #[test]
    fn rejects_paused_expired_and_oversized_tips() {
        let mut paused = active_vault();
        paused.paused = true;
        assert!(authorize_spend(&mut paused, 100, 1, 1_100).is_err());

        let mut expired = active_vault();
        let expiration = expired.authorization_expires_at;
        assert!(authorize_spend(&mut expired, 100, 1, expiration).is_err());

        let mut oversized = active_vault();
        let too_much = oversized.max_tip_lamports + 1;
        assert!(authorize_spend(&mut oversized, 100, too_much, 1_100).is_err());
    }

    #[test]
    fn rejects_replayed_and_out_of_order_posts() {
        let mut vault = active_vault();

        assert!(authorize_spend(&mut vault, 101, 1, 1_100).is_ok());
        assert!(authorize_spend(&mut vault, 101, 1, 1_101).is_err());
        assert!(authorize_spend(&mut vault, 100, 1, 1_102).is_err());
        assert!(authorize_spend(&mut vault, 102, 1, 1_103).is_ok());
    }

    #[test]
    fn validates_pending_tip_lifetime() {
        let now = 1_000;
        assert!(validate_pending_tip_expiration(now + 1, now).is_ok());
        assert!(
            validate_pending_tip_expiration(now + MAX_PENDING_TIP_LIFETIME_SECONDS, now).is_ok()
        );
        assert!(validate_pending_tip_expiration(now, now).is_err());
        assert!(
            validate_pending_tip_expiration(now + MAX_PENDING_TIP_LIFETIME_SECONDS + 1, now)
                .is_err()
        );
    }
}
