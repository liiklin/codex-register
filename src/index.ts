import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {discardEmailAddress, markEmailAddressUsed} from "./mailbox.js";
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

async function runOnce(): Promise<void> {
    const email = readArgValue("--email").trim();
    const manualOtp = hasFlag("--otp");
    const directSignupAuth = hasFlag("--sign");
    const shouldRecycleGeneratedMailApiAccount = appConfig.provider === "mailapi-icu" && !email;
    const deviceProfile = generateRandomDeviceProfile();
    if (directSignupAuth) {
        const client = new OpenAIClient({
            email: email || undefined,
            password: appConfig.defaultPassword,
            deviceProfile,
            manualMode: manualOtp,
            signupScreenHint: "signup",
            smsBroker
        });
        let result;
        try {
            result = await client.authRegisterAndAuthorizeHTTP();
        } catch (error) {
            if (shouldRecycleGeneratedMailApiAccount && client.email && isUserAlreadyExistsError(error)) {
                await discardEmailAddress(client.email);
            }
            throw error;
        }
        if (shouldRecycleGeneratedMailApiAccount && client.email) {
            await markEmailAddressUsed(client.email, appConfig.defaultPassword);
        }
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
        if (shouldRecycleGeneratedMailApiAccount && registerClient.email && isUserAlreadyExistsError(error)) {
            await discardEmailAddress(registerClient.email);
        }
        throw error;
    }

    const loginClient = new OpenAIClient({
        email: registerClient.email,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker
    });
    const result = await loginClient.authLoginHTTP();
    if (shouldRecycleGeneratedMailApiAccount && loginClient.email) {
        await markEmailAddressUsed(loginClient.email, appConfig.defaultPassword);
    }
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
            const deviceProfile = generateRandomDeviceProfile();
            const client = new OpenAIClient({
                email: manualEmail,
                password: appConfig.defaultPassword,
                deviceProfile,
                manualMode: manualOtp,
                smsBroker,
            });
            const result = await client.authLoginHTTP();
            console.log(
                `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
            );
        } catch (error) {
            console.error(`[❌️授权失败]`, error);
        }
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
