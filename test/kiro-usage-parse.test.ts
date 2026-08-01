import { describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the usage parser.
 *
 * The endpoint reports quota in `usageBreakdownList[].{currentUsage,usageLimit}WithPrecision`.
 * Reading top-level `usedCount`/`limitCount` (which do not exist) returned 0/0 for
 * every account, which read as "unmetered plan" and silently disabled usage-aware
 * placement even though the Kiro account page clearly showed credits used.
 */

const RESPONSE = {
	subscriptionInfo: { subscriptionTitle: "KIRO PRO MAX" },
	userInfo: { email: "jgplabs.01@gmail.com" },
	usageBreakdownList: [
		{
			resourceType: "CREDIT",
			currentUsageWithPrecision: 0.58,
			usageLimitWithPrecision: 5000,
			nextDateReset: 1_785_888_000,
		},
	],
};

async function fetchUsageWith(body: unknown, status = 200) {
	vi.resetModules();
	const fetchMock = vi.fn(async () => ({
		ok: status === 200,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	}));
	vi.stubGlobal("fetch", fetchMock);
	const { fetchKiroUsage } = await import("../src/providers/kiro/oauth.js");
	return fetchKiroUsage({ access: "a", refresh: "r", expires: Date.now() + 1e6 } as never);
}

describe("kiro usage parsing", () => {
	it("reads credits from usageBreakdownList, not the absent top-level fields", async () => {
		const usage = await fetchUsageWith(RESPONSE);

		expect(usage.usedCount).toBeCloseTo(0.58);
		expect(usage.limitCount).toBe(5000);
	});

	it("yields the headroom the account page shows", async () => {
		const usage = await fetchUsageWith(RESPONSE);
		const headroom = 1 - usage.usedCount / usage.limitCount;

		// 0.58 / 5000 rounds to 0% used on the account page.
		expect(headroom).toBeGreaterThan(0.999);
	});

	it("captures the plan title and reset time", async () => {
		const usage = await fetchUsageWith(RESPONSE);

		expect(usage.plan).toBe("KIRO PRO MAX");
		// nextDateReset is epoch seconds; it must be exposed as millis.
		expect(usage.resetAt).toBe(1_785_888_000_000);
	});

	it("falls back to a non-CREDIT row rather than reporting unmetered", async () => {
		// If the resource type is ever renamed, numbers must still be found.
		const usage = await fetchUsageWith({
			usageBreakdownList: [{ resourceType: "CREDITS_V2", currentUsage: 10, usageLimit: 200 }],
		});

		expect(usage.usedCount).toBe(10);
		expect(usage.limitCount).toBe(200);
	});

	it("reports zero limit when the payload genuinely has no rows", async () => {
		// Callers treat limitCount <= 0 as "headroom unknown" and skip the account
		// for usage-aware placement rather than guessing.
		const usage = await fetchUsageWith({ usageBreakdownList: [] });

		expect(usage.limitCount).toBe(0);
	});

	it("still extracts the account email", async () => {
		expect((await fetchUsageWith(RESPONSE)).email).toBe("jgplabs.01@gmail.com");
	});
});
