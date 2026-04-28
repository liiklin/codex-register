import {fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";

import {appConfig} from "../config.js";
import {findLatestVerificationMail} from "./verification-matcher.js";

interface FreemailMailboxResponse {
    email?: string;
}

export interface FreemailMailboxEntry {
    id?: string | number;
    address?: string;
    mailbox?: string;
    created_at?: string;
    updated_at?: string;
}

interface FreemailMailboxListEnvelope {
    list?: FreemailMailboxEntry[];
    total?: number;
}

interface FreemailMailItem {
    id?: string | number;
    mailbox?: string;
    address?: string;
    to?: string | string[];
    recipient?: string | string[];
    from?: string;
    from_address?: string;
    sender?: string;
    subject?: string;
    preview?: string;
    text?: string;
    content?: string;
    html?: string;
    html_content?: string;
    timestamp?: number;
    created_at?: string;
    received_at?: number;
}

interface FreemailProviderConfig {
    apiBaseUrl: string;
    apiToken: string;
    proxyUrl: string;
}

interface CreateFreemailProviderOptions {
    config?: Partial<FreemailProviderConfig>;
    fetchImpl?: typeof undiciFetch;
    sleep?: (ms: number) => Promise<void>;
    pollAttempts?: number;
    pollIntervalMs?: number;
}

interface CreateFreemailAdminClientOptions {
    config?: Partial<FreemailProviderConfig>;
    fetchImpl?: typeof undiciFetch;
}

const FREEMAIL_POLL_ATTEMPTS = 36;
const FREEMAIL_POLL_INTERVAL_MS = 5000;

function normalizeEmail(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeMailboxAddress(mailbox: FreemailMailboxEntry): string {
    return normalizeEmail(String(mailbox.address ?? mailbox.mailbox ?? ""));
}

function buildConfig(overrides?: Partial<FreemailProviderConfig>): FreemailProviderConfig {
    return {
        apiBaseUrl: String(overrides?.apiBaseUrl ?? appConfig.freemailApiBaseUrl ?? "").trim(),
        apiToken: String(overrides?.apiToken ?? appConfig.freemailApiToken ?? "").trim(),
        proxyUrl: String(overrides?.proxyUrl ?? appConfig.defaultProxyUrl ?? "").trim(),
    };
}

function ensureApiBaseUrlConfigured(config: FreemailProviderConfig): string {
    if (!config.apiBaseUrl) {
        throw new Error("freemailApiBaseUrl 未配置，请先在 config.json 中填写 Freemail API 地址");
    }
    return config.apiBaseUrl.replace(/\/+$/, "");
}

function ensureApiTokenConfigured(config: FreemailProviderConfig): string {
    if (!config.apiToken) {
        throw new Error("freemailApiToken 未配置，请先在 config.json 中填写 Freemail API Token");
    }
    return config.apiToken;
}

function buildDispatcher(proxyUrl: string): Dispatcher {
    return proxyUrl
        ? new ProxyAgent({
            uri: proxyUrl,
            requestTls: {rejectUnauthorized: false},
        })
        : new Agent({
            connect: {rejectUnauthorized: false},
        });
}

function buildHeaders(config: FreemailProviderConfig): Record<string, string> {
    return {
        Accept: "application/json",
        Authorization: `Bearer ${ensureApiTokenConfigured(config)}`,
    };
}

function createFreemailHttpClient(
    config: FreemailProviderConfig,
    fetchImpl: typeof undiciFetch,
) {
    async function freemailFetch(input: string | URL, init: UndiciRequestInit = {}) {
        return fetchImpl(input, {
            ...init,
            dispatcher: buildDispatcher(config.proxyUrl),
        } satisfies UndiciRequestInit);
    }

    async function requestJSON<T>(url: string | URL, init: UndiciRequestInit = {}): Promise<T> {
        const response = await freemailFetch(url, init);
        const rawBody = await response.text();
        if (!response.ok) {
            throw new Error(`Freemail 请求失败: ${response.status} body=${rawBody}`);
        }
        return JSON.parse(rawBody) as T;
    }

    return {
        freemailFetch,
        requestJSON,
    };
}

function isLikelyVerificationMail(mail: FreemailMailItem): boolean {
    const text = [mail.subject, mail.preview, mail.text, mail.content, mail.html, mail.html_content]
        .map((item) => String(item ?? "").toLowerCase())
        .join(" ");
    return text.includes("openai")
        || text.includes("chatgpt")
        || text.includes("verification")
        || text.includes("code");
}

function normalizeTimestamp(mail: FreemailMailItem): number {
    const directTimestamp = Number(mail.timestamp ?? mail.received_at ?? 0);
    if (Number.isFinite(directTimestamp) && directTimestamp > 0) {
        return directTimestamp;
    }

    const createdAt = String(mail.created_at ?? "").trim();
    if (!createdAt) {
        return 0;
    }

    const parsed = Date.parse(createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function createFreemailProvider(options: CreateFreemailProviderOptions = {}) {
    const config = buildConfig(options.config);
    const fetchImpl = options.fetchImpl ?? undiciFetch;
    const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pollAttempts = options.pollAttempts ?? FREEMAIL_POLL_ATTEMPTS;
    const pollIntervalMs = options.pollIntervalMs ?? FREEMAIL_POLL_INTERVAL_MS;

    const {freemailFetch, requestJSON} = createFreemailHttpClient(config, fetchImpl);

    async function generateMailbox(): Promise<string> {
        const url = new URL(`${ensureApiBaseUrlConfigured(config)}/api/generate`);
        url.searchParams.set("length", "20");
        const data = await requestJSON<FreemailMailboxResponse>(url, {
            method: "GET",
            headers: buildHeaders(config),
        });
        const email = normalizeEmail(String(data?.email ?? ""));
        if (!email) {
            throw new Error(`Freemail 生成邮箱返回异常: ${JSON.stringify(data)}`);
        }
        return email;
    }

    async function listEmails(email: string): Promise<FreemailMailItem[]> {
        const mailbox = normalizeEmail(email);
        if (!mailbox.includes("@")) {
            throw new Error(`邮箱格式不正确: ${email}`);
        }

        const url = new URL(`${ensureApiBaseUrlConfigured(config)}/api/emails`);
        url.searchParams.set("mailbox", mailbox);
        url.searchParams.set("limit", "10");
        const data = await requestJSON<FreemailMailItem[]>(url, {
            method: "GET",
            headers: buildHeaders(config),
        });

        if (!Array.isArray(data)) {
            throw new Error(`Freemail 邮件列表返回格式异常: ${JSON.stringify(data)}`);
        }

        return data;
    }

    async function deleteMailbox(email: string): Promise<void> {
        const mailbox = normalizeEmail(email);
        if (!mailbox) {
            return;
        }

        const url = new URL(`${ensureApiBaseUrlConfigured(config)}/api/mailboxes`);
        url.searchParams.set("address", mailbox);
        const response = await freemailFetch(url, {
            method: "DELETE",
            headers: buildHeaders(config),
        });
        if (!response.ok && response.status !== 404) {
            throw new Error(`Freemail 删除邮箱失败: ${response.status} body=${await response.text()}`);
        }
    }

    return {
        async getEmailAddress() {
            ensureApiBaseUrlConfigured(config);
            ensureApiTokenConfigured(config);
            return generateMailbox();
        },
        async getEmailVerificationCode(email: string) {
            ensureApiBaseUrlConfigured(config);
            ensureApiTokenConfigured(config);

            for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
                console.log(`pollFreemailOtp: attempt=${attempt}/${pollAttempts} targetEmail=${email}`);

                const mails = await listEmails(email);
                const candidates = mails.map((mail) => ({
                    ...mail,
                    id: String(mail.id ?? ""),
                    sender: String(mail.from ?? mail.from_address ?? mail.sender ?? ""),
                    recipient: mail.to ?? mail.recipient ?? mail.mailbox ?? mail.address ?? email,
                    subject: String(mail.subject ?? ""),
                    content: String(mail.text ?? mail.content ?? mail.preview ?? ""),
                    timestamp: normalizeTimestamp(mail),
                    extraTexts: [
                        String(mail.preview ?? ""),
                        String(mail.html ?? mail.html_content ?? ""),
                    ],
                }));
                const matchedMail = findLatestVerificationMail(candidates, {
                    targetEmail: normalizeEmail(email),
                    candidateMatcher: isLikelyVerificationMail,
                });

                if (matchedMail?.verificationCode) {
                    console.log(`freemailOtpCode: ${matchedMail.verificationCode}`);
                    return matchedMail.verificationCode;
                }

                if (attempt < pollAttempts) {
                    await sleep(pollIntervalMs);
                }
            }

            throw new Error(`Freemail 中未找到验证码: targetEmail=${email}`);
        },
        async discardEmailAddress(email: string) {
            ensureApiBaseUrlConfigured(config);
            ensureApiTokenConfigured(config);
            await deleteMailbox(email);
        },
    };
}

export function createFreemailAdminClient(options: CreateFreemailAdminClientOptions = {}) {
    const config = buildConfig(options.config);
    const fetchImpl = options.fetchImpl ?? undiciFetch;
    const {freemailFetch, requestJSON} = createFreemailHttpClient(config, fetchImpl);

    return {
        async listMailboxes(params: {limit?: number; offset?: number} = {}) {
            ensureApiBaseUrlConfigured(config);
            ensureApiTokenConfigured(config);

            const url = new URL(`${ensureApiBaseUrlConfigured(config)}/api/mailboxes`);
            if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
                url.searchParams.set("limit", String(Math.trunc(params.limit)));
            }
            if (typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset >= 0) {
                url.searchParams.set("offset", String(Math.trunc(params.offset)));
            }

            const data = await requestJSON<FreemailMailboxListEnvelope | FreemailMailboxEntry[]>(url, {
                method: "GET",
                headers: buildHeaders(config),
            });

            const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : [];
            const total = Array.isArray(data)
                ? data.length
                : (typeof data?.total === "number" && Number.isFinite(data.total) ? data.total : list.length);

            return {
                list,
                total,
            };
        },
        async deleteMailbox(address: string) {
            ensureApiBaseUrlConfigured(config);
            ensureApiTokenConfigured(config);

            const mailbox = normalizeEmail(address);
            if (!mailbox) {
                return false;
            }

            const url = new URL(`${ensureApiBaseUrlConfigured(config)}/api/mailboxes`);
            url.searchParams.set("address", mailbox);
            const response = await freemailFetch(url, {
                method: "DELETE",
                headers: buildHeaders(config),
            });
            if (response.status === 404) {
                return false;
            }
            if (!response.ok) {
                throw new Error(`Freemail 删除邮箱失败: ${response.status} body=${await response.text()}`);
            }
            return true;
        },
        normalizeMailboxAddress,
    };
}
