import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountSlot } from "../src/core/accounts.js";
import { readPool, writePool } from "../src/core/store.js";
import { kiroProviderPackage } from "../src/providers/kiro/index.js";

const slot = (name: string): AccountSlot => ({
	name,
	access: `a-${name}`,
	refresh: `r-${name}`,
	expires: Number.MAX_SAFE_INTEGER,
	source: "login",
	meta: {},
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-accounts-roundtrip-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("migration policy survives a store round trip", () => {
	it("reads back what it wrote", () => {
		writePool(dir, "kiro", { accounts: [slot("alpha")], migration: "never" });
		expect(readPool(dir, "kiro").migration).toBe("never");
	});

	it("leaves migration unset when it was never chosen", () => {
		writePool(dir, "kiro", { accounts: [slot("alpha")] });
		expect(readPool(dir, "kiro").migration).toBeUndefined();
	});
});

describe("the /login kiro account manager preserves the migration policy", () => {
	it("does not erase a policy set through the account command", async () => {
		writePool(dir, "kiro", {
			accounts: [slot("alpha"), slot("beta")],
			migration: "never",
			mode: "cache-first",
			bindings: { "c-abc": "alpha" },
		});

		const config = await kiroProviderPackage().build({ env: {}, agentDir: dir });
		const login = config.oauth?.login;
		if (!login) throw new Error("kiro provider exposes no login flow");

		const stored = (await login({
			onAuth: () => undefined,
			onPrompt: async () => "alpha",
			onSelect: async () => "unpin",
		} as never)) as unknown as { migration?: string; mode?: string; bindings?: Record<string, string> };

		console.log(`after /login kiro -> migration=${stored.migration} mode=${stored.mode}`);
		expect(stored.migration).toBe("never");
		expect(stored.mode).toBe("cache-first");
	});
});
