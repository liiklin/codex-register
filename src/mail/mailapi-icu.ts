import {appendFile, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";
import {appConfig} from "../config.js";
import {findLatestVerificationMail} from "./verification-matcher.js";

interface MailApiIcuAccount {
    email: string;
    apiUrl: string;
    orderNo: string;
    lineRaw: string;
}

interface MailApiIcuMessage {
    error?: string;
    send?: string;
    subject?: string;
    text?: string;
    html?: string;
    raw?: string;
    source?: string;
    verification_code?: string;
    date?: string;
}

const MAILAPI_ICU_DIR = path.resolve(process.cwd(), "mailapi-icu");
const MAILAPI_ICU_TOKENS_FILE = path.join(MAILAPI_ICU_DIR, "tokens.txt");
const MAILAPI_ICU_USED_FILE = path.join(MAILAPI_ICU_DIR, "used.txt");
const MAILAPI_ICU_POLL_ATTEMPTS = 36;
const MAILAPI_ICU_POLL_INTERVAL_MS = 5000;

let accountCache: MailApiIcuAccount[] | null = null;
let accountIndex = 0;
const emailAccountMap = new Map<string, MailApiIcuAccount>();

function normalizeEmail(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function buildDispatcher(): Dispatcher {
    const proxyUrl = String(appConfig.defaultProxyUrl ?? "").trim();
    return proxyUrl
        ? new ProxyAgent({
            uri: proxyUrl,
            requestTls: {rejectUnauthorized: false},
        })
        : new Agent({
            connect: {rejectUnauthorized: false},
        });
}

async function mailApiIcuFetch(input: string | URL, init: UndiciRequestInit = {}) {
    return undiciFetch(input, {
        ...init,
        dispatcher: buildDispatcher(),
    } satisfies UndiciRequestInit);
}

function parseTokenLine(line: string, index: number): MailApiIcuAccount | null {
    const separatorIndex = line.indexOf("----");
    const emailRaw = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const apiUrlRaw = separatorIndex >= 0 ? line.slice(separatorIndex + 4) : "";
    const email = normalizeEmail(emailRaw ?? "");
    const apiUrl = String(apiUrlRaw ?? "").trim();
    if (!email || !apiUrl) {
        return null;
    }

    if (!email.includes("@")) {
        throw new Error(`MailAPI.ICU 第 ${index + 1} 行邮箱格式不正确: ${emailRaw}`);
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(apiUrl);
    } catch {
        throw new Error(`MailAPI.ICU 第 ${index + 1} 行 API 地址不正确: ${apiUrl}`);
    }

    const orderNo = parsedUrl.searchParams.get("orderNo")?.trim() ?? "";
    if (!orderNo) {
        throw new Error(`MailAPI.ICU 第 ${index + 1} 行缺少 orderNo 参数: ${apiUrl}`);
    }

    return {
        email,
        apiUrl: parsedUrl.toString(),
        orderNo,
        lineRaw: line,
    };
}

async function loadAccounts(): Promise<MailApiIcuAccount[]> {
    if (accountCache) {
        return accountCache;
    }

    let raw = "";
    try {
        raw = await readFile(MAILAPI_ICU_TOKENS_FILE, "utf8");
    } catch (error) {
        const normalizedError = error as NodeJS.ErrnoException;
        if (normalizedError.code === "ENOENT") {
            throw new Error(`未找到 MailAPI.ICU 账号文件: ${MAILAPI_ICU_TOKENS_FILE}`);
        }
        throw error;
    }

    const accounts = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => parseTokenLine(line, index))
        .filter((account): account is MailApiIcuAccount => account != null);

    if (!accounts.length) {
        throw new Error(`未在文件找到可用的 MailAPI.ICU 账号: ${MAILAPI_ICU_TOKENS_FILE}`);
    }

    accountCache = accounts;
    return accounts;
}

function chooseNextAccount(accounts: MailApiIcuAccount[]): MailApiIcuAccount {
    const account = accounts[accountIndex % accounts.length];
    accountIndex = (accountIndex + 1) % accounts.length;
    return account;
}

function resolveFetchUrl(account: MailApiIcuAccount): URL {
    const url = new URL(account.apiUrl);
    url.searchParams.set("orderNo", account.orderNo);
    if (!url.searchParams.get("type")?.trim()) {
        url.searchParams.set("type", "json");
    }
    return url;
}

function resolveResponseType(account: MailApiIcuAccount): "json" | "html" {
    const url = new URL(account.apiUrl);
    const type = url.searchParams.get("type")?.trim().toLowerCase();
    return type === "html" ? "html" : "json";
}

function parseHtmlMessage(rawBody: string, account: MailApiIcuAccount): MailApiIcuMessage[] {
    const subjectMatch = rawBody.match(/<strong>主题:<\/strong>\s*([^<]+)/i);
    const dateMatch = rawBody.match(/<strong>日期:<\/strong>\s*([^<]+)/i);

    return [
        {
            send: "",
            subject: String(subjectMatch?.[1] ?? "").trim(),
            text: rawBody,
            html: rawBody,
            raw: rawBody,
            source: rawBody,
            verification_code: "",
            date: String(dateMatch?.[1] ?? "").trim() || new Date().toISOString(),
        },
    ];
}

async function fetchMessages(account: MailApiIcuAccount): Promise<MailApiIcuMessage[]> {
    const response = await mailApiIcuFetch(resolveFetchUrl(account), {
        method: "GET",
        headers: {
            Accept: "application/json,text/html,text/plain;q=0.9,*/*;q=0.8",
        },
    });

    if (response.status === 204 || response.status === 404 || response.status === 410) {
        return [];
    }

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`MailAPI.ICU 请求失败: ${response.status} body=${rawBody}`);
    }

    if (!rawBody.trim()) {
        return [];
    }

    if (resolveResponseType(account) === "html") {
        return parseHtmlMessage(rawBody, account);
    }

    let payload: unknown;
    try {
        payload = JSON.parse(rawBody) as unknown;
    } catch (error) {
        throw new Error(`MailAPI.ICU 返回 JSON 解析失败: ${(error as Error).message}; body=${rawBody}`);
    }

    if (Array.isArray(payload)) {
        const messages = payload as MailApiIcuMessage[];
        if (messages[0]?.error) {
            return [];
        }
        return messages;
    }

    if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const nestedItems = record.data ?? record.items ?? record.messages;
        if (Array.isArray(nestedItems)) {
            const messages = nestedItems as MailApiIcuMessage[];
            if (messages[0]?.error) {
                return [];
            }
            return messages;
        }
        if (typeof record.error === "string" && record.error.trim()) {
            return [];
        }
    }

    throw new Error(`MailAPI.ICU 返回格式异常: ${rawBody}`);
}

