import {
  Agent,
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";
import type {
  SmsActivation,
  SmsProvider,
  SmsVerificationCode,
} from "./provider.js";

const SMS_BOWER_DEFAULT_BASE_URL =
  "https://smsbower.page/stubs/handler_api.php";
const SMS_BOWER_DEFAULT_POLL_ATTEMPTS = 24;
const SMS_BOWER_DEFAULT_POLL_INTERVAL_MS = 5000;
const SMS_BOWER_DEFAULT_NETWORK_RETRY_COUNT = 2;
const SMS_BOWER_DEFAULT_NETWORK_RETRY_DELAY_MS = 500;
const SMS_BOWER_NUMBER_ACQUIRE_RETRY_COUNT = 2;
const SMS_BOWER_NUMBER_ACQUIRE_RETRY_DELAY_MS = 1500;
const SMS_BOWER_CODE_PATTERN = /(?<!\d)(\d{4,8})(?!\d)/;

export type SmsBowerActivationStatusCode = 1 | 3 | 6 | 8;

export interface SmsBowerProviderConfig {
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  dynamicBasePrice?: number;
  dynamicMaxPrice?: number;
  dynamicPriceStep?: number;
  defaultRequestOptions?: SmsBowerNumberRequestOptions;
  defaultWaitForCodeOptions?: SmsBowerWaitForCodeOptions;
}

export interface SmsBowerNumberRequestOptions {
  service: string;
  country: number;
  operator?: string;
  maxPrice?: number;
}

export interface SmsBowerActivation extends SmsActivation {
  activationId: string;
  phoneNumber: string;
  activationCost?: number;
  countryCode?: number;
}

export interface SmsBowerVerificationCode extends SmsVerificationCode {
  code: string;
  source: "sms" | "status";
  text?: string;
  rawStatus: unknown;
}

export interface SmsBowerWaitForCodeOptions {
  markReady?: boolean;
  completeOnCode?: boolean;
  pollAttempts?: number;
  pollIntervalMs?: number;
}

export interface SmsBowerAcquireAndWaitOptions
  extends SmsBowerWaitForCodeOptions {
  cancelOnError?: boolean;
}

export class SmsBowerApiError extends Error {
  readonly action: string;
  readonly httpStatus?: number;
  readonly payload: unknown;

  constructor(
    action: string,
    message: string,
    options: { httpStatus?: number; payload?: unknown } = {},
  ) {
    super(message);
    this.name = "SmsBowerApiError";
    this.action = action;
    this.httpStatus = options.httpStatus;
    this.payload = options.payload;
  }
}

export class SmsBowerWaitTimeoutError extends Error {
  readonly activationId: string;
  readonly lastStatus: unknown;

  constructor(activationId: string, lastStatus: unknown) {
    super(
      `SmsBower 长时间未收到验证码: activationId=${activationId} lastStatus=${String(lastStatus)}`,
    );
    this.name = "SmsBowerWaitTimeoutError";
    this.activationId = activationId;
    this.lastStatus = lastStatus;
  }
}

export class SmsBowerMaxPriceExhaustedError extends Error {
  readonly basePrice: number;
  readonly maxPrice: number;
  readonly step: number;

  constructor(options: { basePrice: number; maxPrice: number; step: number }) {
    super(
      `SmsBower 已达到最大报价仍无可用号码: basePrice=${options.basePrice.toFixed(2)} maxPrice=${options.maxPrice.toFixed(2)} step=${options.step.toFixed(2)}`,
    );
    this.name = "SmsBowerMaxPriceExhaustedError";
    this.basePrice = options.basePrice;
    this.maxPrice = options.maxPrice;
    this.step = options.step;
  }
}

function isRetryableSmsBowerNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause = (error as Error & { cause?: unknown }).cause as
    | { code?: unknown; message?: unknown }
    | undefined;
  const code = String(cause?.code ?? "").trim().toUpperCase();
  const message = String(error.message ?? "").toLowerCase();
  const causeMessage = String(cause?.message ?? "").toLowerCase();

  return (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code) ||
    message.includes("fetch failed") ||
    causeMessage.includes("client network socket disconnected") ||
    causeMessage.includes("secure tls connection") ||
    causeMessage.includes("socket hang up")
  );
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  const retries =
    options.retries ?? SMS_BOWER_DEFAULT_NETWORK_RETRY_COUNT;
  const delayMs =
    options.delayMs ?? SMS_BOWER_DEFAULT_NETWORK_RETRY_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableSmsBowerNetworkError(error) || attempt === retries) {
        throw error;
      }
      console.log(
        `[smsBower] 网络抖动，准备第 ${attempt + 2}/${retries + 1} 次请求重试: ${String(error instanceof Error ? error.message : error)}`,
      );
      await delay(delayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("SmsBower 网络请求失败");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDispatcher(config: SmsBowerProviderConfig): Dispatcher {
  const proxyUrl = String(config.proxyUrl ?? "").trim();
  return proxyUrl
    ? new ProxyAgent({
      uri: proxyUrl,
      requestTls: { rejectUnauthorized: false },
    })
    : new Agent({
      connect: { rejectUnauthorized: false },
    });
}

async function smsBowerFetch(
  config: SmsBowerProviderConfig,
  input: string | URL,
  init: UndiciRequestInit = {},
) {
  return undiciFetch(input, {
    ...init,
    dispatcher: buildDispatcher(config),
  } satisfies UndiciRequestInit);
}

function ensureApiKeyConfigured(config: SmsBowerProviderConfig): string {
  const apiKey = String(config.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("SmsBower apiKey 未配置");
  }
  return apiKey;
}

function ensureDefaultRequestOptionsConfigured(
  config: SmsBowerProviderConfig,
): SmsBowerNumberRequestOptions {
  if (!config.defaultRequestOptions) {
    throw new Error(
      "SmsBower defaultRequestOptions 未配置，无法通过通用 SmsProvider 接口申请 activation",
    );
  }
  return config.defaultRequestOptions;
}

function normalizeBaseUrl(config: SmsBowerProviderConfig): string {
  const baseUrl = String(
    config.baseUrl ?? SMS_BOWER_DEFAULT_BASE_URL,
  ).trim();
  if (!baseUrl) {
    throw new Error("SmsBower baseUrl 未配置");
  }
  return baseUrl;
}

function setOptionalQuery(
  searchParams: URLSearchParams,
  key: string,
  value: unknown,
) {
  if (value == null) {
    return;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return;
  }
  searchParams.set(key, normalized);
}

function isFailureString(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("ACCESS_") || normalized.startsWith("STATUS_")) {
    return false;
  }
  return (
    normalized.startsWith("BAD_") ||
    normalized.startsWith("NO_") ||
    normalized.startsWith("WRONG_") ||
    normalized.startsWith("ERROR_") ||
    normalized === "EARLY_CANCEL_DENIED"
  );
}

