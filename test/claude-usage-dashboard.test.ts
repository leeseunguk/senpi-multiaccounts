import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUsageReport } from "../src/core/usage.js";
import { claudeProviderPackage } from "../src/providers/claude/index.js";

/**
 * The reported defect: `/usage` printed `claude-agent-sdk  3/3 accounts
 * available` while one of those three accounts sat at 100% of its weekly
 * window. A slot count cannot answer "how much have I got left", which is the
 * one question the command exists for.
 */

const CLAUDE_SENTINEL = {
	type: "oauth",
	access: "claude-sdk-oauth-managed",
	refresh: "claude-sdk-oauth-managed",
	expires: 4_102_444_800_000,
};

function usageBody(fiveHour: number, weekly: number, scoped: number) {
	return {
		five_hour: { utilization: fiveHour, resets_at: "2026-08-01T13:39:59Z" },
		seven_day: { utilization: weekly, resets_at: "2026-08-06T07:59:59Z" },
		limits: [
			{
				kind: "weekly_scoped",
				percent: scoped,
				resets_at: "2026-08-06T08:00:00Z",
				scope: { model: { display_name: "Fable" } },
			},
		],
	};
}

function sandbox(pool: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-claude-usage-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "claude-agent-sdk": pool }));
	return dir;
}

const ctx = (agentDir: string) => ({ env: {} as NodeJS.ProcessEnv, agentDir });

const THREE_SLOTS = {
	...CLAUDE_SENTINEL,
	accounts: [
		{ name: "default", access: "a1", refresh: "r1", expires: Date.now() + 3_600_000, source: "login" },
		{ name: "jgplabs", access: "a2", refresh: "r2", expires: Date.now() + 3_600_000, source: "login" },
		{ name: "jgplabs01", access: "a3", refresh: "r3", expires: Date.now() + 3_600_000, source: "login" },
	],
};

const LIVE_NUMBERS: Record<string, ReturnType<typeof usageBody>> = {
	a1: usageBody(7, 38, 51),
	a2: usageBody(0, 7, 4),
	a3: usageBody(14, 100, 100),
};

function fetchUsageFor(token: string) {
	const body = LIVE_NUMBERS[token];
	if (!body) throw new Error(`no fixture for ${token}`);
	return Promise.resolve(
		import("../src/providers/claude/usage.js").then(({ parseClaudeUsage }) => parseClaudeUsage(body)),
	).then((value) => value);
}

describe("claude per-account usage in the dashboard", () => {
	it("renders every metered window per account instead of a slot count", async () => {
		const dir = sandbox(THREE_SLOTS);
		const pkg = claudeProviderPackage({ fetchUsage: fetchUsageFor as never });

		const report = await buildUsageReport([pkg], ctx(dir));

		expect(report).not.toContain("3/3 accounts available");
		expect(report).toContain("default");
		expect(report).toContain("7% 5h");
		expect(report).toContain("38% week");
		expect(report).toContain("51% Fable");
	});

	it("shows the exhausted account's 100% weekly window rather than 'available'", async () => {
		const dir = sandbox(THREE_SLOTS);
		const pkg = claudeProviderPackage({ fetchUsage: fetchUsageFor as never });

		const line = (await buildUsageReport([pkg], ctx(dir)))
			.split("\n")
			.find((candidate) => candidate.includes("jgplabs01"));

		expect(line).toContain("100% week");
	});

	it("falls back to the slot state when the usage endpoint is unreachable", async () => {
		const dir = sandbox(THREE_SLOTS);
		const pkg = claudeProviderPackage({
			fetchUsage: (() => Promise.reject(new Error("offline"))) as never,
		});

		const report = await buildUsageReport([pkg], ctx(dir));

		expect(report).toContain("claude-agent-sdk");
		expect(report).toContain("available");
	});

	it("skips the pool entirely when stock has no claude credential", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-claude-empty-"));
		writeFileSync(join(dir, "auth.json"), JSON.stringify({}));
		const pkg = claudeProviderPackage({ fetchUsage: fetchUsageFor as never });

		expect(pkg.enabled?.({} as NodeJS.ProcessEnv, ctx(dir))).toMatch(/no claude-agent-sdk credential/);
	});

	/**
	 * Anthropic rotates the refresh token on every exchange, so a refresh that
	 * is not written back leaves stock senpi holding a token the server has
	 * already retired — it would lose the account on its next real request.
	 */
	it("persists a rotated token pair without disturbing stock's sentinel fields", async () => {
		const dir = sandbox({
			...THREE_SLOTS,
			accounts: [{ name: "default", access: "old", refresh: "old-r", expires: 1, source: "login" }],
		});
		const pkg = claudeProviderPackage({
			fetchUsage: (async () => ({ windows: [] })) as never,
			refresh: (async () => ({ access: "new", refresh: "new-r", expires: 9_999_999_999_999 })) as never,
		});

		await pkg.accountUsageDetail?.(ctx(dir));

		const stored = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))["claude-agent-sdk"];
		expect(stored.accounts[0]).toMatchObject({ access: "new", refresh: "new-r" });
		expect(stored.access).toBe("claude-sdk-oauth-managed");
		expect(stored.expires).toBe(4_102_444_800_000);
	});
});
