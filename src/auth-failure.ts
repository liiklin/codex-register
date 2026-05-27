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

export function isUserAlreadyExistsError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) => /(?:^|\W)(?:code=)?user_already_exists(?:$|\W)/i.test(text));
}

export function isMailApiIcuAuthFailedError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) =>
            text.includes("MailAPI.ICU 请求失败: 401")
            || text.includes("邮箱认证失败")
            || text.includes("EmailOtpValidate请求失败: 403 code=account_deactivated")
            || text.includes("code=account_deactivated"),
        );
}

export function isInvalidatedAuthTokenError(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) => text.includes("Your authentication token has been invalidated"));
}

export function shouldRemoveAuthBatchEntryOnAuthFailure(error: unknown): boolean {
    return collectErrorTexts(error)
        .some((text) => text.includes("PasswordVerify请求失败: 401 code=invalid_username_or_password"));
}
