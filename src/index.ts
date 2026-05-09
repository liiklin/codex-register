import {appConfig} from "./config.js";
import {findAuthBatchEntryByEmail, type AuthBatchEntry, runAuthBatchWithDeps} from "./auth-batch.js";
import {listNormalizedAuthEmailsFromCLIProxyAPI, shouldAutoUploadAuthToCLIProxyAPI} from "./cliproxyapi.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {discardEmailAddress, markEmailAddressUsed, registerEmailAccountBinding} from "./mailbox.js";
import {finalizeManualSmsLeaseIfProvided, readManualSmsActivationArgs} from "./manual-sms-activation.js";
import {OpenAIClient} from "./openai.js";
import {HeroSmsMaxPriceExhaustedError} from "./sms/heroSMS.js";
import {createSMSBroker} from "./sms/index.js";

function readArgValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) {
        return "";
    }
    return process.argv[index + 1] ?? "";
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

function readNumberArg(flag: string): number | null {
    const raw = readArgValue(flag).trim();
    if (!raw) {
        return null;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function collectErrorTexts(error: unknown, seen = new Set<unknown>()): string[] {
    if (error == null || seen.has(error)) {
        return [];
    }

    seen.add(error);

    if (typeof error === "string") {
        return [error];
    }

    if (Array.isArray(error)) {
        return error.flatMap((item) => collectErrorTexts(item, seen));
    }

    if (error && typeof error === "object" && !(error instanceof Error)) {
        const record = error as Record<string, unknown>;
        const candidateKeys = ["code", "errorCode", "type", "message"];
        const directValues = candidateKeys.flatMap((key) => collectErrorTexts(record[key], seen));
        const nestedErrorValues = record.error && typeof record.error === "object"
            ? candidateKeys.flatMap((key) => collectErrorTexts((record.error as Record<string, unknown>)[key], seen))
            : [];
        return [...directValues, ...nestedErrorValues].filter(Boolean);
    }

    if (error instanceof Error) {
        const enumerableSource = Object.assign<Record<string, unknown>, Error>({}, error);
        const candidateKeys = ["code", "errorCode", "type", "message", "body", "details", "response"];
        const directValues = candidateKeys.flatMap((key) => collectErrorTexts(enumerableSource[key], seen));

        return [
            error.message,
            ...directValues,
            ...(error.cause ? collectErrorTexts(error.cause, seen) : []),
        ].filter(Boolean);
    }

    return [];
}


const smsBroker = appConfig.heroSMSApiKey ? createSMSBroker({
    apiKey: appConfig.heroSMSApiKey,
    pollAttempts: appConfig.heroSMSPollAttempts,
    pollIntervalMs: appConfig.heroSMSPollIntervalMs,
    basePrice: appConfig.heroSMSBasePrice,
    maxPrice: appConfig.heroSMSMaxPrice,
    priceStep: appConfig.heroSMSPriceStep,
    country: appConfig.heroSMSCountry,
}) : undefined

function isUserAlreadyExistsError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) => /(?:^|\W)(?:code=)?user_already_exists(?:$|\W)/i.test(text));
}

function isMailApiIcuAuthFailedError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) => text.includes("MailAPI.ICU 请求失败: 401") || text.includes("邮箱认证失败"));
}

async function createManualSmsLeaseIfProvided() {
    const manualSmsActivation = readManualSmsActivationArgs(process.argv);
    if (!manualSmsActivation) {
        return undefined;
    }

    if (!smsBroker?.useExistingActivation) {
        throw new Error("使用 --sms-activation-id 和 --sms-phone 时必须已配置可用的 HeroSMS broker");
    }

    return await smsBroker.useExistingActivation(manualSmsActivation);
}

function ensureManualSmsActivationNotUsedWithAuthBatch(): void {
    if (readManualSmsActivationArgs(process.argv)) {
        throw new Error("--auth-batch 暂不支持 --sms-activation-id 和 --sms-phone");
    }
}

