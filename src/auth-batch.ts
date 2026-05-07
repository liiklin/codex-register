import {readFile} from "node:fs/promises";
import path from "node:path";

const REG_ACCOUNTS_FILE_NAME = "reg_accounts.txt";

export interface AuthBatchSummary {
  total: number;
  successCount: number;
  failCount: number;
}

export interface RunAuthBatchDeps {
  providerName: string;
  runAuthForEmail: (email: string) => Promise<void>;
  cwd?: string;
  log?: (message: string) => void;
  error?: (message: string, error: unknown) => void;
}

export function resolveAuthBatchFilePath(providerName: string, cwd = process.cwd()): string {
  return path.resolve(cwd, providerName, REG_ACCOUNTS_FILE_NAME);
}

export async function loadAuthBatchEmails(providerName: string, cwd = process.cwd()): Promise<string[]> {
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
  const emails = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((email) => {
      const normalized = email.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });

  if (!emails.length) {
    throw new Error(`批量授权邮箱文件为空: ${filePath}`);
  }

  return emails;
}

export async function runAuthBatchWithDeps(deps: RunAuthBatchDeps): Promise<AuthBatchSummary> {
  const emails = await loadAuthBatchEmails(deps.providerName, deps.cwd);
  const log = deps.log ?? console.log;
  const error = deps.error ?? ((message: string, reason: unknown) => console.error(message, reason));

  let successCount = 0;
  let failCount = 0;

  log(`准备批量授权：${emails.length} 个邮箱，provider=${deps.providerName}`);

  for (let index = 0; index < emails.length; index += 1) {
    const email = emails[index];
    log(`[${index + 1}/${emails.length}] 开始授权 ${email}`);
    try {
      await deps.runAuthForEmail(email);
      successCount += 1;
    } catch (reason) {
      failCount += 1;
      error(`[❌️授权失败] 邮箱：${email}`, reason);
    }
  }

  log(`批量授权结束: 总数=${emails.length} 成功=${successCount} 失败=${failCount}`);

  return {
    total: emails.length,
    successCount,
    failCount,
  };
}
