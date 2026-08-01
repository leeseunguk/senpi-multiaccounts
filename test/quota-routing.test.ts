import { describe, expect, it } from "vitest";
import type { AccountSlot } from "../src/core/accounts.js";
import { headroomOf, syncQuotaBlock } from "../src/core/usage-window.js";

const SLOT: AccountSlot = {
	name: "default",
	access: "access",
	refresh: "refresh",
	expires: 9_999_999,
	source: "login",
};

describe("quota-aware account routing", () => {
	it("blocks an exhausted account until its latest unscoped reset", () => {
		const account = syncQuotaBlock(
			SLOT,
			{
				windows: [
					{ label: "5h", usedFraction: 1, resetsAt: 4_000 },
					{ label: "week", usedFraction: 1, resetsAt: 8_000 },
				],
			},
			1_000,
		);

		expect(account).toMatchObject({ blockReason: "quota", blockedUntil: 8_000 });
	});

	it("does not retire the whole account for an exhausted model-scoped window", () => {
		const usage = {
			windows: [
				{ label: "week", usedFraction: 0.25, resetsAt: 8_000 },
				{ label: "Fable", usedFraction: 1, resetsAt: 8_000, scoped: true },
			],
		};

		expect(syncQuotaBlock(SLOT, usage, 1_000)).toEqual(SLOT);
		expect(headroomOf(usage)).toBe(0.75);
	});

	it("clears only quota blocks after usage recovers", () => {
		const recovered = { windows: [{ label: "week", usedFraction: 0.1, resetsAt: 8_000 }] };
		const quotaBlocked = { ...SLOT, blockReason: "quota" as const, blockedUntil: 8_000 };
		const authBlocked = { ...SLOT, blockReason: "auth_error" as const };

		expect(syncQuotaBlock(quotaBlocked, recovered, 1_000)).toEqual(SLOT);
		expect(syncQuotaBlock(authBlocked, recovered, 1_000)).toEqual(authBlocked);
	});
});
