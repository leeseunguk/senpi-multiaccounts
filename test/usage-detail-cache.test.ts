import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAccountUsageCache } from "../src/core/usage-detail-cache.js";

const USAGE = {
	windows: [{ label: "week", usedFraction: 0.25, resetsAt: 8_000 }],
	plan: "pro",
};

describe("persistent per-account usage cache", () => {
	it("reuses a fresh snapshot without another vendor request", async () => {
		const fetchUsage = vi.fn(async () => USAGE);
		const cache = createAccountUsageCache(mkdtempSync(join(tmpdir(), "usage-cache-")), "claude", {
			now: () => 1_000,
		});

		expect(await cache.get("default", "token-1", fetchUsage)).toEqual(USAGE);
		expect(await cache.get("default", "token-1", fetchUsage)).toEqual(USAGE);
		expect(fetchUsage).toHaveBeenCalledTimes(1);
	});

	it("returns a marked stale snapshot when a later refresh is rate-limited", async () => {
		const dir = mkdtempSync(join(tmpdir(), "usage-cache-"));
		let now = 1_000;
		const first = createAccountUsageCache(dir, "claude", { now: () => now, ttlMs: 100 });
		await first.get("default", "token-1", async () => USAGE);

		now = 2_000;
		const restarted = createAccountUsageCache(dir, "claude", { now: () => now, ttlMs: 100 });
		const usage = await restarted.get("default", "token-1", async () => {
			throw new Error("HTTP 429");
		});

		expect(usage).toEqual({ ...USAGE, stale: true });
	});

	it("stores no raw credential and restricts cache files to the owner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "usage-cache-"));
		const cache = createAccountUsageCache(dir, "claude", { now: () => 1_000 });
		await cache.get("default", "raw-secret-token", async () => USAGE);

		const cacheDir = join(dir, "senpi-multiaccounts-usage");
		const [file] = readdirSync(cacheDir);
		expect(file).toBeDefined();
		const path = join(cacheDir, file as string);
		expect(readFileSync(path, "utf8")).not.toContain("raw-secret-token");
		expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("does not deduplicate requests from different credential generations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "usage-cache-"));
		const cache = createAccountUsageCache(dir, "claude", { now: () => 1_000 });
		const first = cache.get("default", "token-1", async () => ({
			windows: [{ label: "week", usedFraction: 0.1 }],
		}));
		const second = cache.get("default", "token-2", async () => ({
			windows: [{ label: "week", usedFraction: 0.9 }],
		}));

		expect((await first).windows[0]?.usedFraction).toBe(0.1);
		expect((await second).windows[0]?.usedFraction).toBe(0.9);
		expect(readdirSync(join(dir, "senpi-multiaccounts-usage"))).toHaveLength(2);
	});
});
