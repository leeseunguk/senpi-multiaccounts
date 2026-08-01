import { describe, expect, it, vi } from "vitest";
import type { AccountPoolState, AccountSlot } from "../src/core/accounts.js";
import { rendezvousOrder } from "../src/core/affinity.js";
import { AllAccountsBlockedError, type FailoverEvent, runWithFailover } from "../src/core/failover.js";
import { emptyPool } from "../src/core/store.js";

const KEY = "conversation-1";

function slot(name: string, overrides: Partial<AccountSlot> = {}): AccountSlot {
	return {
		name,
		access: `${name}-access`,
		refresh: `${name}-refresh`,
		expires: Number.MAX_SAFE_INTEGER,
		source: "login",
		...overrides,
	};
}

function pool(names: string[], overrides: Partial<AccountPoolState> = {}): AccountPoolState {
	return { accounts: names.map((name) => slot(name)), ...overrides };
}

function rateLimit(retryAfter?: string): Error & { status: number } {
	return Object.assign(new Error(retryAfter ? `Too Many Requests retry-after: ${retryAfter}` : "Too Many Requests"), {
		status: 429,
	});
}

/** Account cache-first placement will pick for a given key. */
function expectedFor(names: string[], key = KEY): string {
	return rendezvousOrder(key, names.map((name) => slot(name)))[0]!.name;
}

