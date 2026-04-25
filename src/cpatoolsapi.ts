import {appConfig} from "./config.js";
import {DEFAULT_USER_AGENT} from "./constants.js";

function normalizeBaseUrl(value: string): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function getCPAToolsAPIConfig(): {
  baseUrl: string;
  managementKey: string;
  provider: string;
  userAgent: string;
  chatgptAccountId: string;
} {
  const baseUrl = normalizeBaseUrl(appConfig.cliproxyApiBaseUrl);
  const managementKey = String(appConfig.cliproxyApiManagementKey ?? "").trim();
  if (!baseUrl) {
    throw new Error("cliproxyApiBaseUrl 未配置");
  }
  if (!managementKey) {
    throw new Error("cliproxyApiManagementKey 未配置");
  }

  return {
    baseUrl,
    managementKey,
    provider: String(appConfig.cpatoolsProvider ?? "").trim(),
    userAgent: String(appConfig.cpatoolsUserAgent ?? "").trim() || DEFAULT_USER_AGENT,
    chatgptAccountId: String(appConfig.cpatoolsChatgptAccountId ?? "").trim(),
  };
}

function createManagementHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const {managementKey} = getCPAToolsAPIConfig();
  return {
    Authorization: `Bearer ${managementKey}`,
    Accept: "application/json",
    ...extraHeaders,
  };
}

export interface CPAToolsAuthFileItem {
  name?: string;
  type?: string;
  typo?: string;
  provider?: string;
  account?: string;
  email?: string;
  auth_index?: number | string;
  disabled?: boolean;
  chatgpt_account_id?: string;
  chatgptAccountId?: string;
  account_id?: string;
  accountId?: string;
  [key: string]: unknown;
}

export function isCPAToolsCodexAuthFile(item: CPAToolsAuthFileItem, providerFilter: string): boolean {
  const type = String(item?.type ?? item?.typo ?? "").trim().toLowerCase();
  const provider = String(item?.provider ?? "").trim().toLowerCase();
  if (type !== "codex") {
    return false;
  }
  if (providerFilter && provider !== providerFilter.trim().toLowerCase()) {
    return false;
  }
  return Boolean(String(item?.name ?? "").trim());
}

export interface CPAToolsProbeResponse {
  status: number;
  body: string;
}

export function resolveCPAToolsAuthIndex(item: CPAToolsAuthFileItem): number | null {
  const raw = item.auth_index ?? item.authIndex;
  if (raw == null) {
    return null;
  }
  if (typeof raw === "string" && !raw.trim()) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function extractCPAToolsProbeResponse(payload: unknown): CPAToolsProbeResponse {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const status = Number(record.status_code ?? record.status ?? 0);
  const rawBody = record.response_body ?? record.body ?? record.response_text ?? record.raw_body;

  return {
    status: Number.isFinite(status) ? status : 0,
    body: typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? payload),
  };
}

function extractChatgptAccountId(item: CPAToolsAuthFileItem, fallback: string): string {
  return String(
    item.chatgpt_account_id ?? item.chatgptAccountId ?? item.account_id ?? item.accountId ?? fallback ?? "",
  ).trim();
}

export async function listAuthFilesFromCPATools(): Promise<CPAToolsAuthFileItem[]> {
  const {baseUrl, provider} = getCPAToolsAPIConfig();
  const response = await fetch(`${baseUrl}/v0/management/auth-files`, {
    method: "GET",
    headers: createManagementHeaders(),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`CPAtools 获取 auth 列表失败: ${response.status} body=${rawBody}`);
  }

  const payload = JSON.parse(rawBody) as {files?: Array<Record<string, unknown>>};
  const items = Array.isArray(payload?.files) ? payload.files as CPAToolsAuthFileItem[] : [];
  return items.filter((item) => isCPAToolsCodexAuthFile(item, provider));
}

export async function probeAuthFileFromCPATools(item: CPAToolsAuthFileItem): Promise<CPAToolsProbeResponse> {
  const {baseUrl, userAgent, chatgptAccountId} = getCPAToolsAPIConfig();
  const authIndex = resolveCPAToolsAuthIndex(item);
  if (authIndex == null) {
    throw new Error(`CPAtools auth 缺少有效 auth_index: ${String(item.name ?? "")}`);
  }

  const resolvedAccountId = extractChatgptAccountId(item, chatgptAccountId);
  const headers: Record<string, string> = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  };
  if (resolvedAccountId) {
    headers["Chatgpt-Account-Id"] = resolvedAccountId;
  }

  const response = await fetch(`${baseUrl}/v0/management/api-call`, {
    method: "POST",
    headers: createManagementHeaders({"Content-Type": "application/json"}),
    body: JSON.stringify({
      authIndex,
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header: headers,
    }),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`CPAtools api-call 失败: ${response.status} body=${rawBody}`);
  }

  return extractCPAToolsProbeResponse(JSON.parse(rawBody) as Record<string, unknown>);
}

export async function deleteAuthFileFromCPATools(fileName: string): Promise<void> {
  const {baseUrl} = getCPAToolsAPIConfig();
  const url = new URL(`${baseUrl}/v0/management/auth-files`);
  url.searchParams.set("name", fileName);
  const response = await fetch(url, {
    method: "DELETE",
    headers: createManagementHeaders(),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`CPAtools 删除 auth 失败: ${response.status} body=${rawBody}`);
  }
}

export async function setAuthFileDisabledStatusToCPATools(
  fileName: string,
  disabled: boolean,
): Promise<void> {
  const {baseUrl} = getCPAToolsAPIConfig();
  const response = await fetch(`${baseUrl}/v0/management/auth-files/status`, {
    method: "PATCH",
    headers: createManagementHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({
      name: fileName,
      disabled,
    }),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`CPAtools 更新 auth 状态失败: ${response.status} body=${rawBody}`);
  }
}