function createApiError(
  action: string,
  payload: string,
  httpStatus?: number,
): SmsBowerApiError {
  return new SmsBowerApiError(action, `SmsBower ${action} 请求失败: ${payload}`, {
    httpStatus,
    payload,
  });
}

async function requestSmsBowerApi(
  config: SmsBowerProviderConfig,
  action: string,
  query: Record<string, unknown> = {},
): Promise<string> {
  const url = new URL(normalizeBaseUrl(config));
  url.searchParams.set("api_key", ensureApiKeyConfigured(config));
  url.searchParams.set("action", action);

  for (const [key, value] of Object.entries(query)) {
    setOptionalQuery(url.searchParams, key, value);
  }

  const response = await withTransientRetry(() =>
    smsBowerFetch(config, url, {
      method: "GET",
      headers: {
        Accept: "text/plain, */*;q=0.8",
      },
    }),
  );

  const text = (await response.text()).trim();

  if (!response.ok) {
    throw createApiError(action, text || `HTTP ${response.status}`, response.status);
  }

  if (isFailureString(text)) {
    throw createApiError(action, text, response.status);
  }

  return text;
}

function ensureServiceConfigured(
  options: SmsBowerNumberRequestOptions,
): string {
  const service = String(options.service ?? "").trim();
  if (!service) {
    throw new Error("SmsBower service 未配置");
  }
  return service;
}

