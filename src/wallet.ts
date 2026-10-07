import fs from "node:fs";
import { Keypair } from "@solana/web3.js";

export async function loadKeypair(keypairPath: string): Promise<Keypair> {
  const raw = fs.readFileSync(keypairPath, "utf8").trim();

  if (raw.startsWith("[")) {
    const secret = Uint8Array.from(JSON.parse(raw) as number[]);
    return Keypair.fromSecretKey(secret);
  }

  const { default: bs58 } = await import("bs58");
  const secret = bs58.decode(raw);
  return Keypair.fromSecretKey(secret);
}
