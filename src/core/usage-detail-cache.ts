import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountUsage } from "./usage-window.js";

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
	fetchedAt: number;
	usage: AccountUsage;
}

export interface AccountUsageCache {
	get(
		accountName: string,
		credential: string,
		fetchUsage: () => Promise<AccountUsage>,
	): Promise<AccountUsage>;
}

export interface AccountUsageCacheOptions {
	ttlMs?: number;
	now?: () => number;
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function entryPath(agentDir: string, providerId: string, accountName: string, credential: string): string {
	const identity = fingerprint(`${providerId}\0${accountName}\0${fingerprint(credential)}`);
	return join(agentDir, "senpi-multiaccounts-usage", `${identity}.json`);
}

function readEntry(path: string): CacheEntry | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const candidate = parsed as Partial<CacheEntry>;
		if (typeof candidate.fetchedAt !== "number" || typeof candidate.usage !== "object" || !candidate.usage) {
			return undefined;
		}
		return candidate as CacheEntry;
	} catch {
		return undefined;
	}
}

function writeEntry(path: string, entry: CacheEntry): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

export function createAccountUsageCache(
	agentDir: string,
	providerId: string,
	options: AccountUsageCacheOptions = {},
): AccountUsageCache {
	const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
	const now = options.now ?? Date.now;
	const inFlight = new Map<string, Promise<AccountUsage>>();

	return {
		async get(accountName, credential, fetchUsage) {
			const path = entryPath(agentDir, providerId, accountName, credential);
			const existing = readEntry(path);
			if (existing && now() - existing.fetchedAt < ttl) return existing.usage;

			const requestKey = fingerprint(`${accountName}\0${credential}`);
			const pending = inFlight.get(requestKey);
			if (pending) return pending;

			const load = fetchUsage()
				.then((usage) => {
					writeEntry(path, { fetchedAt: now(), usage });
					return usage;
				})
				.catch((error) => {
					if (!existing) throw error;
					return { ...existing.usage, stale: true };
				})
				.finally(() => {
					inFlight.delete(requestKey);
				});
			inFlight.set(requestKey, load);
			return load;
		},
	};
}
