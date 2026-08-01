import type { UsageSnapshot } from "./affinity.js";

/**
 * Short-lived cache for per-account headroom.
 *
 * `balanced` mode needs a usage snapshot to steer a *cold* conversation onto the
 * account with the most quota left. Fetching that inline would add a network
 * round-trip to every request, and the numbers barely move between requests, so
 * a snapshot is reused for a few seconds.
 *
 * The cache is deliberately forgiving: a refresh that fails or times out yields
 * the previous snapshot (or nothing), because routing must never block on a
 * quota lookup. Placement then degrades to cache-affinity ordering, which is
 * still correct -- just not usage-aware.
 */

/** How long a snapshot stays fresh. */
const DEFAULT_TTL_MS = 30_000;
/** Hard ceiling on a refresh, so a hung endpoint cannot stall a request. */
const DEFAULT_TIMEOUT_MS = 2_000;

export interface UsageCacheOptions {
	ttlMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

export interface UsageCache {
	/** Current snapshot, refreshing in the background when stale. */
	get(): UsageSnapshot | undefined;
	/** Await a fresh snapshot, bounded by `timeoutMs`. */
	refresh(): Promise<UsageSnapshot | undefined>;
}

/**
 * Wrap a usage fetcher in a TTL cache.
 *
 * The first call returns `undefined` rather than waiting: routing proceeds
 * without usage data and the snapshot is ready for the next request. This keeps
 * the very first request of a session as fast as an unrouted one.
 */
export function createUsageCache(
	fetchUsage: () => Promise<Record<string, number | undefined>>,
	options: UsageCacheOptions = {},
): UsageCache {
	const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? Date.now;

	let snapshot: UsageSnapshot | undefined;
	let fetchedAt = 0;
	let inFlight: Promise<UsageSnapshot | undefined> | undefined;

	const load = (): Promise<UsageSnapshot | undefined> => {
		if (inFlight) return inFlight;
		const deadline = new Promise<undefined>((resolve) => {
			const timer = setTimeout(() => resolve(undefined), timeout);
			// Never hold the process open for a quota refresh.
			if (typeof timer === "object" && timer !== null && "unref" in timer) {
				(timer as { unref(): void }).unref();
			}
		});
		inFlight = Promise.race([fetchUsage(), deadline])
			.then((value) => {
				if (value) {
					snapshot = value;
					fetchedAt = now();
				}
				return snapshot;
			})
			.catch(() => snapshot)
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};

	return {
		get(): UsageSnapshot | undefined {
			if (snapshot === undefined || now() - fetchedAt >= ttl) {
				// Kick off a refresh but do not wait: the current (possibly stale or
				// absent) snapshot is good enough to place this request.
				void load();
			}
			return snapshot;
		},
		refresh: load,
	};
}
