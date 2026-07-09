import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TipJar } from "../target/types/tip_jar";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

describe("pda", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TipJar as Program<TipJar>;
  const user = provider.wallet;

  before(async () => {
    const user_balance = user.publicKey.toBase58()
    console.log(user_balance)
    const balance = await provider.connection.getBalance(user.publicKey)
    console.log("Balance Before signing PDA: ", balance / LAMPORTS_PER_SOL, "SOL") 
  })

  const [PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("jar"), user.publicKey.toBuffer()],
    program.programId
  );

 it("Run the PDA and initialize", async () => {
  const tx = await program.methods
    .initialize()
    .accounts({
      signer: user.publicKey,
      dataAccount: PDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Transaction Signature:", tx);

  const balanceAfter = await provider.connection.getBalance(user.publicKey);
  console.log("Balance After creating PDA:", balanceAfter / LAMPORTS_PER_SOL, "SOL");
});


 it("Fetch Account", async () => {
    const pdaAccount = await program.account.dataAccount.fetch(PDA);
    console.log(JSON.stringify(pdaAccount, null, 2));
  });
});