function findVerificationCodeFromMessages(account: MailApiIcuAccount, messages: MailApiIcuMessage[]) {
    return findLatestVerificationMail(
        messages.map((message) => ({
            id: `${account.orderNo}:${String(message.date ?? "")}:${String(message.subject ?? "")}`,
            sender: String(message.send ?? ""),
            recipient: account.email,
            subject: String(message.subject ?? ""),
            content: [
                String(message.verification_code ?? ""),
                String(message.text ?? ""),
            ].filter(Boolean).join("\n"),
            timestamp: Date.parse(String(message.date ?? "")) || 0,
            extraTexts: [
                String(message.html ?? ""),
                String(message.raw ?? ""),
                String(message.source ?? ""),
            ].filter(Boolean),
        })),
        {
            targetEmail: account.email,
        },
    );
}

async function resolveAccountForEmail(email: string): Promise<MailApiIcuAccount> {
    const normalizedEmail = normalizeEmail(email);
    const mapped = emailAccountMap.get(normalizedEmail);
    if (mapped) {
        return mapped;
    }

    const accounts = await loadAccounts();
    const matched = accounts.find((account) => account.email === normalizedEmail);
    if (!matched) {
        throw new Error(`MailAPI.ICU 未找到与邮箱匹配的账号: ${email}`);
    }

    emailAccountMap.set(normalizedEmail, matched);
    return matched;
}

async function removeAccountLine(account: MailApiIcuAccount): Promise<boolean> {
    const raw = await readFile(MAILAPI_ICU_TOKENS_FILE, "utf8");
    const lines = raw.split(/\r?\n/);

    let removed = false;
    const nextLines = lines.filter((line) => {
        if (removed) {
            return true;
        }
        if (line.trim() === account.lineRaw.trim()) {
            removed = true;
            return false;
        }
        return true;
    });

    if (!removed) {
        return false;
    }

    const normalizedLines = nextLines.filter((line) => line != null && line !== "");
    await writeFile(
        MAILAPI_ICU_TOKENS_FILE,
        `${normalizedLines.join("\n")}${normalizedLines.length > 0 ? "\n" : ""}`,
        "utf8",
    );

    accountCache = null;
    accountIndex = 0;
    emailAccountMap.delete(account.email);
    return true;
}

async function markAccountUsed(email: string, password: string): Promise<void> {
    const account = await resolveAccountForEmail(email);
    const removed = await removeAccountLine(account);
    if (!removed) {
        return;
    }

    const usedRecord = [
        account.email,
        account.apiUrl,
        new Date().toISOString(),
        password,
    ].join("----");
    await appendFile(MAILAPI_ICU_USED_FILE, `${usedRecord}\n`, "utf8");
}

async function discardAccount(email: string): Promise<void> {
    const account = await resolveAccountForEmail(email);
    await removeAccountLine(account);
}

export function createMailApiIcuProvider() {
    return {
        async getEmailAddress() {
            const accounts = await loadAccounts();
            const account = chooseNextAccount(accounts);
            emailAccountMap.set(account.email, account);
            return account.email;
        },
        async getEmailVerificationCode(email: string) {
            const account = await resolveAccountForEmail(email);

            for (let attempt = 1; attempt <= MAILAPI_ICU_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `pollMailApiIcuOtp: attempt=${attempt}/${MAILAPI_ICU_POLL_ATTEMPTS} targetEmail=${email} orderNo=${account.orderNo}`,
                );

                const messages = await fetchMessages(account);
                const matchedMail = findVerificationCodeFromMessages(account, messages);

                if (matchedMail?.verificationCode) {
                    console.log(`mailApiIcuOtpCode: ${matchedMail.verificationCode}`);
                    return matchedMail.verificationCode;
                }

                if (attempt < MAILAPI_ICU_POLL_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, MAILAPI_ICU_POLL_INTERVAL_MS));
                }
            }

            throw new Error(`MailAPI.ICU 中未找到验证码: targetEmail=${email}`);
        },
        async markEmailAddressUsed(email: string, password: string) {
            await markAccountUsed(email, password);
        },
        async discardEmailAddress(email: string) {
            await discardAccount(email);
        },
    };
}
