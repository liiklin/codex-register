# Phone-First Registration Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有 `npm run dev` / `npm run start` 行为的前提下，新增一个独立的 phone-first 注册命令：先申请符合 HeroSMS 价格区间的号码，拿到号后再进入注册；无号则等待 30 秒后重试。

**Architecture:** 保留 `src/index.ts` 作为现有主入口不动，新增一个独立入口 `src/phone-first-register.ts` 承接新命令，这样旧命令路径不会发生语义漂移。`OpenAIClient` 增加“优先使用预先拿到的 ActivationLease”的能力，但保留现有 `smsBroker.getActivation()` 兜底逻辑，以便老流程继续使用原有行为。

**Tech Stack:** TypeScript、Node.js `node:test`、tsup、现有 `OpenAIClient` / `ActivationBroker` / HeroSMS 集成

---

## File Structure

- Modify: `package.json`
  - 新增 `dev:phone-first` / `start:phone-first` 命令。
- Modify: `tsup.config.ts`
  - 把 `src/phone-first-register.ts` 加入打包入口。
- Create: `src/phone-first-register.ts`
  - 新的 CLI 入口；负责参数解析、自动循环、无号等待 30 秒重试、预拿号后驱动注册/授权。
- Create: `src/phone-first-register.test.ts`
  - 覆盖新入口的 phone-first 循环策略与“无号等待后继续”的行为。
- Modify: `src/openai.ts`
  - 为 `OpenAIClient` 增加可选的 `preAcquiredPhoneLease` 注入，并在 `authRegisterHTTP()` / `authRegisterAndAuthorizeHTTP()` / `authLoginHTTP()` 的 add-phone 分支优先消费该 lease。
- Modify: `src/openai.test.ts`
  - 新增测试，验证：有预拿号时不会再次 `getActivation()`；发送失败后会正确释放/轮换；无预拿号时仍保留原始行为。
- Modify: `README.md`
  - 记录新命令用法与 phone-first 模式说明。

## Design Notes

- 不新增配置项。新命令直接复用现有：
  - `heroSMSBasePrice`
  - `heroSMSMaxPrice`
  - `heroSMSPriceStep`
  - `heroSMSPollAttempts`
  - `heroSMSPollIntervalMs`
  - `loopDelayMs`
- phone-first 模式下，“没有号码”不应结束整个进程，而应记录日志并按 `loopDelayMs` 等待后进入下一轮。
- 旧入口 `src/index.ts` 继续保留当前 `HeroSmsMaxPriceExhaustedError` 即终止自动循环的语义，不做变更。
- `batch-register.ts` 不纳入本次范围，避免一次性扩大改动面。

### Task 1: Add a dedicated phone-first CLI entrypoint

**Files:**
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Create: `src/phone-first-register.ts`
- Test: `src/phone-first-register.test.ts`

- [ ] **Step 1: Write the failing test for the new loop policy**

```ts
import test from "node:test";
import assert from "node:assert/strict";

import {runPhoneFirstLoop} from "./phone-first-register.js";

test("runPhoneFirstLoop waits and retries when no phone number is available", async () => {
  const events: string[] = [];

  await runPhoneFirstLoop({
    maxRounds: 2,
    loopDelayMs: 30_000,
    acquirePhoneThenRegister: async ({round}) => {
      events.push(`attempt:${round}`);
      if (round === 1) {
        return {status: "no_number"};
      }
      return {status: "success"};
    },
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    log: (message) => {
      events.push(`log:${message}`);
    },
  });

  assert.deepEqual(events, [
    "attempt:1",
    "log:[phone-first] 本轮未获取到可用号码，等待 30000ms 后重试",
    "sleep:30000",
    "attempt:2",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/phone-first-register.test.ts`

Expected: FAIL with an error similar to `Cannot find module './phone-first-register.js'` or `runPhoneFirstLoop is not exported`.

- [ ] **Step 3: Create the dedicated entrypoint with injectable loop dependencies**

