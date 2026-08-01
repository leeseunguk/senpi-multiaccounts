import { describe, expect, it } from "vitest";
import { runAccountCommand } from "../src/core/account-command.js";
import { type AccountSlot, DEFAULT_MIGRATION_POLICY, MIGRATION_POLICIES } from "../src/core/accounts.js";
import { emptyPool } from "../src/core/store.js";

const slot = (name: string): AccountSlot => ({
	name,
	access: `a-${name}`,
	refresh: `r-${name}`,
	expires: Date.now() + 3_600_000,
	source: "login",
	meta: {},
});

function harness(names: string[], extra: Record<string, unknown> = {}) {
	let state = { ...emptyPool(), accounts: names.map(slot), ...extra };
	let writes = 0;
	return {
		get state() {
			return state;
		},
		get writes() {
			return writes;
		},
		deps: {
			providerId: "kiro",
			agentDir: "/tmp/acct-migrate-test",
			login: async (name: string) => slot(name),
			readPoolState: () => state as never,
			writePoolState: (_dir: string, _id: string, next: unknown) => {
				writes += 1;
				state = next as typeof state;
			},
		},
	};
}

describe("migration policy", () => {
	it("defaults to auto so existing behaviour is unchanged", () => {
		expect(DEFAULT_MIGRATION_POLICY).toBe("auto");
		expect(MIGRATION_POLICIES).toEqual(["auto", "ask", "never"]);
	});

	for (const policy of ["auto", "ask", "never"] as const) {
		it(`persists '${policy}' into the written pool state`, async () => {
			const h = harness(["alpha", "beta"]);
			const out = await runAccountCommand(h.deps as never, `migrate ${policy}`);
			console.log(`migrate ${policy} -> level=${out.level} text=${out.text}`);
			expect(out.level).toBe("info");
			expect(h.state.migration).toBe(policy);
		});
	}

	it("rejects an unknown policy and lists the valid ones without touching state", async () => {
		const h = harness(["alpha"], { migration: "ask" });
		const out = await runAccountCommand(h.deps as never, "migrate sometimes");
		console.log(`migrate sometimes -> level=${out.level} text=${out.text}`);
		expect(out.level).toBe("error");
		expect(out.text).toContain("auto|ask|never");
		expect(h.writes).toBe(0);
		expect(h.state.migration).toBe("ask");
	});

	it("rejects a bare migrate with no value", async () => {
		const h = harness(["alpha"]);
		const out = await runAccountCommand(h.deps as never, "migrate");
		expect(out.level).toBe("error");
		expect(h.writes).toBe(0);
	});

	it("is advertised in the command usage string", async () => {
		const h = harness(["alpha"]);
		const out = await runAccountCommand(h.deps as never, "definitely-not-a-subcommand");
		expect(out.text).toContain("migrate <auto|ask|never>");
	});

	it("reports the active policy in the list output", async () => {
		const h = harness(["alpha"], { migration: "never" });
		const out = await runAccountCommand(h.deps as never, "list");
		console.log(`list -> ${out.text.split("\n")[0]}`);
		expect(out.text).toContain("migration: never");
	});
});
