import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPool, writePool } from "../src/core/store.js";
import { kiroProviderPackage } from "../src/providers/kiro/index.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Kiro quota routing state", () => {
	it("turns a zero-remaining usage response into a persisted quota block", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-kiro-quota-"));
		const resetAt = Date.now() + 3_600_000;
		writePool(agentDir, "kiro", {
			accounts: [
				{
					name: "default",
					access: "token",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
					source: "login",
					meta: { authMethod: "google", region: "us-east-1" },
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					usageBreakdownList: [
						{
							resourceType: "CREDIT",
							currentUsageWithPrecision: 5_000,
							usageLimitWithPrecision: 5_000,
							nextDateReset: resetAt / 1_000,
						},
					],
				}),
			})),
		);

		await kiroProviderPackage().accountUsageDetail?.({ env: {} as NodeJS.ProcessEnv, agentDir });

		expect(readPool(agentDir, "kiro").accounts[0]).toMatchObject({
			blockReason: "quota",
			blockedUntil: resetAt,
		});
	});
});
