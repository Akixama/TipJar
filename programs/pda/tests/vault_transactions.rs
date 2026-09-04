use {
    litesvm::LiteSVM,
    solana_address::Address,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_transaction::Transaction,
    std::{path::PathBuf, str::FromStr},
};

const PROGRAM_ID: &str = "37irAnJvqTH3tSzKf5xcj1fQsYwn8GQ4bpXdP8wnHT7A";
const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

const INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
const INITIALIZE_SPENDING_VAULT: [u8; 8] = [215, 245, 163, 148, 85, 71, 161, 77];
const DEPOSIT_TO_SPENDING_VAULT: [u8; 8] = [54, 207, 133, 139, 127, 166, 188, 0];
const DELEGATE_TIP: [u8; 8] = [184, 159, 59, 118, 92, 158, 67, 119];
const REVOKE_SPENDING_DELEGATE: [u8; 8] = [81, 78, 80, 13, 127, 157, 203, 124];
const WITHDRAW_FROM_SPENDING_VAULT: [u8; 8] = [60, 50, 96, 26, 194, 124, 89, 168];
const WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];

fn program_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("target/deploy/pda.so")
}

fn address(value: &str) -> Address {
    Address::from_str(value).unwrap()
}

fn instruction_data(discriminator: [u8; 8], fields: &[&[u8]]) -> Vec<u8> {
    let mut data = discriminator.to_vec();
    for field in fields {
        data.extend_from_slice(field);
    }
    data
}

