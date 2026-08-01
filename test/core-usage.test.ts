import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUsageReport } from "../src/core/usage.js";

function sandbox(auth: unknown, failoverState?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-usage-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
	if (failoverState !== undefined) {
		writeFileSync(join(dir, "provider-failover-state.json"), JSON.stringify(failoverState));
	}
	return dir;
}

const ctx = (agentDir: string) => ({ env: {} as NodeJS.ProcessEnv, agentDir });

describe("usage dashboard", () => {
	it("reports API-key subscriptions that have no accounts array", async () => {
		// alibaba-token-plan and opencode-go are single-credential API-key
		// providers. Requiring an `accounts` array hid them entirely, so a
		// configured subscription was invisible to the command meant to list it.
		const dir = sandbox({
			"opencode-go": { type: "api_key", key: "sk-x" },
			"alibaba-token-plan": { type: "api_key", key: "sk-y" },
		});

		const report = await buildUsageReport([], ctx(dir));

		expect(report).toContain("opencode-go");
		expect(report).toContain("alibaba-token-plan");
		expect(report).toContain("API key");
	});

	it("reports single-account OAuth subscriptions", async () => {
		const dir = sandbox({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } });

		expect(await buildUsageReport([], ctx(dir))).toContain("anthropic");
	});

	it("counts available accounts for stock multi-account pools", async () => {
		const dir = sandbox({
			"claude-agent-sdk": {
				type: "oauth",
				accounts: [
					{ name: "default" },
					{ name: "second", blockedUntil: Date.now() + 60_000, blockReason: "rate_limit" },
				],
			},
		});

		expect(await buildUsageReport([], ctx(dir))).toContain("1/2 accounts available");
	});

	it("prefers quota detail over a bare credential for the same provider", async () => {
		// openai-codex appears in both auth.json and the failover state; listing
		// both produced a duplicate row for one subscription.
		const dir = sandbox(
			{ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } },
			{ usageByProvider: { "openai-codex": { plan: "pro", primary: { usedPercent: 28 } } } },
		);

		const report = await buildUsageReport([], ctx(dir));
		const codexLines = report.split("\n").filter((line) => line.includes("openai-codex"));

		expect(codexLines).toHaveLength(1);
		expect(codexLines[0]).toContain("72% remaining");
	});

	it("says so when nothing is configured", async () => {
		expect(await buildUsageReport([], ctx(sandbox({})))).toContain("No subscriptions found");
	});

	it("ignores a malformed failover state instead of failing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-usage-"));
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api_key", key: "k" } }));
		writeFileSync(join(dir, "provider-failover-state.json"), "{not json");

		expect(await buildUsageReport([], ctx(dir))).toContain("opencode-go");
	});

	it("lists an addon provider that has no account pool, rather than hiding it", async () => {
		// A single-credential addon provider (tokenrouter) produces no per-account
		// lines, so filtering its auth.json row out as "addon-managed" would drop the
		// subscription from the dashboard entirely.
		const dir = sandbox({ tokenrouter: { type: "api_key", key: "sk-x" } });
		const poolless = { id: "tokenrouter", label: "TokenRouter", build: () => ({}) as never };

		expect(await buildUsageReport([poolless], ctx(dir))).toContain("tokenrouter");
	});
});
