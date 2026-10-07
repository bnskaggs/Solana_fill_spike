import fs from "node:fs";
import path from "node:path";
import type { GraduationEvent, TradeLog } from "./types";

export function runLogPath(runsDir: string, runId: string): string {
  return path.join(runsDir, `${runId}.jsonl`);
}

export function appendTradeLog(runsDir: string, runId: string, trade: TradeLog): void {
  fs.mkdirSync(runsDir, { recursive: true });
  fs.appendFileSync(runLogPath(runsDir, runId), `${JSON.stringify(trade)}\n`);
}

export function readTradeLogs(runsDir: string, runId?: string): TradeLog[] {
  if (!fs.existsSync(runsDir)) return [];

  const files = fs
    .readdirSync(runsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .filter((file) => file !== "graduations.jsonl")
    .filter((file) => !runId || file === `${runId}.jsonl`);

  const rows: TradeLog[] = [];
  for (const file of files) {
    const fullPath = path.join(runsDir, file);
    const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) rows.push(JSON.parse(line) as TradeLog);
  }

  return rows.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export function graduationLogPath(runsDir: string): string {
  return path.join(runsDir, "graduations.jsonl");
}

export function appendGraduationEvent(runsDir: string, event: GraduationEvent): void {
  fs.mkdirSync(runsDir, { recursive: true });
  const existing = readGraduationEvents(runsDir);
  if (existing.some((row) => row.pool === event.pool || row.signature === event.signature)) return;
  fs.appendFileSync(graduationLogPath(runsDir), `${JSON.stringify(event)}\n`);
}

export function readGraduationEvents(runsDir: string): GraduationEvent[] {
  const file = graduationLogPath(runsDir);
  if (!fs.existsSync(file)) return [];
  const rows = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GraduationEvent);
  return rows.sort((a, b) => b.graduatedAt.localeCompare(a.graduatedAt));
}
