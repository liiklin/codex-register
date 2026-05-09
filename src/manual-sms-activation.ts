import type {SmsActivation} from "./sms/provider.js";

export interface ManualSmsLeaseCleanupClient {
  didUsePreAcquiredPhoneLease(): boolean;
}

export interface ManualSmsLeaseCleanupBroker {
  completeCurrentActivationIfMatches?(activationId: string): Promise<boolean>;
  completeCurrentActivation?(): Promise<string>;
  discardCurrentActivation?(): void | Promise<void>;
}

export function readManualSmsActivationArgs(argv: string[]): SmsActivation | null {
  const activationId = readArgValue(argv, "--sms-activation-id").trim();
  const rawPhone = readArgValue(argv, "--sms-phone").trim();

  if (!activationId && !rawPhone) {
    return null;
  }

  if (!activationId || !rawPhone) {
    throw new Error("使用 --sms-activation-id 或 --sms-phone 时必须同时提供这两个参数");
  }

  const phoneNumber = normalizePhoneNumber(rawPhone);
  if (!phoneNumber) {
    throw new Error("--sms-phone 格式不正确，必须提供有效手机号");
  }

  return {
    activationId,
    phoneNumber,
  };
}

export async function finalizeManualSmsLeaseIfProvided(
  client: ManualSmsLeaseCleanupClient,
  broker: ManualSmsLeaseCleanupBroker | undefined,
  manualLease: SmsActivation | null | undefined,
): Promise<void> {
  if (!manualLease) {
    return;
  }

  if (client.didUsePreAcquiredPhoneLease()) {
    try {
      const completed = await broker?.completeCurrentActivationIfMatches?.(String(manualLease.activationId));
      if (completed === false) {
        return;
      }
      if (completed == null) {
        await broker?.completeCurrentActivation?.();
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes("当前没有可用 activation")) {
        return;
      }
      console.warn(`[manual-sms] 清理已使用的手动 activation 失败: ${text}`);
    }
    return;
  }

  try {
    await broker?.discardCurrentActivation?.();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.warn(`[manual-sms] 丢弃未使用的手动 activation 失败: ${text}`);
  }
}

function readArgValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return "";
  }
  return argv[index + 1] ?? "";
}

function normalizePhoneNumber(value: string): string {
  const normalized = value.replace(/^[+\s]+/, "").replace(/[\s-]+/g, "").trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}
