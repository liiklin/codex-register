import { ActivationBroker, type ISMSActivationBroker } from "./activation-broker.js";
import { createHeroSmsProvider } from "./heroSMS.js";
import { createSmsBowerProvider } from "./smsBower.js";
import { appConfig, type SmsProviderName } from "../config.js";

type HeroSMSBrokerOption = {
  apiKey: string;
  country: number;
  basePrice: number;
  maxPrice: number;
  priceStep: number;
  pollAttempts: number;
  pollIntervalMs: number;
}

interface SmsBowerBrokerOption {
  apiKey: string;
  country: number;
  basePrice: number;
  maxPrice: number;
  priceStep: number;
  pollAttempts: number;
  pollIntervalMs: number;
}

export const createSMSBroker = (option: HeroSMSBrokerOption) => {
  return new ActivationBroker(
    createHeroSmsProvider({
      apiKey: option.apiKey,
      defaultRequestOptions: {
        // openai
        service: "dr",
        country: option.country,
        maxPrice: option.basePrice,
        fixedPrice: true,
      },
      dynamicBasePrice: option.basePrice,
      dynamicMaxPrice: option.maxPrice,
      dynamicPriceStep: option.priceStep,
      defaultWaitForCodeOptions: {
        markReady: false,
        completeOnCode: false,
        pollAttempts: option.pollAttempts,
        pollIntervalMs: option.pollIntervalMs,
      },
    }),
  );
};

export const createSmsBowerBroker = (option: SmsBowerBrokerOption) => {
  return new ActivationBroker(
    createSmsBowerProvider({
      apiKey: option.apiKey,
      defaultRequestOptions: {
        service: "dr",
        country: option.country,
        maxPrice: option.basePrice,
      },
      dynamicBasePrice: option.basePrice,
      dynamicMaxPrice: option.maxPrice,
      dynamicPriceStep: option.priceStep,
      defaultWaitForCodeOptions: {
        markReady: false,
        completeOnCode: false,
        pollAttempts: option.pollAttempts,
        pollIntervalMs: option.pollIntervalMs,
      },
    }),
  );
};

interface SMSBrokerConfigOverride {
    apiKey?: string;
    pollAttempts?: number;
    pollIntervalMs?: number;
    basePrice?: number;
    maxPrice?: number;
    priceStep?: number;
    country?: number;
}

export function createConfiguredSMSBroker(configOverride: SMSBrokerConfigOverride = {}): ISMSActivationBroker | undefined {
    const providerName = appConfig.smsProvider;

    if (providerName === "smsBower") {
        const apiKey = appConfig.smsBowerApiKey;
        if (!apiKey) {
            throw new Error("smsProvider 配置为 smsBower，但未配置 smsBowerApiKey");
        }
        return createSmsBowerBroker({
            apiKey,
            pollAttempts: configOverride.pollAttempts ?? appConfig.smsBowerPollAttempts,
            pollIntervalMs: configOverride.pollIntervalMs ?? appConfig.smsBowerPollIntervalMs,
            basePrice: configOverride.basePrice ?? appConfig.smsBowerBasePrice,
            maxPrice: configOverride.maxPrice ?? appConfig.smsBowerMaxPrice,
            priceStep: configOverride.priceStep ?? appConfig.smsBowerPriceStep,
            country: configOverride.country ?? appConfig.smsBowerCountry,
        });
    }

    // 默认使用 HeroSMS
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