```ts
import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {createSMSBroker} from "./sms/index.js";
import {HeroSmsMaxPriceExhaustedError} from "./sms/heroSMS.js";

export interface PhoneFirstAttemptResult {
  status: "success" | "no_number";
}

export interface RunPhoneFirstLoopOptions {
  maxRounds: number | null;
  loopDelayMs: number;
  acquirePhoneThenRegister: (context: {round: number}) => Promise<PhoneFirstAttemptResult>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export async function runPhoneFirstLoop(options: RunPhoneFirstLoopOptions): Promise<void> {
  const sleep = options.sleep ?? (async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  const log = options.log ?? console.log;
  let round = 0;

  while (!options.maxRounds || round < options.maxRounds) {
    round += 1;
    const result = await options.acquirePhoneThenRegister({round});
    if (result.status === "no_number") {
      log(`[phone-first] 本轮未获取到可用号码，等待 ${options.loopDelayMs}ms 后重试`);
      if (options.loopDelayMs > 0) {
        await sleep(options.loopDelayMs);
      }
      continue;
    }
  }
}

function readArgValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return "";
  }
  return process.argv[index + 1] ?? "";
}

function readNumberArg(flag: string): number | null {
  const raw = readArgValue(flag).trim();
  if (!raw) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const smsBroker = appConfig.heroSMSApiKey ? createSMSBroker({
  apiKey: appConfig.heroSMSApiKey,
  pollAttempts: appConfig.heroSMSPollAttempts,
  pollIntervalMs: appConfig.heroSMSPollIntervalMs,
  basePrice: appConfig.heroSMSBasePrice,
  maxPrice: appConfig.heroSMSMaxPrice,
  priceStep: appConfig.heroSMSPriceStep,
  country: appConfig.heroSMSCountry,
}) : undefined;

export async function acquirePhoneThenRegister(): Promise<PhoneFirstAttemptResult> {
  if (!smsBroker) {
    throw new Error("phone-first 模式要求已配置 HeroSMS");
  }

  try {
    const lease = await smsBroker.getActivation();
    const client = new OpenAIClient({
      password: appConfig.defaultPassword,
      deviceProfile: generateRandomDeviceProfile(),
      smsBroker,
      preAcquiredPhoneLease: lease,
    });

    await client.authRegisterAndAuthorizeHTTP();
    await smsBroker.markAsSucceed();
    return {status: "success"};
  } catch (error) {
    if (error instanceof HeroSmsMaxPriceExhaustedError) {
      return {status: "no_number"};
    }
    throw error;
  }
}

async function main(): Promise<void> {
  await runPhoneFirstLoop({
    maxRounds: readNumberArg("--n"),
    loopDelayMs: appConfig.loopDelayMs,
    acquirePhoneThenRegister: async () => acquirePhoneThenRegister(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Add npm scripts and bundle entry**

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "dev:phone-first": "tsx src/phone-first-register.ts",
    "start": "node bundle/index.cjs",
    "start:phone-first": "node bundle/phone-first-register.cjs"
  }
}
```

```ts
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "phone-first-register": "src/phone-first-register.ts",
    "check-auth-quota": "src/check-auth-quota.ts",
    "batch-register": "src/batch-register.ts",
    "freemail-bulk-delete": "src/freemail-bulk-delete.ts",
  },
  outDir: "bundle",
  format: ["cjs"],
});
```

- [ ] **Step 5: Run tests to verify the new entrypoint passes**

Run: `node --import tsx --test src/phone-first-register.test.ts`

Expected: PASS with `runPhoneFirstLoop waits and retries when no phone number is available`.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json tsup.config.ts src/phone-first-register.ts src/phone-first-register.test.ts
git commit -m "feat: add phone-first registration command entrypoint"
```

### Task 2: Allow OpenAIClient to reuse a pre-acquired phone lease

**Files:**
- Modify: `src/openai.ts`
- Test: `src/openai.test.ts`

- [ ] **Step 1: Write the failing test for pre-acquired lease reuse**

```ts
test("requestPhoneOtpWithRetry uses pre-acquired lease before broker allocation", async () => {
  const lease = createLease("8888888888");
  const smsBrokerCalls: string[] = [];
  const sentPhones: string[] = [];

  const client = new OpenAIClient({
    password: "secret",
    preAcquiredPhoneLease: lease,
    smsBroker: {
      async getActivation() {
        smsBrokerCalls.push("getActivation");
        return createLease("9999999999");
      },
      async markAsSucceed() {
        smsBrokerCalls.push("markAsSucceed");
      },
      async markAsFailed(rotate?: boolean) {
        smsBrokerCalls.push(`markAsFailed:${rotate ? "rotate" : "plain"}`);
      },
    },
  });

  (client as any).logProgress = () => {};
  (client as any).sendPhoneOtp = async (phoneNumber: string) => {
    sentPhones.push(phoneNumber);
    return "/phone-verification";
  };

  const result = await (client as any).requestPhoneOtpWithRetry({current: "4-b", total: 6});

  assert.equal(result.lease.phoneNumber, "8888888888");
  assert.deepEqual(sentPhones, ["+8888888888"]);
  assert.deepEqual(smsBrokerCalls, []);
});
```

- [ ] **Step 2: Run the targeted OpenAI tests to verify failure**

Run: `node --import tsx --test src/openai.test.ts`

Expected: FAIL because `OpenAIClientOptions` does not yet accept `preAcquiredPhoneLease`, or because the method still calls `smsBroker.getActivation()` immediately.

- [ ] **Step 3: Add the pre-acquired lease seam without breaking fallback behavior**

```ts
import {ActivationLease, ISMSActivationBroker} from "./sms/activation-broker.js";

