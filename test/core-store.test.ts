import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountSlot } from "../src/core/accounts.js";
import { readPool, SENTINEL, updatePool, writePool } from "../src/core/store.js";

const dirs: string[] = [];

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-accounts-store-"));
	dirs.push(dir);
	return dir;
}

function slot(name: string): AccountSlot {
	return { name, access: `${name}-a`, refresh: `${name}-r`, expires: 1, source: "login" };
}

afterEach(() => {
	// Restore permissions so the temp dirs remain removable by the OS.
	for (const dir of dirs.splice(0)) {
		try {
			chmodSync(dir, 0o700);
		} catch {
			// Directory may already be gone; nothing to restore.
		}
	}
});

describe("credential store", () => {
	it("returns an empty pool when auth.json does not exist", () => {
		expect(readPool(agentDir(), "kiro")).toEqual({ accounts: [] });
	});

	it("round-trips a pool", () => {
		const dir = agentDir();
		writePool(dir, "kiro", { accounts: [slot("jgplabs")], pinned: "jgplabs", strategy: "rotate", cursor: 2 });
		expect(readPool(dir, "kiro")).toEqual({
			accounts: [slot("jgplabs")],
			pinned: "jgplabs",
			strategy: "rotate",
			cursor: 2,
		});
	});

	it("writes the sentinel credential so senpi never refreshes the wrapper", () => {
		const dir = agentDir();
		writePool(dir, "kiro", { accounts: [slot("a")] });
		const stored = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).kiro;
		expect(stored.type).toBe("oauth");
		expect(stored.access).toBe(SENTINEL.access);
		expect(stored.expires).toBe(SENTINEL.expires);
	});

	it("preserves credentials owned by other providers", () => {
		const dir = agentDir();
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ anthropic: { type: "oauth", access: "keep-me", refresh: "r", expires: 5 } }),
		);
		writePool(dir, "kiro", { accounts: [slot("a")] });

		const data = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
		expect(data.anthropic.access).toBe("keep-me");
		expect(data.kiro.accounts).toHaveLength(1);
	});

	it("writes auth.json with owner-only permissions", () => {
		const dir = agentDir();
		writePool(dir, "kiro", { accounts: [slot("a")] });
		expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
	});

	it("refuses to clobber a corrupt auth.json", () => {
		const dir = agentDir();
		writeFileSync(join(dir, "auth.json"), "{ not json");
		expect(() => readPool(dir, "kiro")).toThrow(/Cannot parse/);
		expect(() => writePool(dir, "kiro", { accounts: [] })).toThrow(/Cannot parse/);
		expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe("{ not json");
	});

	it("ignores a non-pool entry rather than throwing", () => {
		const dir = agentDir();
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ kiro: { type: "api_key", key: "sk-x" } }));
		expect(readPool(dir, "kiro")).toEqual({ accounts: [] });
	});

	it("updates a pool in place", () => {
		const dir = agentDir();
		writePool(dir, "kiro", { accounts: [slot("a")] });
		const next = updatePool(dir, "kiro", (state) => ({ ...state, accounts: [...state.accounts, slot("b")] }));
		expect(next.accounts.map((account) => account.name)).toEqual(["a", "b"]);
		expect(readPool(dir, "kiro").accounts).toHaveLength(2);
	});
});