fn send_instruction(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
) -> litesvm::types::TransactionResult {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &blockhash);
    let transaction = Transaction::new(&[payer], message, blockhash);
    svm.send_transaction(transaction)
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[test]
fn complete_registered_recipient_vault_flow() {
    let program_id = address(PROGRAM_ID);
    let system_program_id = address(SYSTEM_PROGRAM_ID);
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id, program_binary())
        .expect("build the program with cargo build-sbf before running this test");

    let owner = Keypair::new();
    let recipient = Keypair::new();
    let delegate = Keypair::new();
    let attacker = Keypair::new();
    for key in [&owner, &recipient, &delegate, &attacker] {
        svm.airdrop(&key.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();
    }

    let (recipient_jar, _) =
        Address::find_program_address(&[b"jar", recipient.pubkey().as_ref()], &program_id);
    let (spending_vault, _) =
        Address::find_program_address(&[b"spending_vault", owner.pubkey().as_ref()], &program_id);

    let initialize_jar = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(recipient.pubkey(), true),
            AccountMeta::new(recipient_jar, false),
            AccountMeta::new_readonly(system_program_id, false),
        ],
        data: instruction_data(INITIALIZE, &[]),
    };
    send_instruction(&mut svm, &recipient, initialize_jar).unwrap();

    let max_tip = 50_000_000_u64;
    let daily_limit = 80_000_000_u64;
    let expires_at = i64::MAX;
    let initialize_vault = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(spending_vault, false),
            AccountMeta::new_readonly(system_program_id, false),
        ],
        data: instruction_data(
            INITIALIZE_SPENDING_VAULT,
            &[
                delegate.pubkey().as_ref(),
                &max_tip.to_le_bytes(),
                &daily_limit.to_le_bytes(),
                &expires_at.to_le_bytes(),
            ],
        ),
    };
    send_instruction(&mut svm, &owner, initialize_vault).unwrap();

    let deposit = 500_000_000_u64;
    let deposit_instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(spending_vault, false),
            AccountMeta::new_readonly(system_program_id, false),
        ],
        data: instruction_data(DEPOSIT_TO_SPENDING_VAULT, &[&deposit.to_le_bytes()]),
    };
    send_instruction(&mut svm, &owner, deposit_instruction).unwrap();

    let jar_before = svm.get_account(&recipient_jar).unwrap().lamports;
    let vault_before = svm.get_account(&spending_vault).unwrap().lamports;
    let first_post = 100_u64;
    let first_tip = 50_000_000_u64;
    let delegated_tip = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(delegate.pubkey(), true),
            AccountMeta::new(spending_vault, false),
            AccountMeta::new(recipient_jar, false),
        ],
        data: instruction_data(
            DELEGATE_TIP,
            &[&first_post.to_le_bytes(), &first_tip.to_le_bytes()],
        ),
    };
    send_instruction(&mut svm, &delegate, delegated_tip.clone()).unwrap();

    let jar_after = svm.get_account(&recipient_jar).unwrap();
    let vault_after = svm.get_account(&spending_vault).unwrap();
    assert_eq!(jar_after.lamports, jar_before + first_tip);
    assert_eq!(vault_after.lamports, vault_before - first_tip);
    assert_eq!(read_u64(&jar_after.data, 41), first_tip);
    assert_eq!(read_u64(&jar_after.data, 49), 1);
    assert_eq!(read_u64(&vault_after.data, 88), first_tip);
    assert_eq!(read_u64(&vault_after.data, 112), first_post);

    let replay_vault_balance = vault_after.lamports;
    assert!(send_instruction(&mut svm, &delegate, delegated_tip).is_err());
    assert_eq!(
        svm.get_account(&spending_vault).unwrap().lamports,
        replay_vault_balance
    );

    let excessive_tip = 50_000_001_u64;
    let excessive_instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(delegate.pubkey(), true),
            AccountMeta::new(spending_vault, false),
            AccountMeta::new(recipient_jar, false),
        ],
        data: instruction_data(
            DELEGATE_TIP,
            &[&101_u64.to_le_bytes(), &excessive_tip.to_le_bytes()],
        ),
    };
    assert!(send_instruction(&mut svm, &delegate, excessive_instruction).is_err());

    let daily_overflow_tip = 40_000_000_u64;
    let daily_overflow_instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(delegate.pubkey(), true),
            AccountMeta::new(spending_vault, false),
            AccountMeta::new(recipient_jar, false),
        ],
        data: instruction_data(
            DELEGATE_TIP,
            &[&102_u64.to_le_bytes(), &daily_overflow_tip.to_le_bytes()],
        ),
    };
    assert!(send_instruction(&mut svm, &delegate, daily_overflow_instruction).is_err());

    let unauthorized_instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(attacker.pubkey(), true),
            AccountMeta::new(spending_vault, false),
            AccountMeta::new(recipient_jar, false),
        ],
        data: instruction_data(
            DELEGATE_TIP,
            &[&103_u64.to_le_bytes(), &1_u64.to_le_bytes()],
        ),
    };
    assert!(send_instruction(&mut svm, &attacker, unauthorized_instruction).is_err());

    let revoke_instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(spending_vault, false),
        ],
        data: instruction_data(REVOKE_SPENDING_DELEGATE, &[]),
    };
    send_instruction(&mut svm, &owner, revoke_instruction).unwrap();
    assert_eq!(svm.get_account(&spending_vault).unwrap().data[121], 1);

    let revoked_tip = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(delegate.pubkey(), true),
            AccountMeta::new(spending_vault, false),
            AccountMeta::new(recipient_jar, false),
        ],
        data: instruction_data(
            DELEGATE_TIP,
            &[&104_u64.to_le_bytes(), &1_u64.to_le_bytes()],
        ),
    };
    assert!(send_instruction(&mut svm, &delegate, revoked_tip).is_err());

    let vault_withdrawal = 100_000_000_u64;
    let balance_before_withdrawal = svm.get_account(&spending_vault).unwrap().lamports;
    let withdraw_vault = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(spending_vault, false),
        ],
        data: instruction_data(
            WITHDRAW_FROM_SPENDING_VAULT,
            &[&vault_withdrawal.to_le_bytes()],
        ),
    };
    send_instruction(&mut svm, &owner, withdraw_vault).unwrap();
    assert_eq!(
        svm.get_account(&spending_vault).unwrap().lamports,
        balance_before_withdrawal - vault_withdrawal
    );

    let jar_withdrawal = 10_000_000_u64;
    let jar_before_withdrawal = svm.get_account(&recipient_jar).unwrap().lamports;
    let withdraw_jar = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(recipient.pubkey(), true),
            AccountMeta::new(recipient_jar, false),
        ],
        data: instruction_data(WITHDRAW, &[&jar_withdrawal.to_le_bytes()]),
    };
    send_instruction(&mut svm, &recipient, withdraw_jar).unwrap();
    assert_eq!(
        svm.get_account(&recipient_jar).unwrap().lamports,
        jar_before_withdrawal - jar_withdrawal
    );
}