export interface OpenAIClientOptions {
  email?: string;
  password: string;
  userAgent?: string;
  deviceProfile?: DeviceProfile;
  manualMode?: boolean;
  signupScreenHint?: string;
  smsBroker?: ISMSActivationBroker;
  preAcquiredPhoneLease?: ActivationLease;
}

export class OpenAIClient {
  readonly smsBroker?: ISMSActivationBroker;
  private preAcquiredPhoneLease?: ActivationLease;

  constructor(options: OpenAIClientOptions) {
    this.smsBroker = options.smsBroker;
    this.preAcquiredPhoneLease = options.preAcquiredPhoneLease;
  }

  private async requestPhoneOtpWithRetry(progress: {current: number | string; total: number}) {
    if (!this.smsBroker && !this.preAcquiredPhoneLease) {
      throw new Error("未配置 SMS provider，无法进行短信验证");
    }

    let lease = this.preAcquiredPhoneLease;
    this.preAcquiredPhoneLease = undefined;

    if (!lease) {
      if (!this.smsBroker) {
        throw new Error("缺少短信 broker，无法重新分配号码");
      }
      lease = await this.smsBroker.getActivation();
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const phoneNumber = `+${lease.phoneNumber}`;
      try {
        const continueURL = await this.sendPhoneOtp(phoneNumber);
        return {continueURL, lease};
      } catch (error) {
        const shouldRotateAndRetry = attempt < 2 && this.smsBroker && (
          this.isPhoneMaxUsageExceededError(error) ||
          this.isPhoneNumberInUseError(error)
        );

        if (shouldRotateAndRetry) {
          await this.smsBroker.markAsFailed(true);
          lease = await this.smsBroker.getActivation();
          continue;
        }

        if (this.smsBroker) {
          await this.smsBroker.markAsFailed(true);
        }
        throw error;
      }
    }

    throw new Error("发送短信验证码失败");
  }
}
```

- [ ] **Step 4: Keep the add-phone flow paths unchanged except for lease source**

```ts
if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
  this.logProgress(step++, totalSteps++, "进入短信验证流程，从接码平台获取号码");
  const sendStep = {current: step++, total: totalSteps++};
  const {continueURL: nextContinueURL, lease} = await this.requestPhoneOtpWithRetry(sendStep);
  continueURL = nextContinueURL;
  this.logProgress(step++, totalSteps++, `等待短信验证码`);
  const {code} = await lease.waitForVerificationCode();
  this.logProgress(step++, totalSteps++, `提交短信验证，code=[${code}]`);
  continueURL = await this.validatePhone(code);
}
```

- [ ] **Step 5: Run the focused test suite**

Run: `node --import tsx --test src/openai.test.ts`

Expected: PASS, including the new pre-acquired lease test and the existing rotation tests.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/openai.ts src/openai.test.ts
git commit -m "feat: support pre-acquired phone leases in registration"
```

### Task 3: Make phone-first registration complete or release phone resources safely

**Files:**
- Modify: `src/phone-first-register.ts`
- Test: `src/phone-first-register.test.ts`

- [ ] **Step 1: Write the failing test for failed registration cleanup**

```ts
test("acquirePhoneThenRegister marks the activation as failed when registration throws", async () => {
  const events: string[] = [];
  const lease = {
    activationId: "a1",
    phoneNumber: "1234567890",
    isNewActivation: true,
    requestedAnotherSms: false,
    round: 1,
    async waitForVerificationCode() {
      return {code: "123456", source: "sms"};
    },
  };

  await assert.rejects(
    () => acquirePhoneThenRegisterWithDeps({
      getLease: async () => lease,
      register: async () => {
        throw new Error("registration failed");
      },
      markAsSucceed: async () => {
        events.push("markAsSucceed");
      },
      markAsFailed: async (rotate?: boolean) => {
        events.push(`markAsFailed:${rotate ? "rotate" : "plain"}`);
      },
    }),
    /registration failed/,
  );

  assert.deepEqual(events, ["markAsFailed:plain"]);
});
```