async function runAuthForEmail(email: string, manualOtp: boolean): Promise<void> {
    const preAcquiredPhoneLease = await createManualSmsLeaseIfProvided();
    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({
        email,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker,
        preAcquiredPhoneLease,
    });
    try {
        const result = await client.authLoginHTTP();
        await finalizeManualSmsLeaseIfProvided(client, smsBroker, preAcquiredPhoneLease);
        console.log(
            `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
        );
    } catch (error) {
        await finalizeManualSmsLeaseIfProvided(client, smsBroker, preAcquiredPhoneLease);
        throw error;
    }
}

async function prepareAuthEntryContext(entry: AuthBatchEntry | null): Promise<void> {
    if (!entry) {
        return;
    }

    registerEmailAccountBinding({
        email: entry.email,
        lineRaw: entry.lineRaw,
    });
}

async function prepareSingleAuthContext(email: string): Promise<void> {
    const matchedEntry = await findAuthBatchEntryByEmail(appConfig.provider, email)
        .catch(() => null);
    await prepareAuthEntryContext(matchedEntry);
}

async function runAuthForBatchEntry(entry: AuthBatchEntry, manualOtp: boolean): Promise<void> {
    await prepareAuthEntryContext(entry);
    await runAuthForEmail(entry.email, manualOtp);
}

async function createRemoteAuthExistsCheckerIfNeeded(): Promise<((entry: AuthBatchEntry) => Promise<boolean>) | undefined> {
    if (!shouldAutoUploadAuthToCLIProxyAPI()) {
        return undefined;
    }

    const existingEmails = await listNormalizedAuthEmailsFromCLIProxyAPI();
    return async (entry: AuthBatchEntry) => existingEmails.has(entry.email.trim().toLowerCase());
}

async function runOnce(): Promise<void> {
    const email = readArgValue("--email").trim();
    const manualOtp = hasFlag("--otp");
    const directSignupAuth = hasFlag("--sign");
    const shouldRecycleGeneratedMailApiAccount = appConfig.provider === "mailapi-icu" && !email;
    const deviceProfile = generateRandomDeviceProfile();
    if (directSignupAuth) {
        const preAcquiredPhoneLease = await createManualSmsLeaseIfProvided();
        const client = new OpenAIClient({
            email: email || undefined,
            password: appConfig.defaultPassword,
            deviceProfile,
            manualMode: manualOtp,
            signupScreenHint: "signup",
            smsBroker,
            preAcquiredPhoneLease,
        });
        let result;
        try {
            result = await client.authRegisterAndAuthorizeHTTP();
        } catch (error) {
            await finalizeManualSmsLeaseIfProvided(client, smsBroker, preAcquiredPhoneLease);
            if (shouldRecycleGeneratedMailApiAccount && client.email) {
                if (isUserAlreadyExistsError(error) || isMailApiIcuAuthFailedError(error)) {
                    await discardEmailAddress(client.email);
                }
            }
            throw error;
        }
        if (shouldRecycleGeneratedMailApiAccount && client.email) {
            await markEmailAddressUsed(client.email, appConfig.defaultPassword);
        }
        await finalizeManualSmsLeaseIfProvided(client, smsBroker, preAcquiredPhoneLease);
        console.log(
            `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
        );
        return;
    }

    const registerClient = new OpenAIClient({
        email: email || undefined,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker
    });
    try {
        await registerClient.authRegisterHTTP();
    } catch (error) {
        if (shouldRecycleGeneratedMailApiAccount && registerClient.email) {
            if (isUserAlreadyExistsError(error) || isMailApiIcuAuthFailedError(error)) {
                await discardEmailAddress(registerClient.email);
            }
        }
        throw error;
    }

    const preAcquiredPhoneLease = await createManualSmsLeaseIfProvided();
    const loginClient = new OpenAIClient({
        email: registerClient.email,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker,
        preAcquiredPhoneLease,
    });
    let result;
    try {
        result = await loginClient.authLoginHTTP();
    } catch (error) {
        await finalizeManualSmsLeaseIfProvided(loginClient, smsBroker, preAcquiredPhoneLease);
        if (shouldRecycleGeneratedMailApiAccount && loginClient.email) {
            if (isMailApiIcuAuthFailedError(error)) {
                await discardEmailAddress(loginClient.email);
            }
        }
        throw error;
    }
    if (shouldRecycleGeneratedMailApiAccount && loginClient.email) {
        await markEmailAddressUsed(loginClient.email, appConfig.defaultPassword);
    }
    await finalizeManualSmsLeaseIfProvided(loginClient, smsBroker, preAcquiredPhoneLease);
    console.log(
        `[✅️授权成功] 邮箱：${loginClient.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
    );
}

async function main() {
    let round = 0;
    let successCount = 0;
    let failCount = 0;
    const manualEmail = readArgValue("--email").trim();
    const authOnly = hasFlag("--auth");
    const manualOtp = hasFlag("--otp");
    const maxRounds = readNumberArg("--n");

    if (authOnly) {
        if (!manualEmail) {
            throw new Error("使用 --auth 时必须同时指定 --email");
        }
        try {
            await prepareSingleAuthContext(manualEmail);
            await runAuthForEmail(manualEmail, manualOtp);
        } catch (error) {
            console.error(`[❌️授权失败]`, error);
        }
        return;
    }

    const authBatch = hasFlag("--auth-batch");
    if (authBatch) {
        if (manualEmail || authOnly || hasFlag("--sign")) {
            throw new Error("--auth-batch 不能与 --email、--auth 或 --sign 同时使用");
        }

        ensureManualSmsActivationNotUsedWithAuthBatch();
        const isAlreadyAuthorized = await createRemoteAuthExistsCheckerIfNeeded();
        await runAuthBatchWithDeps({
            providerName: appConfig.provider,
            isAlreadyAuthorized,
            runAuthForEmail: async (entry) => {
                await runAuthForBatchEntry(entry, manualOtp);
            },
        });
        return;
    }

    if (manualEmail) {
        try {
            await runOnce();
        } catch (error) {
            console.error(`[❌️授权失败]`, error);
        }
        return;
    }

    while (!maxRounds || round < maxRounds) {
        round += 1;
        console.log(
            `第 ${round} 轮开始: 成功=${successCount} 失败=${failCount} 模式=自动`,
        );
        try {
            await runOnce();
            successCount += 1;
        } catch (error) {
            failCount += 1;
            console.error(`[❌️授权失败]`, error);
            if (error instanceof HeroSmsMaxPriceExhaustedError) {
                console.log(`[停止] HeroSMS 已达到最大报价仍无号码，结束自动循环`);
                break;
            }
        }

        if (appConfig.loopDelayMs > 0) {
            console.log(`[延迟] 轮次间等待 ${appConfig.loopDelayMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, appConfig.loopDelayMs));
        }
    }

    console.log(
        `自动模式结束: 已执行=${round} 成功=${successCount} 失败=${failCount}`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
