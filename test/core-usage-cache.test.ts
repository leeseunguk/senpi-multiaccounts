import { describe, expect, it, vi } from "vitest";
import { placeRequest } from "../src/core/affinity.js";
import { createUsageCache } from "../src/core/usage-cache.js";

const slot = (name: string) => ({
	name,
	access: "a",
	refresh: "r",
	expires: Date.now() + 3_600_000,
	source: "login" as const,
	meta: {},
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("usage cache", () => {
	it("does not block the first request on a quota lookup", async () => {
		// Routing must never wait on the usage endpoint; the first request places
		// without data and the snapshot is ready for the next one.
		const cache = createUsageCache(async () => ({ a: 0.9 }));

		expect(cache.get()).toBeUndefined();
		await settle();
		expect(cache.get()).toEqual({ a: 0.9 });
	});

	it("reuses a snapshot within the TTL instead of refetching", async () => {
		const fetchUsage = vi.fn(async () => ({ a: 0.5 }));
		let clock = 1000;
		const cache = createUsageCache(fetchUsage, { ttlMs: 30_000, now: () => clock });

		await cache.refresh();
		clock += 10_000;
		cache.get();
		cache.get();
		await settle();

		expect(fetchUsage).toHaveBeenCalledTimes(1);
	});

	it("refetches once the TTL has expired", async () => {
		const fetchUsage = vi.fn(async () => ({ a: 0.5 }));
		let clock = 1000;
		const cache = createUsageCache(fetchUsage, { ttlMs: 5_000, now: () => clock });

		await cache.refresh();
		clock += 6_000;
		cache.get();
		await settle();

		expect(fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("keeps serving the previous snapshot when a refresh throws", async () => {
		// A quota endpoint that starts failing must not erase usable data.
		let attempt = 0;
		const cache = createUsageCache(async () => {
			attempt += 1;
			if (attempt > 1) throw new Error("HTTP 403");
			return { a: 0.7 };
		});

		await cache.refresh();
		expect(await cache.refresh()).toEqual({ a: 0.7 });
	});

	it("yields nothing when the very first refresh fails", async () => {
		const cache = createUsageCache(async () => {
			throw new Error("HTTP 403");
		});

		expect(await cache.refresh()).toBeUndefined();
	});

	it("collapses concurrent refreshes into one fetch", async () => {
		const fetchUsage = vi.fn(async () => ({ a: 0.5 }));
		const cache = createUsageCache(fetchUsage);

		await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);

		expect(fetchUsage).toHaveBeenCalledTimes(1);
	});
});

describe("usage-aware placement", () => {
	const state = {
		accounts: [slot("low"), slot("mid"), slot("high")],
		mode: "balanced" as const,
		bindings: {},
	};

	const tally = (usage?: Record<string, number>) => {
		const counts: Record<string, number> = {};
		for (let i = 0; i < 300; i++) {
			const placed = placeRequest({ ...state, bindings: {} }, { key: `c-${i}`, mode: "balanced", usage });
			counts[placed.account.name] = (counts[placed.account.name] ?? 0) + 1;
		}
		return counts;
	};

	it("steers cold conversations toward the account with the most headroom", () => {
		const counts = tally({ low: 0.05, mid: 0.4, high: 0.95 });

		expect(counts.high ?? 0).toBeGreaterThan(counts.mid ?? 0);
		// The most-exhausted account is avoided entirely.
		expect(counts.low ?? 0).toBe(0);
	});

	it("degrades to an even spread when no usage data exists", () => {
		// Kiro PRO MAX reports limitCount=0, so headroom is genuinely unknown and
		// placement must stay balanced rather than collapsing onto one account.
		const counts = tally(undefined);

		for (const name of ["low", "mid", "high"]) {
			expect(counts[name] ?? 0).toBeGreaterThan(0);
		}
	});

	it("never moves a warm conversation, even when another account has more quota", () => {
		// Cache affinity outranks quota: moving a live conversation would throw
		// away the prompt cache, which costs far more than uneven usage.
		const warm = { ...state, bindings: { "c-1": "low" } };

		const placed = placeRequest(warm, { key: "c-1", mode: "balanced", usage: { low: 0.01, high: 0.99 } });

		expect(placed.account.name).toBe("low");
		expect(placed.reusedBinding).toBe(true);
	});

	it("keeps cache-first pinned to the hashed account regardless of quota", () => {
		const first = placeRequest(state, { key: "stable-key", mode: "cache-first", usage: { low: 0.9 } });
		const second = placeRequest(state, { key: "stable-key", mode: "cache-first", usage: { high: 0.9 } });

		expect(second.account.name).toBe(first.account.name);
	});
});
