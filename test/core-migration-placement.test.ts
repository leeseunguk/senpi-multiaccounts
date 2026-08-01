import { describe, expect, it } from "vitest";
import { type AccountPoolState, type AccountSlot, blockAccount, removeAccount } from "../src/core/accounts.js";
import { conversationKey, PermanentRebindRefused, placeRequest } from "../src/core/affinity.js";

function slot(name: string): AccountSlot {
	return { name, access: `${name}-a`, refresh: `${name}-r`, expires: Number.MAX_SAFE_INTEGER, source: "login" };
}

function pool(names: string[], extra: Partial<AccountPoolState> = {}): AccountPoolState {
	return { accounts: names.map(slot), ...extra };
}

function blockOne(state: AccountPoolState, name: string, now: number): AccountPoolState {
	return {
		...state,
		accounts: state.accounts.map((account) =>
			account.name === name ? blockAccount(account, "rate_limit", { now, retryAfterMs: 60_000 }) : account,
		),
	};
}

describe("detour versus permanent rebind", () => {
	const key = conversationKey("build me a parser");

	it("reports a temporary block as a detour and keeps the binding", () => {
		const t0 = 1_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"]), { key, now: t0 });
		const home = first.account.name;
		const detour = placeRequest(blockOne(first.state, home, t0), { key, now: t0 + 1 });
		console.log(
			`detour: served=${detour.account.name} placement=${detour.placement} binding=${detour.state.bindings?.[key]}`,
		);
		expect(detour.placement).toBe("detour");
		expect(detour.state.bindings?.[key]).toBe(home);
		expect(detour.account.name).not.toBe(home);
	});

	it("reports an account that left the pool as a permanent rebind", () => {
		const t0 = 2_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"]), { key, now: t0 });
		const home = first.account.name;
		const rebound = placeRequest(removeAccount(first.state, home), { key, now: t0 + 1 });
		console.log(
			`rebind: served=${rebound.account.name} placement=${rebound.placement} binding=${rebound.state.bindings?.[key]}`,
		);
		expect(rebound.placement).toBe("permanent-rebind");
		expect(rebound.state.bindings?.[key]).toBe(rebound.account.name);
		expect(rebound.account.name).not.toBe(home);
	});

	it("reports a first placement as cold, not a rebind", () => {
		const cold = placeRequest(pool(["acc-a", "acc-b"]), { key: conversationKey("brand new"), now: 3_000_000 });
		console.log(`cold: placement=${cold.placement}`);
		expect(cold.placement).toBe("cold");
	});

	it("reports a warm reuse as an affinity hit", () => {
		const t0 = 4_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b"]), { key, now: t0 });
		const again = placeRequest(first.state, { key, now: t0 + 1 });
		expect(again.placement).toBe("affinity-hit");
		expect(again.reusedBinding).toBe(true);
	});
});

describe("migration policy gates the permanent rebind", () => {
	const key = conversationKey("policy gated conversation");

	it("refuses the permanent rebind under policy never", () => {
		const t0 = 5_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "never" }), { key, now: t0 });
		const gone = removeAccount(first.state, first.account.name);
		let refused: unknown;
		try {
			placeRequest(gone, { key, now: t0 + 1 });
		} catch (error) {
			refused = error;
		}
		console.log(`never -> refused=${refused instanceof PermanentRebindRefused} msg=${(refused as Error)?.message}`);
		expect(refused).toBeInstanceOf(PermanentRebindRefused);
		expect((refused as Error).message).toContain(first.account.name);
	});

	it("still allows a detour under policy never, because a detour is reversible", () => {
		const t0 = 6_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "never" }), { key, now: t0 });
		const home = first.account.name;
		const detour = placeRequest(blockOne(first.state, home, t0), { key, now: t0 + 1 });
		console.log(`never+detour -> served=${detour.account.name} placement=${detour.placement}`);
		expect(detour.placement).toBe("detour");
		expect(detour.state.bindings?.[key]).toBe(home);
	});

	it("completes the rebind under policy ask and names the account it left", () => {
		const t0 = 7_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "ask" }), { key, now: t0 });
		const home = first.account.name;
		const rebound = placeRequest(removeAccount(first.state, home), { key, now: t0 + 1 });
		console.log(`ask -> served=${rebound.account.name} from=${rebound.migratedFrom}`);
		expect(rebound.placement).toBe("permanent-rebind");
		expect(rebound.migratedFrom).toBe(home);
		expect(rebound.account.name).not.toBe(home);
	});

	it("rebinds silently under policy auto, with no account to report", () => {
		const t0 = 8_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "auto" }), { key, now: t0 });
		const rebound = placeRequest(removeAccount(first.state, first.account.name), { key, now: t0 + 1 });
		console.log(`auto -> served=${rebound.account.name} migratedFrom=${rebound.migratedFrom}`);
		expect(rebound.placement).toBe("permanent-rebind");
		expect(rebound.migratedFrom).toBeUndefined();
	});

	it("refuses only when a binding actually existed, never on a cold placement", () => {
		const cold = placeRequest(pool(["acc-a", "acc-b"], { migration: "never" }), {
			key: conversationKey("never seen before"),
			now: 9_000_000,
		});
		console.log(`never+cold -> served=${cold.account.name} placement=${cold.placement}`);
		expect(cold.placement).toBe("cold");
	});
});
