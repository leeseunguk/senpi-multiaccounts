import { describe, expect, it, vi } from "vitest";
import { headroomOf } from "../src/core/usage-window.js";
import { parseCodexUsage } from "../src/providers/codex/usage.js";

/** Captured verbatim from `https://chatgpt.com/backend-api/codex/usage` on a live Pro account. */
const LIVE_RESPONSE = {
	email: "jgplabs@gmail.com",
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 12,
			limit_window_seconds: 604_800,
			reset_at: 1_786_178_025,
		},
		secondary_window: null,
	},
};

describe("codex usage parsing", () => {
	it("reads the primary window, plan and identity", () => {
		const usage = parseCodexUsage(LIVE_RESPONSE);

		expect(usage.plan).toBe("pro");
		expect(usage.email).toBe("jgplabs@gmail.com");
		expect(usage.windows).toEqual([
			{ label: "week", usedFraction: 0.12, resetsAt: 1_786_178_025_000 },
		]);
	});

	// `reset_at` is epoch *seconds* here and epoch millis nowhere else, so a
	// naive pass-through renders a 1970 reset date.
	it("converts the epoch-seconds reset stamp to millis", () => {
		expect(parseCodexUsage(LIVE_RESPONSE).windows[0]?.resetsAt).toBe(1_786_178_025_000);
	});

	it("labels the window by its own duration, since Plus meters 5h under the same key", () => {
		const plus = {
			...LIVE_RESPONSE,
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18_000 } },
		};

		expect(parseCodexUsage(plus).windows[0]?.label).toBe("5h");
	});

	it("includes a secondary window when the plan has one", () => {
		const both = {
			rate_limit: {
				primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 90, limit_window_seconds: 604_800 },
			},
		};

		const usage = parseCodexUsage(both);
		expect(usage.windows.map((window) => window.label)).toEqual(["5h", "week"]);
		expect(headroomOf(usage)).toBeCloseTo(0.1, 5);
	});

	it("reports no windows rather than throwing when the pool is unmetered", () => {
		expect(parseCodexUsage({}).windows).toEqual([]);
		expect(headroomOf(parseCodexUsage({}))).toBeUndefined();
	});
});

describe("codex usage fetch", () => {
	it("scopes the probe to one account so a pooled slot cannot read another's quota", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => LIVE_RESPONSE }));
		const { fetchCodexUsage } = await import("../src/providers/codex/usage.js");

		await fetchCodexUsage("token-y", "acct-1", fetchMock as never);

		const headers = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
		expect(headers.authorization).toBe("Bearer token-y");
		expect(headers["chatgpt-account-id"]).toBe("acct-1");
	});

	it("omits the account header when the slot has no account id", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => LIVE_RESPONSE }));
		const { fetchCodexUsage } = await import("../src/providers/codex/usage.js");

		await fetchCodexUsage("token-y", undefined, fetchMock as never);

		const headers = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
		expect(headers["chatgpt-account-id"]).toBeUndefined();
	});
});
