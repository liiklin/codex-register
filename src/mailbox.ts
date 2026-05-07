import {appConfig, type MailProviderName} from "./config.js";
import {create2925Provider} from "./mail/2925.js";
import {createCloudflareProvider} from "./mail/cloudflare.js";
import {createFreemailProvider} from "./mail/freemail.js";
import {createGmailProvider} from "./mail/gmail.js";
import {createGPTMailProvider} from "./mail/gptmail.js";
import {createHotmailProvider} from "./mail/hotmail.js";
import {createMailApiIcuProvider, registerMailApiIcuAccountBinding} from "./mail/mailapi-icu.js";
import {createProxiedMailProvider} from "./mail/proxiedmail.js";

export interface EmailCodeProvider {
  getEmailAddress(): Promise<string>;
  getEmailVerificationCode(email: string): Promise<string>;
  markEmailAddressUsed?(email: string, password: string): Promise<void>;
  discardEmailAddress?(email: string): Promise<void>;
}

export interface EmailAccountBinding {
  email: string;
  lineRaw: string;
}

export const MAILBOX_CONFIG: {
  provider: MailProviderName;
} = {
  provider: appConfig.provider,
};

function createProvider(): EmailCodeProvider {
  switch (MAILBOX_CONFIG.provider) {
    case "proxiedmail":
      return createProxiedMailProvider();
    case "gmail":
      return createGmailProvider();
    case "gptmail":
      return createGPTMailProvider();
    case "freemail":
      return createFreemailProvider();
    case "hotmail":
      return createHotmailProvider();
    case "mailapi-icu":
      return createMailApiIcuProvider();
    case "2925":
      return create2925Provider();
    case "cloudflare":
      return createCloudflareProvider();
    default:
      throw new Error(`不支持的邮箱 provider: ${MAILBOX_CONFIG.provider}`);
  }
}

const provider = createProvider();

export async function getEmailAddress(): Promise<string> {
  return provider.getEmailAddress();
}

export async function getEmailVerificationCode(email: string): Promise<string> {
  return provider.getEmailVerificationCode(email);
}

export async function markEmailAddressUsed(email: string, password: string): Promise<void> {
  await provider.markEmailAddressUsed?.(email, password);
}

export async function discardEmailAddress(email: string): Promise<void> {
  await provider.discardEmailAddress?.(email);
}

export function registerEmailAccountBinding(binding: EmailAccountBinding): void {
  switch (MAILBOX_CONFIG.provider) {
    case "mailapi-icu":
      registerMailApiIcuAccountBinding(binding);
      return;
    default:
      return;
  }
}
