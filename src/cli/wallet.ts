import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { config } from "../config";
import { loadKeypair } from "../wallet";
import { arg } from "./args";

/**
 * Wallet helper. Never prints the secret key.
 *
 *   npm run wallet -- new      create a fresh keypair at KEYPAIR_PATH (refuses to overwrite)
 *   npm run wallet -- show     print the public address and, if RPC_URL is set, the SOL balance
 *   npm run wallet -- close    close empty token accounts and recover rent
 */
async function main() {
  const command = process.argv[2];
  const keypairPath = path.resolve(arg("path", config.keypairPath ?? "../solana-fill-spike-wallet.json")!);

  if (command === "new") {
    if (fs.existsSync(keypairPath)) {
      throw new Error(`Refusing to overwrite existing wallet at ${keypairPath}`);
    }
    const repoRoot = process.cwd();
    if (keypairPath.startsWith(repoRoot + path.sep)) {
      const rel = path.relative(repoRoot, keypairPath);
      const gitignored = /\.keypair\.json$|\.secret\.json$/.test(rel) || rel.startsWith("wallets" + path.sep);
      if (!gitignored) {
        throw new Error(`Wallet path ${rel} is inside the repo and not gitignored. Put it outside the repo.`);
      }
    }
    const keypair = Keypair.generate();
    fs.mkdirSync(path.dirname(keypairPath), { recursive: true });
    fs.writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
    console.log(`wallet written: ${keypairPath}`);
    console.log(`public address: ${keypair.publicKey.toBase58()}`);
    console.log("Fund this address with the capped spike bankroll only. Never share the file.");
    return;
  }

  if (command === "show") {
    const keypair = await loadKeypair(keypairPath);
    console.log(`public address: ${keypair.publicKey.toBase58()}`);
    if (!config.rpcUrl) {
      console.log("RPC_URL not set; skipping balance check.");
      return;
    }
    const connection = new Connection(config.rpcUrl, "confirmed");
    const lamports = await connection.getBalance(keypair.publicKey);
    console.log(`balance: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    return;
  }

  if (command === "close") {
    const runtime = config.rpcUrl;
    if (!runtime) throw new Error("RPC_URL is required for wallet close");
    const keypair = await loadKeypair(keypairPath);
    const connection = new Connection(runtime, "confirmed");
    const { createCloseAccountInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } =
      await import("@solana/spl-token");
    const emptyAccounts = await findEmptyTokenAccounts(connection, keypair.publicKey, [
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    ]);
    if (!emptyAccounts.length) {
      console.log("No empty token accounts to close.");
      return;
    }

    let closed = 0;
    for (let i = 0; i < emptyAccounts.length; i += 8) {
      const batch = emptyAccounts.slice(i, i + 8);
      const tx = new Transaction();
      for (const account of batch) {
        tx.add(
          createCloseAccountInstruction(
            account.address,
            keypair.publicKey,
            keypair.publicKey,
            [],
            account.programId,
          ),
        );
      }
      const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
      closed += batch.length;
      console.log(`closed ${batch.length} empty token account(s): ${sig}`);
    }
    console.log(`closed ${closed} total empty token account(s)`);
    return;
  }

  throw new Error("Usage: npm run wallet -- new|show|close [--path=<file>]");
}

async function findEmptyTokenAccounts(
  connection: Connection,
  owner: PublicKey,
  programIds: PublicKey[],
): Promise<Array<{ address: PublicKey; programId: PublicKey }>> {
  const out: Array<{ address: PublicKey; programId: PublicKey }> = [];
  for (const programId of programIds) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const account of accounts.value) {
      const amount = account.account.data.parsed.info.tokenAmount.amount;
      if (amount === "0") out.push({ address: account.pubkey, programId });
    }
  }
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
