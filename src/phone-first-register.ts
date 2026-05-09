import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {discardEmailAddress, markEmailAddressUsed} from "./mailbox.js";
import {OpenAIClient} from "./openai.js";
import {ActivationLease, ISMSActivationBroker} from "./sms/activation-broker.js";
import {HeroSmsMaxPriceExhaustedError} from "./sms/heroSMS.js";
import {createSMSBroker} from "./sms/index.js";

interface SMSBrokerConfigOverride {
    apiKey?: string;
    pollAttempts?: number;
    pollIntervalMs?: number;
    basePrice?: number;
    maxPrice?: number;
    priceStep?: number;
    country?: number;
}

export interface PhoneFirstAttemptResult {
    status: "success" | "no_number" | "retry";
}

export interface RegisterAttemptOutcome {
    phoneWasUsed: boolean;
}

export interface RunPhoneFirstLoopOptions {
    maxRounds: number | null;
    loopDelayMs: number;
    acquirePhoneThenRegister: (context: {round: number}) => Promise<PhoneFirstAttemptResult>;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
}

export interface AcquirePhoneThenRegisterDeps {
    getLease: () => Promise<ActivationLease>;
    register: (lease: ActivationLease) => Promise<RegisterAttemptOutcome>;
    markAsFailed: (rotate?: boolean) => Promise<void>;
    discardCurrentActivation?: () => void | Promise<void>;
}

export interface PhoneFirstFlowClient {
    email: string;
    authRegisterHTTP(): Promise<unknown>;
    authLoginHTTP(): Promise<{authFile?: string}>;
    didUsePreAcquiredPhoneLease(): boolean;
}

export interface RunStandardPhoneFirstAuthDeps {
    lease: ActivationLease;
    shouldRecycleGeneratedMailApiAccount: boolean;
    defaultPassword: string;
    createRegisterClient: (lease?: ActivationLease) => PhoneFirstFlowClient;
    createLoginClient: (email: string, lease?: ActivationLease) => PhoneFirstFlowClient;
    discardEmail: (email: string) => Promise<void>;
    markEmailUsed: (email: string, password: string) => Promise<void>;
    discardUnusedPhoneLease?: () => void | Promise<void>;
}

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

function isUserAlreadyExistsError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) => /(?:^|\W)(?:code=)?user_already_exists(?:$|\W)/i.test(text));
}

function isMailApiIcuAuthFailedError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) =>
            text.includes("MailAPI.ICU 请求失败: 401")
            || text.includes("邮箱认证失败")
            || text.includes("EmailOtpValidate请求失败: 403 code=account_deactivated")
            || text.includes("code=account_deactivated"),
        );
}

function isMailApiIcuOtpMissingError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) => text.includes("MailAPI.ICU 中未找到验证码"));
}

