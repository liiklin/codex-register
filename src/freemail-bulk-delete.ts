import path from "node:path";

import {appConfig} from "./config.js";
import {createFreemailAdminClient} from "./mail/freemail.js";

interface BulkDeleteArgs {
    pageSize: number;
    concurrency: number;
    limit: number;
    domain: string;
    dryRun: boolean;
    verbose: boolean;
}

interface BulkDeleteSummary {
    listed: number;
    attempted: number;
    deleted: number;
    skipped: number;
    failed: number;
}

export interface FreemailBulkDeleteAdminClient {
    listMailboxes(params: {limit?: number; offset?: number}): Promise<{
        list: Array<{address?: string; mailbox?: string}>;
        total: number;
    }>;
    deleteMailbox(address: string): Promise<boolean>;
    normalizeMailboxAddress(mailbox: {address?: string; mailbox?: string}): string;
}

interface RunFreemailBulkDeleteOptions {
    client?: FreemailBulkDeleteAdminClient;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 20;

function readArgValue(flag: string, argv = process.argv): string {
    const index = argv.indexOf(flag);
    if (index === -1) {
        return "";
    }
    return argv[index + 1] ?? "";
}

function hasFlag(flag: string, argv = process.argv): boolean {
    return argv.includes(flag);
}

function normalizePositiveInteger(raw: string, fallback: number, minimum = 1): number {
    const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    return parsed;
}

function normalizeDomain(raw: string): string {
    return String(raw ?? "").trim().toLowerCase().replace(/^@+/, "");
}

function matchesDomain(address: string, domain: string): boolean {
    const normalizedAddress = String(address ?? "").trim().toLowerCase();
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
        return true;
    }
    return normalizedAddress.endsWith(`@${normalizedDomain}`);
}

export function parseFreemailBulkDeleteArgs(argv = process.argv): BulkDeleteArgs {
    return {
        pageSize: normalizePositiveInteger(readArgValue("--page-size", argv), DEFAULT_PAGE_SIZE),
        concurrency: normalizePositiveInteger(readArgValue("--concurrency", argv), DEFAULT_CONCURRENCY),
        limit: normalizePositiveInteger(readArgValue("--limit", argv), 0, 0),
        domain: normalizeDomain(appConfig.freemailDeleteDomain),
        dryRun: hasFlag("--dry-run", argv),
        verbose: hasFlag("--verbose", argv),
    };
}

async function mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    if (items.length === 0) {
        return;
    }

    let currentIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({length: workerCount}, async () => {
        while (true) {
            const index = currentIndex;
            currentIndex += 1;
            if (index >= items.length) {
                return;
            }
            await worker(items[index]);
        }
    }));
}

