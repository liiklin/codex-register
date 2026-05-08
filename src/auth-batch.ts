import {readFile} from "node:fs/promises";
import path from "node:path";

const REG_ACCOUNTS_FILE_NAME = "reg_accounts.txt";

export interface AuthBatchEntry {
  email: string;
  lineRaw: string;
}

export interface AuthBatchSummary {
  total: number;
  successCount: number;
  failCount: number;
}

export interface RunAuthBatchDeps {
  providerName: string;
  runAuthForEmail: (entry: AuthBatchEntry) => Promise<void>;
  cwd?: string;
  log?: (message: string) => void;
  error?: (message: string, error: unknown) => void;
}

export function resolveAuthBatchFilePath(providerName: string, cwd = process.cwd()): string {
  return path.resolve(cwd, providerName, REG_ACCOUNTS_FILE_NAME);
}

export async function loadAuthBatchEntries(providerName: string, cwd = process.cwd()): Promise<AuthBatchEntry[]> {
  const filePath = resolveAuthBatchFilePath(providerName, cwd);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const normalizedError = error as NodeJS.ErrnoException;
    if (normalizedError.code === "ENOENT") {
      throw new Error(`未找到批量授权邮箱文件: ${filePath}`);
    }
    throw error;
  }

  const seen = new Set<string>();
  const entries = raw
    .split(/\r?\n/)
    .map((line) => parseAuthBatchEntryLine(line))
    .filter((entry): entry is AuthBatchEntry => entry != null)
    .filter((entry) => {
      const normalized = entry.email.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });

  if (!entries.length) {
    throw new Error(`批量授权邮箱文件为空: ${filePath}`);
  }

  return entries;
}

export async function loadAuthBatchEmails(providerName: string, cwd = process.cwd()): Promise<string[]> {
  const entries = await loadAuthBatchEntries(providerName, cwd);
  return entries.map((entry) => entry.email);
}

export async function findAuthBatchEntryByEmail(
  providerName: string,
  email: string,
  cwd = process.cwd(),
): Promise<AuthBatchEntry | null> {
  const normalizedTarget = email.trim().toLowerCase();
  if (!normalizedTarget) {
    return null;
  }

  const entries = await loadAuthBatchEntries(providerName, cwd);
  return entries.find((entry) => entry.email.trim().toLowerCase() === normalizedTarget) ?? null;
}

function parseAuthBatchEntryLine(line: string): AuthBatchEntry | null {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return null;
  }

  const email = trimmedLine.includes("----")
    ? trimmedLine.slice(0, trimmedLine.indexOf("----")).trim()
    : trimmedLine;

  const resolvedEmail = email.includes("@") ? email : trimmedLine;
  return {
    email: resolvedEmail,
    lineRaw: trimmedLine,
  };
}

export async function runAuthBatchWithDeps(deps: RunAuthBatchDeps): Promise<AuthBatchSummary> {
  const entries = await loadAuthBatchEntries(deps.providerName, deps.cwd);
  const log = deps.log ?? console.log;
  const error = deps.error ?? ((message: string, reason: unknown) => console.error(message, reason));

  let successCount = 0;
  let failCount = 0;

  log(`准备批量授权：${entries.length} 个邮箱，provider=${deps.providerName}`);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    log(`[${index + 1}/${entries.length}] 开始授权 ${entry.email}`);
    try {
      await deps.runAuthForEmail(entry);
      successCount += 1;
    } catch (reason) {
      failCount += 1;
      error(`[❌️授权失败] 邮箱：${entry.email}`, reason);
    }
  }

  log(`批量授权结束: 总数=${entries.length} 成功=${successCount} 失败=${failCount}`);

  return {
    total: entries.length,
    successCount,
    failCount,
  };
}
