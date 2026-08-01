import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AccountSlot, blockAccount } from "../src/core/accounts.js";
import { writePool } from "../src/core/store.js";
import type { ProviderPackage } from "../src/core/types.js";
import { buildUsageReport } from "../src/core/usage.js";

const slot = (name: string): AccountSlot => ({
	name,
	access: `${name}-a`,
	refresh: `${name}-r`,
	expires: Number.MAX_SAFE_INTEGER,
	source: "login",
	meta: {},
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-accounts-usage-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function kiroPackage(): ProviderPackage {
	return {
		id: "kiro",
		label: "Kiro",
		build: () => ({ name: "Kiro", apiKey: "x" }),
		accountUsage: async () => ({ calm: 0.6, congested: 0.6 }),
	};
}

describe("P4: a timed block says why", () => {
	it("reports the block reason next to the remaining seconds", async () => {
		const now = Date.now();
		writePool(dir, "kiro", {
			accounts: [slot("calm"), blockAccount(slot("congested"), "server_error", { now, retryAfterMs: 47_000 })],
		});
		const report = await buildUsageReport([kiroPackage()], { env: {} as NodeJS.ProcessEnv, agentDir: dir });
		console.log(report);
		expect(report).toMatch(/congested: 60% remaining, blocked \d+s \(server_error\)/);
		expect(report).toContain("calm: 60% remaining, available");
	});
});
