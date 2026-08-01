import { describe, expect, it } from "vitest";
import { runAccountCommand } from "../src/core/account-command.js";
import type { AccountSlot } from "../src/core/accounts.js";
import { emptyPool } from "../src/core/store.js";

const slot = (name: string): AccountSlot => ({
	name,
	access: `a-${name}`,
	refresh: `r-${name}`,
	expires: Date.now() + 3_600_000,
	source: "login",
	meta: {},
});

/** Harness capturing what the command writes, so assertions see real state. */
function harness(names: string[], extra: Record<string, unknown> = {}) {
	let state = { ...emptyPool(), accounts: names.map(slot), ...extra };
	return {
		get state() {
			return state;
		},
		deps: {
			providerId: "kiro",
			agentDir: "/tmp/acct-test",
			login: async (name: string) => slot(name),
			readPoolState: () => state as never,
			writePoolState: (_dir: string, _id: string, next: unknown) => {
				state = next as typeof state;
			},
		},
	};
}

describe("per-account logout", () => {
	it("logs out one account and leaves the rest", async () => {
		const h = harness(["alpha", "bravo"]);

		const out = await runAccountCommand(h.deps as never, "logout alpha");

		expect(out.level).toBe("info");
		expect(h.state.accounts.map((a) => a.name)).toEqual(["bravo"]);
	});

	it("refuses to log out an account that does not exist", async () => {
		const h = harness(["alpha"]);

		const out = await runAccountCommand(h.deps as never, "logout nope");

		expect(out.level).toBe("error");
		expect(h.state.accounts).toHaveLength(1);
	});

	it("requires a target so a bare logout cannot wipe the pool by accident", async () => {
		const h = harness(["alpha", "bravo"]);

		const out = await runAccountCommand(h.deps as never, "logout");

		expect(out.level).toBe("error");
		expect(h.state.accounts).toHaveLength(2);
	});
});

describe("full logout", () => {
	it("empties the pool", async () => {
		const h = harness(["alpha", "bravo", "charlie"]);

		const out = await runAccountCommand(h.deps as never, "logout all");

		expect(out.text).toContain("3");
		expect(h.state.accounts).toEqual([]);
	});

	it("clears the pin and conversation bindings so nothing dangles", async () => {
		const h = harness(["alpha", "bravo"], { pinned: "alpha", bindings: { "c-1": "alpha" } });

		await runAccountCommand(h.deps as never, "logout all");

		expect(h.state.pinned).toBeUndefined();
		expect(h.state.bindings).toEqual({});
	});

	it("is a no-op on an empty pool", async () => {
		const h = harness([]);

		expect((await runAccountCommand(h.deps as never, "logout all")).level).toBe("info");
	});
});

describe("scheduling modes", () => {
	it.each(["cache-first", "balanced", "spread"])("accepts %s", async (mode) => {
		const h = harness(["alpha"]);

		const out = await runAccountCommand(h.deps as never, `mode ${mode}`);

		expect(out.level).toBe("info");
		expect(h.state.mode).toBe(mode);
	});

	it("rejects an unknown mode and lists the valid ones", async () => {
		const h = harness(["alpha"]);

		const out = await runAccountCommand(h.deps as never, "mode turbo");

		expect(out.level).toBe("error");
		expect(out.text).toContain("cache-first");
		expect(h.state.mode).toBeUndefined();
	});

	it("defaults to cache-first when no mode was ever set", () => {
		// The default lives in affinity.ts; the pool simply carries no override.
		expect(emptyPool().mode).toBeUndefined();
	});
});

describe("remove parity", () => {
	it("reports a missing account instead of silently succeeding", async () => {
		const h = harness(["alpha"]);

		expect((await runAccountCommand(h.deps as never, "remove ghost")).level).toBe("error");
	});
});
