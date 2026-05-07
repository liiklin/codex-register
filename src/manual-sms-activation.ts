import type {SmsActivation} from "./sms/provider.js";

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