- [ ] **Step 2: Run the phone-first tests to verify they fail**

Run: `node --import tsx --test src/phone-first-register.test.ts`

Expected: FAIL because `acquirePhoneThenRegisterWithDeps` does not exist yet, or because failed registration does not release the activation.

- [ ] **Step 3: Extract a dependency-injected registration helper with explicit cleanup**

```ts
import type {ActivationLease} from "./sms/activation-broker.js";

export interface AcquirePhoneThenRegisterDeps {
  getLease: () => Promise<ActivationLease>;
  register: (lease: ActivationLease) => Promise<void>;
  markAsSucceed: () => Promise<void>;
  markAsFailed: (rotate?: boolean) => Promise<void>;
}

export async function acquirePhoneThenRegisterWithDeps(
  deps: AcquirePhoneThenRegisterDeps,
): Promise<PhoneFirstAttemptResult> {
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
    await deps.register(lease);
    await deps.markAsSucceed();
    return {status: "success"};
  } catch (error) {
    await deps.markAsFailed(false);
    throw error;
  }
}
```

- [ ] **Step 4: Wire the real runtime path through the dependency-injected helper**

```ts
export async function acquirePhoneThenRegister(): Promise<PhoneFirstAttemptResult> {
  if (!smsBroker) {
    throw new Error("phone-first 模式要求已配置 HeroSMS");
  }

  return await acquirePhoneThenRegisterWithDeps({
    getLease: async () => await smsBroker.getActivation(),
    register: async (lease) => {
      const client = new OpenAIClient({
        password: appConfig.defaultPassword,
        deviceProfile: generateRandomDeviceProfile(),
        smsBroker,
        preAcquiredPhoneLease: lease,
      });
      await client.authRegisterAndAuthorizeHTTP();
    },
    markAsSucceed: async () => {
      await smsBroker.markAsSucceed();
    },
    markAsFailed: async (rotate?: boolean) => {
      await smsBroker.markAsFailed(rotate);
    },
  });
}
```

- [ ] **Step 5: Run the phone-first tests again**

Run: `node --import tsx --test src/phone-first-register.test.ts`

Expected: PASS for both the “wait and retry” case and the “failed registration cleanup” case.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/phone-first-register.ts src/phone-first-register.test.ts
git commit -m "feat: add safe cleanup for phone-first registration flow"
```

### Task 4: Document the new command and verify build/test coverage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README usage for the new command**

```md
### Phone-first 注册模式

保留原有命令不变，同时新增一组 phone-first 命令：

```bash
npm run dev:phone-first
npm run dev:phone-first -- --n 1
npm run start:phone-first
```

这个模式会：

1. 先按 `heroSMSBasePrice ~ heroSMSMaxPrice` 尝试申请号码
2. 拿到号后再进入注册
3. 如果当前轮没有可用号码，则等待 `loopDelayMs` 后继续下一轮

说明：

- 旧的 `npm run dev` / `npm run start` 行为完全不变
- phone-first 模式依赖已配置的 `heroSMSApiKey`
- 本次只新增单账号自动模式，不改动 `batch-register`
```

- [ ] **Step 2: Run the focused tests and build**

Run: `node --import tsx --test src/openai.test.ts src/phone-first-register.test.ts src/sms/activation-broker.test.ts`

Expected: PASS with all targeted tests green.

Run: `npm run build`

Expected: PASS and generate `bundle/phone-first-register.cjs`.

- [ ] **Step 3: Commit Task 4**

```bash
git add README.md
git commit -m "docs: document phone-first registration command"
```

## Self-Review

- **Spec coverage:** 已覆盖“保留原命令不变”“新增独立命令”“先拿号再注册”“无号等待 30 秒重试”“注册失败释放号码”“README/脚本/构建入口同步”这些要求。
- **Placeholder scan:** 计划中没有 `TODO` / `TBD` / “自行处理” 之类占位语；每个任务都包含了明确文件、命令和代码片段。
- **Type consistency:** 全文统一使用 `preAcquiredPhoneLease`、`ActivationLease`、`runPhoneFirstLoop`、`acquirePhoneThenRegisterWithDeps` 这些命名，没有前后漂移。

## Out of Scope

- 不修改现有 `src/index.ts` 命令语义。
- 不修改 `src/batch-register.ts`。
- 不新增新的 HeroSMS 配置字段。
- 不在本计划内处理浏览器模式 / Sentinel 行为差异。

Plan complete and saved to `docs/superpowers/plans/2026-05-03-phone-first-registration-command.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
