import { describe, expect, it } from "vitest";
import {
	type AccountPoolState,
	type AccountSlot,
	addAccount,
	assertValidAccountName,
	blockAccount,
	clearExpiredBlocks,
	DEFAULT_BLOCK_MS,
	isBlocked,
	MAX_BLOCK_MS,
	NoAvailableAccountError,
	pinAccount,
	removeAccount,
	selectAccount,
	unblockAccount,
	unpinAccount,
} from "../src/core/accounts.js";

function slot(name: string, overrides: Partial<AccountSlot> = {}): AccountSlot {
	return {
		name,
		access: `${name}-access`,
		refresh: `${name}-refresh`,
		expires: 10_000,
		source: "login",
		...overrides,
	};
}

function pool(names: string[], overrides: Partial<AccountPoolState> = {}): AccountPoolState {
	return { accounts: names.map((name) => slot(name)), ...overrides };
}

describe("account names", () => {
	it("accepts the real account labels used for these subscriptions", () => {
		for (const name of ["jgp3620", "jgplabs", "jgplabs.01", "default", "a-b_c"]) {
			expect(() => assertValidAccountName(name)).not.toThrow();
		}
	});

	it("rejects names that would break command parsing", () => {
		for (const name of ["", " ", "-leading", ".leading", "has space", "a".repeat(65)]) {
			expect(() => assertValidAccountName(name)).toThrow(/Invalid account name/);
		}
	});
});

describe("pool mutation", () => {
	it("adds, removes, pins and unpins", () => {
		let state = pool([]);
		state = addAccount(state, slot("jgplabs"));
		state = addAccount(state, slot("jgp3620"));
		expect(state.accounts.map((a) => a.name)).toEqual(["jgplabs", "jgp3620"]);

		state = pinAccount(state, "jgp3620");
		expect(state.pinned).toBe("jgp3620");

		state = unpinAccount(state);
		expect(state.pinned).toBeUndefined();

		state = removeAccount(state, "jgplabs");
		expect(state.accounts.map((a) => a.name)).toEqual(["jgp3620"]);
	});

	it("rejects duplicate names", () => {
		const state = addAccount(pool([]), slot("jgplabs"));
		expect(() => addAccount(state, slot("jgplabs"))).toThrow(/already exists/);
	});

	it("drops the pin when the pinned account is removed", () => {
		const state = pinAccount(pool(["a", "b"]), "a");
		expect(removeAccount(state, "a").pinned).toBeUndefined();
	});

	it("refuses to pin an account that does not exist", () => {
		expect(() => pinAccount(pool(["a"]), "ghost")).toThrow(/does not exist/);
	});
});

