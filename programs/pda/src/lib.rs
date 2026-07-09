use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
 
declare_id!("37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A");
 
#[program]
pub mod tip_jar {
    use super::*;
 
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
 
        let account_data = &mut ctx.accounts.pda_account;
        account_data.total_tipped = account_data
            .total_tipped
            .checked_add(amount)
            .ok_or(TipJarError::Overflow)?;
        account_data.tip_count = account_data
            .tip_count
            .checked_add(1)
            .ok_or(TipJarError::Overflow)?;
 
        Ok(())
    }
 
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, TipJarError::InvalidAmount);
 
        let pda_info = ctx.accounts.pda_account.to_account_info();
        let rent_exempt_minimum = Rent::get()?.minimum_balance(pda_info.data_len());
        let vault_balance = pda_info.lamports();
 
        require!(
            vault_balance.saturating_sub(amount) >= rent_exempt_minimum,
            TipJarError::InsufficientFunds
        );
 
        **pda_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;
 
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
    constraint = pda_account.user == owner.key()
)]
pub pda_account: Account<'info, DataAccount>,
}
 
#[account]
#[derive(InitSpace)]
pub struct DataAccount {
    pub user: Pubkey,
    pub bump: u8,
    pub total_tipped: u64,
    pub tip_count: u64,
}
 
#[error_code]
pub enum TipJarError {
    #[msg("Tip amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Math overflow.")]
    Overflow,
    #[msg("Withdrawal would drop the jar below the rent-exempt minimum.")]
    InsufficientFunds,
}