export async function runFreemailBulkDelete(
    args: BulkDeleteArgs,
    options: RunFreemailBulkDeleteOptions = {},
): Promise<BulkDeleteSummary> {
    const client = options.client ?? createFreemailAdminClient();
    const summary: BulkDeleteSummary = {
        listed: 0,
        attempted: 0,
        deleted: 0,
        skipped: 0,
        failed: 0,
    };

    async function processMailboxes(mailboxes: Array<{normalizedAddress: string}>): Promise<void> {
        await mapWithConcurrency(mailboxes, args.concurrency, async (mailbox) => {
            summary.attempted += 1;
            if (args.dryRun) {
                summary.skipped += 1;
                if (args.verbose) {
                    console.log(`[dry-run] ${mailbox.normalizedAddress}`);
                }
                return;
            }

            try {
                const deleted = await client.deleteMailbox(mailbox.normalizedAddress);
                if (deleted) {
                    summary.deleted += 1;
                    if (args.verbose) {
                        console.log(`[deleted] ${mailbox.normalizedAddress}`);
                    }
                } else {
                    summary.skipped += 1;
                    if (args.verbose) {
                        console.log(`[skipped] ${mailbox.normalizedAddress}`);
                    }
                }
            } catch (error) {
                summary.failed += 1;
                console.error(`[failed] ${mailbox.normalizedAddress}`, error);
            }
        });
    }

    if (args.domain) {
        const matchedAddresses: string[] = [];
        let offset = 0;

        while (true) {
            const page = await client.listMailboxes({limit: args.pageSize, offset});
            const rawMailboxes = page.list
                .map((item) => ({
                    ...item,
                    normalizedAddress: client.normalizeMailboxAddress(item),
                }))
                .filter((item) => item.normalizedAddress);

            if (rawMailboxes.length === 0) {
                break;
            }

            const matched = rawMailboxes.filter((item) => matchesDomain(item.normalizedAddress, args.domain));
            console.log(
                `[*] 获取邮箱页: offset=${offset} count=${rawMailboxes.length} matched=${matched.length} total=${page.total} domain=${args.domain}`,
            );

            for (const mailbox of matched) {
                if (args.limit > 0 && matchedAddresses.length >= args.limit) {
                    break;
                }
                matchedAddresses.push(mailbox.normalizedAddress);
            }

            if (args.limit > 0 && matchedAddresses.length >= args.limit) {
                break;
            }

            if (rawMailboxes.length < args.pageSize) {
                break;
            }

            offset += args.pageSize;
        }

        summary.listed = matchedAddresses.length;
        await processMailboxes(matchedAddresses.map((normalizedAddress) => ({normalizedAddress})));
    } else {
        while (true) {
            const remaining = args.limit > 0 ? args.limit - summary.listed : args.pageSize;
            if (args.limit > 0 && remaining <= 0) {
                break;
            }

            const pageLimit = args.limit > 0 ? Math.min(args.pageSize, remaining) : args.pageSize;
            const page = await client.listMailboxes({limit: pageLimit, offset: 0});
            const rawMailboxes = page.list
                .map((item) => ({
                    ...item,
                    normalizedAddress: client.normalizeMailboxAddress(item),
                }))
                .filter((item) => item.normalizedAddress);

            if (rawMailboxes.length === 0) {
                break;
            }

            summary.listed += rawMailboxes.length;
            console.log(`[*] 获取邮箱页: offset=0 count=${rawMailboxes.length} matched=${rawMailboxes.length} total=${page.total}`);
            const deletedBefore = summary.deleted;
            const skippedBefore = summary.skipped;
            const failedBefore = summary.failed;
            await processMailboxes(rawMailboxes);

            const deletedDelta = summary.deleted - deletedBefore;
            const skippedDelta = summary.skipped - skippedBefore;
            const failedDelta = summary.failed - failedBefore;
            if (deletedDelta === 0 && rawMailboxes.length >= pageLimit) {
                throw new Error(
                    `Freemail 清理无法继续推进：当前第一页 ${rawMailboxes.length} 个邮箱均未删除成功，已跳过 ${skippedDelta} 个，失败 ${failedDelta} 个。请检查权限、接口返回或使用 --limit 限制重试范围。`,
                );
            }

            if (rawMailboxes.length < pageLimit) {
                break;
            }
        }
    }

    console.log(
        `Freemail 清理完成: listed=${summary.listed} attempted=${summary.attempted} deleted=${summary.deleted} skipped=${summary.skipped} failed=${summary.failed}`,
    );

    return summary;
}

export function shouldRunFreemailBulkDeleteMain(argvEntry: string | undefined): boolean {
    if (!argvEntry?.trim()) {
        return false;
    }

    const normalizedEntry = path.basename(path.resolve(argvEntry)).toLowerCase();
    return normalizedEntry === "freemail-bulk-delete.ts"
        || normalizedEntry === "freemail-bulk-delete.js"
        || normalizedEntry === "freemail-bulk-delete.cjs";
}

async function main(): Promise<void> {
    const args = parseFreemailBulkDeleteArgs();
    const summary = await runFreemailBulkDelete(args);
    if (summary.failed > 0) {
        process.exitCode = 1;
    }
}

if (shouldRunFreemailBulkDeleteMain(process.argv[1])) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