function ensureCountryConfigured(
  options: SmsBowerNumberRequestOptions,
): number {
  const country = Number(options.country);
  if (!Number.isFinite(country)) {
    throw new Error("SmsBower country 未配置或格式不正确");
  }
  return country;
}

function normalizeActivationId(activationId: string | number): string {
  const normalized = String(activationId ?? "").trim();
  if (!normalized) {
    throw new Error("SmsBower activationId 不能为空");
  }
  return normalized;
}

function normalizePrice(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.round(parsed * 1e5) / 1e5;
}

function resolveDynamicBasePrice(config: SmsBowerProviderConfig): number {
  return normalizePrice(
    config.dynamicBasePrice ?? config.defaultRequestOptions?.maxPrice,
    0,
  );
}

function resolveDynamicMaxPrice(
  config: SmsBowerProviderConfig,
  basePrice: number,
): number {
  return Math.max(
    basePrice,
    normalizePrice(config.dynamicMaxPrice ?? basePrice, basePrice),
  );
}

function resolveDynamicPriceStep(config: SmsBowerProviderConfig): number {
  return normalizePrice(config.dynamicPriceStep, 0);
}

function buildNoNumbersAtMaxPriceError(
  config: SmsBowerProviderConfig,
): SmsBowerMaxPriceExhaustedError {
  const basePrice = resolveDynamicBasePrice(config);
  const maxPrice = resolveDynamicMaxPrice(config, basePrice);
  const step = resolveDynamicPriceStep(config);
  return new SmsBowerMaxPriceExhaustedError({ basePrice, maxPrice, step });
}

function parseActivationResponse(
  text: string,
): SmsBowerActivation {
  // Format: ACCESS_NUMBER:activationId:phoneNumber
  const parts = text.split(":");
  if (parts.length < 3) {
    throw new Error(
      `SmsBower getNumber 返回格式异常: ${text}`,
    );
  }

  const activationId = parts[1]?.trim() ?? "";
  const phoneNumber = parts.slice(2).join(":").trim();

  if (!activationId || !phoneNumber) {
    throw new Error(
      `SmsBower getNumber 返回缺少 activationId 或 phoneNumber: ${text}`,
    );
  }

  return {
    activationId,
    phoneNumber,
  };
}

function extractCodeFromText(text?: string): string | undefined {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  const matched = normalized.match(SMS_BOWER_CODE_PATTERN);
  return matched?.[1];
}

function extractCodeFromStatusResponse(
  status: string,
): SmsBowerVerificationCode | null {
  if (status.startsWith("STATUS_OK:")) {
    const codeText = status.slice("STATUS_OK:".length).trim();
    const code = extractCodeFromText(codeText) ?? codeText;
    if (!code) {
      return null;
    }
    return {
      code,
      source: "status",
      text: codeText,
      rawStatus: status,
    };
  }
  return null;
}

function resolvePollAttempts(
  config: SmsBowerProviderConfig,
  options?: SmsBowerWaitForCodeOptions,
): number {
  const attempts =
    options?.pollAttempts ??
    config.pollAttempts ??
    SMS_BOWER_DEFAULT_POLL_ATTEMPTS;
  return attempts > 0 ? Math.floor(attempts) : SMS_BOWER_DEFAULT_POLL_ATTEMPTS;
}

function resolvePollIntervalMs(
  config: SmsBowerProviderConfig,
  options?: SmsBowerWaitForCodeOptions,
): number {
  const intervalMs =
    options?.pollIntervalMs ??
    config.pollIntervalMs ??
    SMS_BOWER_DEFAULT_POLL_INTERVAL_MS;
  return intervalMs > 0
    ? Math.floor(intervalMs)
    : SMS_BOWER_DEFAULT_POLL_INTERVAL_MS;
}