describe("failover", () => {
	it("returns the first success without touching other accounts", async () => {
		const attempt = vi.fn(async (account: AccountSlot) => `ok:${account.name}`);
		const result = await runWithFailover({ state: pool(["a", "b"]), key: KEY, attempt });

		expect(result.value).toBe(`ok:${expectedFor(["a", "b"])}`);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("moves to another account on 429 and succeeds there", async () => {
		const first = expectedFor(["a", "b"]);
		const attempt = vi.fn(async (account: AccountSlot) => {
			if (account.name === first) throw rateLimit();
			return `ok:${account.name}`;
		});
		const events: FailoverEvent[] = [];

		const result = await runWithFailover({
			state: pool(["a", "b"]),
			key: KEY,
			attempt,
			onFailover: (event) => events.push(event),
		});

		expect(result.value).not.toBe(`ok:${first}`);
		expect(attempt).toHaveBeenCalledTimes(2);
		expect(events).toHaveLength(1);
		expect(events[0]?.from.name).toBe(first);
		expect(events[0]?.to?.name).toBeDefined();
	});

	it("blocks the rate-limited account for the advertised window", async () => {
		const first = expectedFor(["a", "b"]);
		const result = await runWithFailover({
			state: pool(["a", "b"]),
			key: KEY,
			now: () => 1_000,
			attempt: async (account) => {
				if (account.name === first) throw rateLimit("30");
				return "ok";
			},
		});

		const blocked = result.state.accounts.find((account) => account.name === first);
		expect(blocked?.blockReason).toBe("rate_limit");
		expect(blocked?.blockedUntil).toBe(31_000);
	});

	it("blocks an auth failure until re-login rather than for a window", async () => {
		const first = expectedFor(["a", "b"]);
		const result = await runWithFailover({
			state: pool(["a", "b"]),
			key: KEY,
			attempt: async (account) => {
				if (account.name === first) throw Object.assign(new Error("Unauthorized"), { status: 401 });
				return "ok";
			},
		});

		const blocked = result.state.accounts.find((account) => account.name === first);
		expect(blocked?.blockReason).toBe("auth_error");
		expect(blocked?.blockedUntil).toBeUndefined();
	});

	it("surfaces client errors without burning another account", async () => {
		const attempt = vi.fn(async () => {
			throw Object.assign(new Error("invalid request schema"), { status: 400 });
		});

		await expect(runWithFailover({ state: pool(["a", "b"]), key: KEY, attempt })).rejects.toThrow(
			/invalid request schema/,
		);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("rethrows the upstream failure when every account is exhausted", async () => {
		const attempt = vi.fn(async () => {
			throw rateLimit();
		});

		await expect(runWithFailover({ state: pool(["a", "b"]), key: KEY, attempt })).rejects.toThrow(
			/Too Many Requests/,
		);
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it("refreshes an expired token before using the account", async () => {
		const refresh = vi.fn(async (account: AccountSlot) => ({
			...account,
			access: "fresh",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		const seen: string[] = [];

		const result = await runWithFailover({
			state: { accounts: [slot("solo", { expires: 0 })] },
			key: KEY,
			refresh,
			attempt: async (account) => {
				seen.push(account.access);
				return "ok";
			},
		});

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(seen).toEqual(["fresh"]);
		expect(result.state.accounts[0]?.access).toBe("fresh");
	});

	it("fails over when a token refresh fails", async () => {
		const stale = expectedFor(["a", "b"]);
		const state: AccountPoolState = {
			accounts: ["a", "b"].map((name) => slot(name, name === stale ? { expires: 0 } : {})),
		};

		const result = await runWithFailover({
			state,
			key: KEY,
			refresh: async (account) => {
				if (account.name === stale) throw new Error("refresh token revoked");
				return account;
			},
			attempt: async (account) => `ok:${account.name}`,
		});

		expect(result.value).not.toBe(`ok:${stale}`);
		expect(result.state.accounts.find((account) => account.name === stale)?.blockReason).toBe("auth_error");
	});

	it("skips an already-blocked account and uses the healthy one", async () => {
		const attempt = vi.fn(async (account: AccountSlot) => `ok:${account.name}`);
		const state: AccountPoolState = {
			accounts: [slot("a", { blockedUntil: 10_000, blockReason: "rate_limit" }), slot("b")],
		};

		const result = await runWithFailover({ state, key: KEY, attempt, now: () => 0 });

		expect(result.value).toBe("ok:b");
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("retries a previously blocked account once its window passes", async () => {
		const state: AccountPoolState = {
			accounts: [slot("a", { blockedUntil: 1_000, blockReason: "rate_limit" })],
		};

		const result = await runWithFailover({
			state,
			key: KEY,
			now: () => 2_000,
			attempt: async (account) => `ok:${account.name}`,
		});

		expect(result.value).toBe("ok:a");
	});
});

describe("senpi cooldown alignment", () => {
	it("carries retryAfterMs so senpi suppresses the model for exactly as long as the pool is down", async () => {
		const state: AccountPoolState = {
			accounts: [
				slot("a", { blockedUntil: 9_000, blockReason: "rate_limit" }),
				slot("b", { blockedUntil: 3_000, blockReason: "rate_limit" }),
			],
		};

		const error = await runWithFailover({
			state,
			key: KEY,
			now: () => 1_000,
			attempt: async () => "unused",
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AllAccountsBlockedError);
		// Earliest unblock is 3_000 and now is 1_000, so senpi must wait 2s —
		// not its default 30-minute quota bucket.
		expect((error as AllAccountsBlockedError).retryAfterMs).toBe(2_000);
		expect((error as AllAccountsBlockedError).retryAt).toBe(3_000);
	});

	it("omits retryAfterMs when accounts need re-login, since waiting cannot help", async () => {
		const state: AccountPoolState = { accounts: [slot("a", { blockReason: "auth_error" })] };

		const error = await runWithFailover({
			state,
			key: KEY,
			attempt: async () => "unused",
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AllAccountsBlockedError);
		expect((error as AllAccountsBlockedError).retryAfterMs).toBeUndefined();
	});
});

describe("committed turns are not replayed", () => {
	it("blocks the account but does not retry once output has streamed", async () => {
		// Both providers tag a post-output failure with `committed`. Retrying it on
		// another account would emit the partial text twice.
		const state = {
			...emptyPool(),
			accounts: [
				{ name: "alpha", access: "a", refresh: "r", expires: Date.now() + 3.6e6, source: "login" as const, meta: {} },
				{ name: "bravo", access: "b", refresh: "r", expires: Date.now() + 3.6e6, source: "login" as const, meta: {} },
			],
		};
		const attempted: string[] = [];

		await expect(
			runWithFailover({
				state: state as never,
				key: "c-committed",
				attempt: async (account) => {
					attempted.push(account.name);
					throw Object.assign(new Error("429 rate limit"), { committed: true });
				},
			}),
		).rejects.toThrow(/rate limit/);

		// Exactly one attempt: no replay onto the second account.
		expect(attempted).toHaveLength(1);
	});

	it("still retries when nothing had streamed yet", async () => {
		const state = {
			...emptyPool(),
			accounts: [
				{ name: "alpha", access: "a", refresh: "r", expires: Date.now() + 3.6e6, source: "login" as const, meta: {} },
				{ name: "bravo", access: "b", refresh: "r", expires: Date.now() + 3.6e6, source: "login" as const, meta: {} },
			],
		};
		const attempted: string[] = [];
		let first = true;

		const result = await runWithFailover({
			state: state as never,
			key: "c-uncommitted",
			attempt: async (account) => {
				attempted.push(account.name);
				if (first) {
					first = false;
					throw new Error("429 rate limit");
				}
				return "ok";
			},
		});

		expect(result.value).toBe("ok");
		expect(attempted).toHaveLength(2);
	});
});