async function sleep(ms: number): Promise<void> {
    if (ms <= 0) {
        return;
    }

    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function markAsFailedIfPossible(markAsFailed: (rotate?: boolean) => Promise<void>, rotate?: boolean): Promise<void> {
    try {
        await markAsFailed(rotate);
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (text.includes("当前没有可结束的 activation") || text.includes("当前没有进行中的 attempt")) {
            return;
        }
        throw error;
    }
}

async function discardCurrentActivationIfPossible(discardCurrentActivation?: () => void | Promise<void>): Promise<void> {
    if (!discardCurrentActivation) {
        return;
    }

    try {
        await discardCurrentActivation();
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (text.includes("当前没有可结束的 activation") || text.includes("当前没有可用 activation")) {
            return;
        }
        throw error;
    }
}

export function createConfiguredSMSBroker(configOverride: SMSBrokerConfigOverride = {}): ISMSActivationBroker | undefined {
    const apiKey = configOverride.apiKey ?? appConfig.heroSMSApiKey;
    if (!apiKey) {
        return undefined;
    }

    return createSMSBroker({
        apiKey,
        pollAttempts: configOverride.pollAttempts ?? appConfig.heroSMSPollAttempts,
        pollIntervalMs: configOverride.pollIntervalMs ?? appConfig.heroSMSPollIntervalMs,
        basePrice: configOverride.basePrice ?? appConfig.heroSMSBasePrice,
        maxPrice: configOverride.maxPrice ?? appConfig.heroSMSMaxPrice,
        priceStep: configOverride.priceStep ?? appConfig.heroSMSPriceStep,
        country: configOverride.country ?? appConfig.heroSMSCountry,
    });
}

export async function runPhoneFirstLoop(options: RunPhoneFirstLoopOptions): Promise<void> {
    const log = options.log ?? console.log;
    const sleepFn = options.sleep ?? sleep;
    let round = 0;

    while (!options.maxRounds || round < options.maxRounds) {
        round += 1;
        const result = await options.acquirePhoneThenRegister({round});
        if (result.status === "no_number") {
            log(`[phone-first] 本轮未获取到可用号码，等待 ${options.loopDelayMs}ms 后重试`);
            await sleepFn(options.loopDelayMs);
            continue;
        }

        if (result.status === "retry") {
            log(`[phone-first] 当前轮次失败，等待 ${options.loopDelayMs}ms 后继续下一轮`);
            await sleepFn(options.loopDelayMs);
        }
    }
}

export async function acquirePhoneThenRegisterWithDeps(deps: AcquirePhoneThenRegisterDeps): Promise<PhoneFirstAttemptResult> {
    let lease: ActivationLease;
    try {
        lease = await deps.getLease();
    } catch (error) {
        if (error instanceof HeroSmsMaxPriceExhaustedError) {
            return {status: "no_number"};
        }
        throw error;
    }

    try {
        const result = await deps.register(lease);
        if (!result.phoneWasUsed) {
            await discardCurrentActivationIfPossible(deps.discardCurrentActivation);
        }
        return {status: "success"};
    } catch (error) {
        await markAsFailedIfPossible(deps.markAsFailed, true);
        throw error;
    }
}

export async function runStandardPhoneFirstAuthWithDeps(deps: RunStandardPhoneFirstAuthDeps): Promise<RegisterAttemptOutcome> {
    const registerClient = deps.createRegisterClient();

    try {
        await registerClient.authRegisterHTTP();
    } catch (error) {
        if (deps.shouldRecycleGeneratedMailApiAccount && registerClient.email) {
            if (isUserAlreadyExistsError(error) || isMailApiIcuAuthFailedError(error)) {
                await deps.discardEmail(registerClient.email);
            }
        }
        throw error;
    }

    const loginClient = deps.createLoginClient(registerClient.email, deps.lease);

    try {
        const result = await loginClient.authLoginHTTP();
        if (deps.shouldRecycleGeneratedMailApiAccount && loginClient.email) {
            await deps.markEmailUsed(loginClient.email, deps.defaultPassword);
        }
        console.log(
            `[✅️授权成功] 邮箱：${loginClient.email} 密码：${deps.defaultPassword} 授权文件：${result.authFile ?? ""}`,
        );
        return {phoneWasUsed: loginClient.didUsePreAcquiredPhoneLease()};
    } catch (error) {
        if (!loginClient.didUsePreAcquiredPhoneLease()) {
            await discardCurrentActivationIfPossible(deps.discardUnusedPhoneLease);
        }
        if (deps.shouldRecycleGeneratedMailApiAccount && loginClient.email) {
            if (isMailApiIcuAuthFailedError(error)) {
                await deps.discardEmail(loginClient.email);
            }
        }
        throw error;
    }
}

async function runPhoneFirstRegister(): Promise<PhoneFirstAttemptResult> {
    const email = readArgValue("--email").trim();
    const manualOtp = hasFlag("--otp");
    const directSignupAuth = hasFlag("--sign");
    const shouldRecycleGeneratedMailApiAccount = appConfig.provider === "mailapi-icu" && !email;

    const smsBroker = createConfiguredSMSBroker();
    if (!smsBroker) {
        throw new Error("phone-first 模式要求已配置 HeroSMS");
    }

    return acquirePhoneThenRegisterWithDeps({
        getLease: async () => await smsBroker.getActivation(),
        register: async (lease) => {
            const deviceProfile = generateRandomDeviceProfile();
            if (directSignupAuth) {
                const client = new OpenAIClient({
                    email: email || undefined,
                    password: appConfig.defaultPassword,
                    deviceProfile,
                    manualMode: manualOtp,
                    signupScreenHint: "signup",
                    smsBroker,
                    preAcquiredPhoneLease: lease,
                });
                try {
                    const result = await client.authRegisterAndAuthorizeHTTP();
                    if (shouldRecycleGeneratedMailApiAccount && client.email) {
                        await markEmailAddressUsed(client.email, appConfig.defaultPassword);
                    }
                    console.log(
                        `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
                    );
                    return {phoneWasUsed: client.didUsePreAcquiredPhoneLease()};
                } catch (error) {
                    if (!client.didUsePreAcquiredPhoneLease()) {
                        await discardCurrentActivationIfPossible(() => smsBroker.discardCurrentActivation?.());
                    }
                    if (shouldRecycleGeneratedMailApiAccount && client.email) {
                        if (isUserAlreadyExistsError(error) || isMailApiIcuAuthFailedError(error)) {
                            await discardEmailAddress(client.email);
                        }
                    }
                    throw error;
                }
            }

            return await runStandardPhoneFirstAuthWithDeps({
                lease,
                shouldRecycleGeneratedMailApiAccount,
                defaultPassword: appConfig.defaultPassword,
                createRegisterClient: () => new OpenAIClient({
                    email: email || undefined,
                    password: appConfig.defaultPassword,
                    deviceProfile,
                    manualMode: manualOtp,
                    smsBroker,
                }),
                createLoginClient: (registeredEmail, loginLease) => new OpenAIClient({
                    email: registeredEmail,
                    password: appConfig.defaultPassword,
                    deviceProfile,
                    manualMode: manualOtp,
                    smsBroker,
                    preAcquiredPhoneLease: loginLease,
                }),
                discardEmail: discardEmailAddress,
                markEmailUsed: markEmailAddressUsed,
                discardUnusedPhoneLease: () => smsBroker.discardCurrentActivation?.(),
            });
        },
        markAsFailed: async (rotate?: boolean) => {
            await smsBroker.markAsFailed(rotate);
        },
        discardCurrentActivation: () => smsBroker.discardCurrentActivation?.(),
    });
}

export async function main(): Promise<void> {
    if (hasFlag("--auth")) {
        throw new Error("phone-first 命令不支持 --auth，请继续使用原有 npm run dev/start -- --auth");
    }

    const maxRounds = readNumberArg("--n");
    await runPhoneFirstLoop({
        maxRounds,
        loopDelayMs: appConfig.loopDelayMs,
        acquirePhoneThenRegister: async ({round}) => {
            console.log(`第 ${round} 轮开始: 模式=phone-first`);
            try {
                return await runPhoneFirstRegister();
            } catch (error) {
                if (isMailApiIcuOtpMissingError(error)) {
                    console.warn(`[phone-first] MailAPI.ICU 未收到邮箱验证码，跳过当前轮并继续下一轮: ${error instanceof Error ? error.message : String(error)}`);
                    return {status: "retry"};
                }
                throw error;
            }
        },
    });
}

if (/(^|[\\/])phone-first-register\.(ts|cjs)$/.test(process.argv[1] ?? "")) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
