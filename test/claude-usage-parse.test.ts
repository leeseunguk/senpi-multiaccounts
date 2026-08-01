import { describe, expect, it, vi } from "vitest";
import { parseClaudeUsage } from "../src/providers/claude/usage.js";
import { formatUsage, headroomOf } from "../src/core/usage-window.js";

/**
 * Captured verbatim from `https://api.anthropic.com/api/oauth/usage` on a live
 * Claude Max account. The scoped weekly window carries its display name in
 * `limits[].scope.model.display_name`, which is a product decision that moves
 * (Opus -> Fable), so the label must be read from the payload, never hardcoded.
 */
const LIVE_RESPONSE = {
	five_hour: { utilization: 7.0, resets_at: "2026-08-01T13:39:59.099247+00:00" },
	seven_day: { utilization: 38.0, resets_at: "2026-08-06T07:59:59.099266+00:00" },
	seven_day_opus: null,
	limits: [
		{ kind: "session", group: "session", percent: 7, resets_at: "2026-08-01T13:39:59.099247+00:00", scope: null },
		{ kind: "weekly_all", group: "weekly", percent: 38, resets_at: "2026-08-06T07:59:59.099266+00:00", scope: null },
		{
			kind: "weekly_scoped",
			group: "weekly",
			percent: 51,
			resets_at: "2026-08-06T08:00:00.099610+00:00",
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
	],
};

describe("claude usage parsing", () => {
	it("reads all three metered windows", () => {
		const usage = parseClaudeUsage(LIVE_RESPONSE);

		expect(usage.windows.map((window) => window.label)).toEqual(["5h", "week", "Fable"]);
		expect(usage.windows.map((window) => window.usedFraction)).toEqual([0.07, 0.38, 0.51]);
	});

	it("labels the scoped window from the payload rather than a hardcoded model name", () => {
		const renamed = {
			...LIVE_RESPONSE,
			limits: LIVE_RESPONSE.limits.map((limit) =>
				limit.kind === "weekly_scoped" ? { ...limit, scope: { model: { display_name: "Opus" } } } : limit,
			),
		};

		expect(parseClaudeUsage(renamed).windows.at(-1)?.label).toBe("Opus");
	});

	// The exhausted account that read as plain "available" before this work.
	it("reports zero headroom when any single window is spent", () => {
		const exhausted = parseClaudeUsage({
			five_hour: { utilization: 14 },
			seven_day: { utilization: 100 },
			limits: [],
		});

		expect(headroomOf(exhausted)).toBe(0);
	});

	it("takes headroom from the tightest window, not the average", () => {
		const usage = parseClaudeUsage(LIVE_RESPONSE);

		expect(headroomOf(usage)).toBeCloseTo(0.49, 5);
	});

	it("returns no windows rather than throwing on an empty payload", () => {
		expect(parseClaudeUsage({}).windows).toEqual([]);
		expect(headroomOf(parseClaudeUsage({}))).toBeUndefined();
	});

	it("renders each window with its time to reset", () => {
		const now = Date.parse("2026-08-01T09:32:59.000Z");

		expect(formatUsage(parseClaudeUsage(LIVE_RESPONSE), now)).toBe("7% 5h 4h 7m · 38% week 4d 22h · 51% Fable 4d 22h");
	});
});

describe("claude usage fetch", () => {
	it("sends the OAuth beta header the endpoint requires", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => LIVE_RESPONSE }));
		const { fetchClaudeUsage } = await import("../src/providers/claude/usage.js");

		await fetchClaudeUsage("token-x", fetchMock as never);

		const headers = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
		expect(headers.authorization).toBe("Bearer token-x");
		expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
	});

	it("raises with the status so a stale token is distinguishable from an outage", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
		const { fetchClaudeUsage, ClaudeUsageError } = await import("../src/providers/claude/usage.js");

		await expect(fetchClaudeUsage("stale", fetchMock as never)).rejects.toMatchObject({
			name: "ClaudeUsageError",
			status: 401,
		});
		await expect(fetchClaudeUsage("stale", fetchMock as never)).rejects.toBeInstanceOf(ClaudeUsageError);
	});
});