export function createSmsBowerProvider(config: SmsBowerProviderConfig) {
  ensureApiKeyConfigured(config);
  const dynamicBasePrice = resolveDynamicBasePrice(config);
  const dynamicMaxPrice = resolveDynamicMaxPrice(config, dynamicBasePrice);
  const dynamicPriceStep = resolveDynamicPriceStep(config);
  let currentDynamicMaxPrice = dynamicBasePrice;

  function applyDynamicPrice(
    options: SmsBowerNumberRequestOptions,
  ): SmsBowerNumberRequestOptions {
    if (options.maxPrice == null) {
      return options;
    }
    return {
      ...options,
      maxPrice: currentDynamicMaxPrice,
    };
  }

  function canRaiseDynamicPrice(): boolean {
    return (
      dynamicPriceStep > 0 && currentDynamicMaxPrice + 0.000001 < dynamicMaxPrice
    );
  }

  function raiseDynamicPrice(): boolean {
    if (!canRaiseDynamicPrice()) {
      return false;
    }
    const previousPrice = currentDynamicMaxPrice;
    currentDynamicMaxPrice = Math.min(
      dynamicMaxPrice,
      Math.round((currentDynamicMaxPrice + dynamicPriceStep) * 1e5) / 1e5,
    );
    console.log(
      `[smsBower] NO_NUMBERS，动态上调 maxPrice: ${previousPrice.toFixed(2)} -> ${currentDynamicMaxPrice.toFixed(2)}`,
    );
    return true;
  }

  function resetDynamicPriceOnSuccess(): void {
    if (currentDynamicMaxPrice === dynamicBasePrice) {
      return;
    }
    console.log(
      `[smsBower] 成功拿到号码，动态报价回落: ${currentDynamicMaxPrice.toFixed(2)} -> ${dynamicBasePrice.toFixed(2)}`,
    );
    currentDynamicMaxPrice = dynamicBasePrice;
  }

  async function requestPhoneNumberForCountry(
    options: SmsBowerNumberRequestOptions,
  ): Promise<SmsBowerActivation> {
    const payload = await requestSmsBowerApi(config, "getNumber", {
      service: ensureServiceConfigured(options),
      country: ensureCountryConfigured(options),
      maxPrice: options.maxPrice,
      operator: options.operator,
    });

    return parseActivationResponse(payload);
  }

  const provider: SmsProvider<
    SmsBowerActivation,
    SmsBowerVerificationCode
  > & {
    requestPhoneNumber(
      options: SmsBowerNumberRequestOptions,
    ): Promise<SmsBowerActivation>;
    markActivationReady(
      activationId: string | number,
    ): Promise<string>;
    requestAnotherSms(activationId: string | number): Promise<string>;
    completeActivation(activationId: string | number): Promise<string>;
    cancelAndWithdraw(activationId: string | number): Promise<string>;
    cancelActivation(activationId: string | number): Promise<string>;
    waitForVerificationCode(
      activationId: string | number,
      options?: SmsBowerWaitForCodeOptions,
    ): Promise<SmsBowerVerificationCode>;
  } = {
    async requestActivation(): Promise<SmsBowerActivation> {
      return provider.requestPhoneNumber(
        ensureDefaultRequestOptionsConfigured(config),
      );
    },

    async requestPhoneNumber(
      options: SmsBowerNumberRequestOptions,
    ): Promise<SmsBowerActivation> {
      let lastError: unknown = null;
      let acquisitionRetryCount = 0;

      while (true) {
        const requestOptions = applyDynamicPrice(options);

        try {
          const activation = await requestPhoneNumberForCountry(
            requestOptions,
          );
          resetDynamicPriceOnSuccess();
          return activation;
        } catch (error) {
          lastError = error;
          if (isRetryableSmsBowerNetworkError(error)) {
            if (
              acquisitionRetryCount < SMS_BOWER_NUMBER_ACQUIRE_RETRY_COUNT
            ) {
              acquisitionRetryCount += 1;
              console.log(
                `[smsBower] 申请号码网络失败，准备第 ${acquisitionRetryCount + 1}/${SMS_BOWER_NUMBER_ACQUIRE_RETRY_COUNT + 1} 次整体重试: ${String(error instanceof Error ? error.message : error)}`,
              );
              await delay(SMS_BOWER_NUMBER_ACQUIRE_RETRY_DELAY_MS);
              continue;
            }
            throw error;
          }
          if (
            !(error instanceof SmsBowerApiError) ||
            !isNoNumbersError(error)
          ) {
            throw error;
          }
          acquisitionRetryCount = 0;
        }

        if (!raiseDynamicPrice()) {
          if (isNoNumbersError(lastError)) {
            throw buildNoNumbersAtMaxPriceError(config);
          }
          throw lastError instanceof Error
            ? lastError
            : new Error("SmsBower 请求号码失败");
        }
      }
    },

    async markActivationReady(
      activationId: string | number,
    ): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 1,
      });
      return payload;
    },

    async requestAnotherSms(
      activationId: string | number,
    ): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 3,
      });
      return payload;
    },

    async completeActivation(
      activationId: string | number,
    ): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 6,
      });
      return payload;
    },

    async cancelAndWithdraw(
      activationId: string | number,
    ): Promise<string> {
      const payload = await requestSmsBowerApi(config, "setStatus", {
        id: normalizeActivationId(activationId),
        status: 8,
      });
      return payload;
    },

    async cancelActivation(
      activationId: string | number,
    ): Promise<string> {
      return provider.cancelAndWithdraw(activationId);
    },

    async waitForVerificationCode(
      activationId: string | number,
      options: SmsBowerWaitForCodeOptions = {},
    ): Promise<SmsBowerVerificationCode> {
      const normalizedActivationId = normalizeActivationId(activationId);
      const waitOptions = {
        ...config.defaultWaitForCodeOptions,
        ...options,
      };
      const shouldMarkReady = waitOptions.markReady ?? false;
      const shouldCompleteOnCode = waitOptions.completeOnCode ?? false;
      const pollAttempts = resolvePollAttempts(config, waitOptions);
      const pollIntervalMs = resolvePollIntervalMs(config, waitOptions);
      let lastStatus: string | null = null;

      if (shouldMarkReady) {
        await provider.markActivationReady(normalizedActivationId);
      }

      for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
        console.log(
          `[smsBower:poll] ${normalizedActivationId} attempt:${attempt}/${pollAttempts}`,
        );

        const status = await requestSmsBowerApi(config, "getStatus", {
          id: normalizedActivationId,
        });
        lastStatus = status;

        console.log(
          `[smsBower:poll] ${normalizedActivationId} status: ${status}`,
        );

        // STATUS_OK:CODE - verification code received
        const codeFromStatus = extractCodeFromStatusResponse(status);
        if (codeFromStatus) {
          if (shouldCompleteOnCode) {
            await provider.completeActivation(normalizedActivationId);
          }
          return codeFromStatus;
        }

        // STATUS_CANCEL - activation was cancelled
        if (status === "STATUS_CANCEL") {
          throw new Error(
            `SmsBower 激活已取消: activationId=${normalizedActivationId}`,
          );
        }

        // STATUS_WAIT_CODE - still waiting for SMS
        // STATUS_WAIT_RETRY - can request another SMS
        // Any other STATUS_WAIT_* - keep waiting

        if (attempt < pollAttempts) {
          await delay(pollIntervalMs);
        }
      }

      throw new SmsBowerWaitTimeoutError(normalizedActivationId, lastStatus);
    },
  };

  return provider;
}

function isNoNumbersError(error: unknown): boolean {
  if (!(error instanceof SmsBowerApiError)) {
    return false;
  }
  if (error.action !== "getNumber") {
    return false;
  }
  return String(error.payload ?? "").trim().toUpperCase() === "NO_NUMBERS";
}