describe("blocking and failback", () => {
	it("uses Retry-After when upstream supplies one", () => {
		const blocked = blockAccount(slot("a"), "rate_limit", { now: 1_000, retryAfterMs: 30_000 });
		expect(blocked.blockedUntil).toBe(31_000);
		expect(blocked.blockReason).toBe("rate_limit");
	});

	it("backs off exponentially when upstream supplies nothing", () => {
		const first = blockAccount(slot("a"), "rate_limit", { now: 0, attempt: 0 });
		const third = blockAccount(slot("a"), "rate_limit", { now: 0, attempt: 2 });
		expect(first.blockedUntil).toBe(DEFAULT_BLOCK_MS);
		expect(third.blockedUntil).toBe(DEFAULT_BLOCK_MS * 4);
	});

	it("caps any block at the maximum", () => {
		const huge = blockAccount(slot("a"), "rate_limit", { now: 0, retryAfterMs: MAX_BLOCK_MS * 10 });
		const deep = blockAccount(slot("a"), "rate_limit", { now: 0, attempt: 40 });
		expect(huge.blockedUntil).toBe(MAX_BLOCK_MS);
		expect(deep.blockedUntil).toBe(MAX_BLOCK_MS);
	});

	it("blocks auth errors until re-login, with no expiry", () => {
		const blocked = blockAccount(slot("a", { blockedUntil: 5 }), "auth_error");
		expect(blocked.blockReason).toBe("auth_error");
		expect(blocked.blockedUntil).toBeUndefined();
		expect(isBlocked(blocked, Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(isBlocked(unblockAccount(blocked))).toBe(false);
	});

	it("clears timed blocks once they expire but keeps auth blocks", () => {
		const accounts = [
			slot("expired", { blockedUntil: 100, blockReason: "rate_limit" }),
			slot("active", { blockedUntil: 10_000, blockReason: "rate_limit" }),
			slot("auth", { blockReason: "auth_error" }),
		];
		const cleared = clearExpiredBlocks(accounts, 5_000);
		expect(cleared[0]?.blockReason).toBeUndefined();
		expect(cleared[1]?.blockReason).toBe("rate_limit");
		expect(cleared[2]?.blockReason).toBe("auth_error");
	});
});

describe("selection", () => {
	it("fill-first drains one account before moving on", () => {
		const state = pool(["a", "b", "c"], { strategy: "fill-first" });
		expect(selectAccount(state, { now: 0 }).account.name).toBe("a");
		expect(selectAccount(state, { now: 0 }).account.name).toBe("a");
	});

	it("fill-first moves to the next account once the first is rate limited", () => {
		const state: AccountPoolState = {
			accounts: [slot("a", { blockedUntil: 10_000, blockReason: "rate_limit" }), slot("b"), slot("c")],
			strategy: "fill-first",
		};
		expect(selectAccount(state, { now: 0 }).account.name).toBe("b");
	});

	it("fails back to the first account after its block expires", () => {
		const state: AccountPoolState = {
			accounts: [slot("a", { blockedUntil: 1_000, blockReason: "rate_limit" }), slot("b")],
			strategy: "fill-first",
		};
		expect(selectAccount(state, { now: 500 }).account.name).toBe("b");
		expect(selectAccount(state, { now: 1_500 }).account.name).toBe("a");
	});

	it("rotate advances the cursor across calls", () => {
		let state = pool(["a", "b", "c"], { strategy: "rotate" });
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			const selection = selectAccount(state, { now: 0 });
			seen.push(selection.account.name);
			state = selection.state;
		}
		expect(seen).toEqual(["a", "b", "c", "a"]);
	});

	it("rotate skips blocked accounts", () => {
		let state: AccountPoolState = {
			accounts: [slot("a"), slot("b", { blockedUntil: 10_000, blockReason: "rate_limit" }), slot("c")],
			strategy: "rotate",
		};
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			const selection = selectAccount(state, { now: 0 });
			seen.push(selection.account.name);
			state = selection.state;
		}
		expect(seen).toEqual(["a", "c", "a", "c"]);
	});

	it("prefers the pinned account regardless of strategy", () => {
		const state = pool(["a", "b", "c"], { pinned: "c", strategy: "rotate" });
		expect(selectAccount(state, { now: 0 }).account.name).toBe("c");
	});

	it("falls back off a pinned account that is blocked", () => {
		const state: AccountPoolState = {
			accounts: [slot("a"), slot("pinned", { blockedUntil: 10_000, blockReason: "rate_limit" })],
			pinned: "pinned",
		};
		expect(selectAccount(state, { now: 0 }).account.name).toBe("a");
	});

	it("reports the earliest retry time when every account is blocked", () => {
		const state: AccountPoolState = {
			accounts: [
				slot("a", { blockedUntil: 9_000, blockReason: "rate_limit" }),
				slot("b", { blockedUntil: 3_000, blockReason: "rate_limit" }),
			],
		};
		try {
			selectAccount(state, { now: 0 });
			expect.unreachable("selection should fail when everything is blocked");
		} catch (error) {
			expect(error).toBeInstanceOf(NoAvailableAccountError);
			expect((error as NoAvailableAccountError).retryAt).toBe(3_000);
		}
	});

	it("reports an empty pool distinctly from a fully blocked pool", () => {
		try {
			selectAccount(pool([]));
			expect.unreachable("selection should fail on an empty pool");
		} catch (error) {
			expect(error).toBeInstanceOf(NoAvailableAccountError);
			expect((error as NoAvailableAccountError).retryAt).toBeUndefined();
		}
	});
});
