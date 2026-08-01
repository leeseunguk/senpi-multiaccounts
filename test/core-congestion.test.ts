import { describe, expect, it, vi } from "vitest";
import { type AccountPoolState, type AccountSlot, blockAccount, isBlocked } from "../src/core/accounts.js";
import { conversationKey } from "../src/core/affinity.js";
import { classifyFailure } from "../src/core/failure.js";
import { AllAccountsBlockedError, runWithFailover } from "../src/core/failover.js";

const HIGH_LOAD = "Encountered unexpectedly high load when processing the request, please try again.";

function slot(name: string, over: Partial<AccountSlot> = {}): AccountSlot {
	return { name, access: `${name}-a`, refresh: `${name}-r`, expires: Number.MAX_SAFE_INTEGER, source: "login", ...over };
}
function pool(names: string[], extra: Partial<AccountPoolState> = {}): AccountPoolState {
	return { accounts: names.map((n) => slot(n)), ...extra };
}

describe("P1: backend congestion is transient, not an account fault", () => {
	it("classifies the literal Kiro high-load string as transient with a retry delay", () => {
		const c = classifyFailure(new Error(HIGH_LOAD));
		console.log(`classify(high load) -> ${JSON.stringify(c)}`);
		expect(c.transient).toBe(true);
		expect(c.block).toBeUndefined();
		expect(c.failover).toBe(true);
		expect(typeof c.retryAfterMs).toBe("number");
	});

	it("still blocks a genuine HTTP 500 immediately", () => {
		const c = classifyFailure(Object.assign(new Error("internal server error"), { status: 500 }));
		console.log(`classify(500) -> ${JSON.stringify(c)}`);
		expect(c.block).toBe("server_error");
		expect(c.transient).not.toBe(true);
	});

	it("retries the SAME account after a congestion hiccup, leaving it unblocked", async () => {
		const key = conversationKey("warm conversation");
		const seen: string[] = [];
		const sleeps: number[] = [];
		let calls = 0;
		const result = await runWithFailover({
			state: pool(["acc-a", "acc-b", "acc-c"]),
			key,
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
			attempt: async (account) => {
				seen.push(account.name);
				calls += 1;
				if (calls === 1) throw new Error(HIGH_LOAD);
				return `ok:${account.name}`;
			},
		});
		console.log(`attempts=${JSON.stringify(seen)} sleeps=${JSON.stringify(sleeps)} served=${result.account.name}`);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
		expect(result.value).toBe(`ok:${seen[0]}`);
		expect(sleeps).toHaveLength(1);
		expect(result.state.accounts.every((a) => !isBlocked(a, Date.now()))).toBe(true);
		expect(result.state.bindings?.[key]).toBe(seen[0]);
	});

	it("escalates to a real block after repeated congestion on one account", async () => {
		const key = conversationKey("persistent congestion");
		const seen: string[] = [];
		const result = await runWithFailover({
			state: pool(["acc-a", "acc-b", "acc-c"]),
			key,
			sleep: async () => undefined,
			attempt: async (account) => {
				seen.push(account.name);
				if (account.name === seen[0]) throw new Error(HIGH_LOAD);
				return `ok:${account.name}`;
			},
		});
		const home = seen[0] as string;
		const blocked = result.state.accounts.find((a) => a.name === home);
		console.log(`home=${home} attempts=${JSON.stringify(seen)} homeBlocked=${blocked?.blockReason} served=${result.account.name}`);
		expect(seen.filter((n) => n === home).length).toBeGreaterThanOrEqual(2);
		expect(blocked?.blockReason).toBe("server_error");
		expect(result.account.name).not.toBe(home);
	});

	it("does not wipe out the pool when every account is congested", async () => {
		const state = pool(["acc-a", "acc-b", "acc-c"]);
		let persisted: AccountPoolState = state;
		let failure: unknown;
		try {
			await runWithFailover({
				state,
				key: conversationKey("all congested"),
				sleep: async () => undefined,
				onStateChange: (next) => {
					persisted = next;
				},
				attempt: async () => {
					throw new Error(HIGH_LOAD);
				},
			});
		} catch (error) {
			failure = error;
		}
		const now = Date.now();
		const blocked = persisted.accounts.filter((a) => isBlocked(a, now)).map((a) => a.name);
		const free = persisted.accounts.filter((a) => !isBlocked(a, now)).map((a) => a.name);
		console.log(`all congested -> blocked=${JSON.stringify(blocked)} free=${JSON.stringify(free)}`);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/high load|congest/i);
		// Blocking every account over the upstream's own load is the incident. The
		// next request must still have somewhere to go, so at least one account
		// stays selectable however long the congestion lasts.
		expect(free.length).toBeGreaterThanOrEqual(1);
	});

	it("leaves a single-account pool selectable under sustained congestion", async () => {
		const state = pool(["only-one"]);
		let persisted: AccountPoolState = state;
		try {
			await runWithFailover({
				state,
				key: conversationKey("single account congestion"),
				sleep: async () => undefined,
				onStateChange: (next) => {
					persisted = next;
				},
				attempt: async () => {
					throw new Error(HIGH_LOAD);
				},
			});
		} catch {
			/* expected: the request fails, the account does not */
		}
		const solo = persisted.accounts.find((a) => a.name === "only-one") as AccountSlot;
		console.log(`single account -> blockReason=${solo.blockReason} blockedUntil=${solo.blockedUntil}`);
		expect(isBlocked(solo, Date.now())).toBe(false);
	});
});

describe("P2: the block window actually grows across requests", () => {
	const key = conversationKey("backoff conversation");
	async function failOnce(state: AccountPoolState, now: number) {
		try {
			await runWithFailover({
				state,
				key,
				now: () => now,
				sleep: async () => undefined,
				maxAttempts: 1,
				attempt: async () => {
					throw Object.assign(new Error("internal server error"), { status: 500 });
				},
			});
		} catch {
			/* expected */
		}
		return state;
	}

	it("doubles the window on consecutive failures and resets after a success", async () => {
		const windows: number[] = [];
		let state = pool(["solo"]);
		const t0 = 1_000_000;
		for (let round = 0; round < 3; round++) {
			const now = t0 + round * 10_000_000;
			let captured: AccountPoolState = state;
			try {
				await runWithFailover({
					state,
					key,
					now: () => now,
					sleep: async () => undefined,
					maxAttempts: 1,
					onStateChange: (next) => {
						captured = next;
					},
					attempt: async () => {
						throw Object.assign(new Error("internal server error"), { status: 500 });
					},
				});
			} catch {
				/* expected */
			}
			const solo = captured.accounts.find((a) => a.name === "solo");
			windows.push((solo?.blockedUntil ?? now) - now);
			state = { ...captured, accounts: captured.accounts.map((a) => ({ ...a, blockedUntil: undefined, blockReason: undefined })) };
		}
		console.log(`windows(ms)=${JSON.stringify(windows)}`);
		expect(windows[0]).toBe(60_000);
		expect(windows[1]).toBe(120_000);
		expect(windows[2]).toBe(240_000);

		const after = await runWithFailover({
			state,
			key,
			now: () => t0 + 99_000_000,
			sleep: async () => undefined,
			attempt: async (account) => `ok:${account.name}`,
		});
		const reset = after.state.accounts.find((a) => a.name === "solo");
		console.log(`after success consecutiveFailures=${reset?.consecutiveFailures}`);
		expect(reset?.consecutiveFailures ?? 0).toBe(0);
	});
});

describe("P3: the all-blocked error explains itself", () => {
	it("names the reason, the earliest retry and rules quota out", async () => {
		const now = 5_000_000;
		const state: AccountPoolState = {
			accounts: [
				blockAccount(slot("acc-a"), "server_error", { now, retryAfterMs: 47_000 }),
				blockAccount(slot("acc-b"), "server_error", { now, retryAfterMs: 90_000 }),
			],
		};
		let failure: unknown;
		try {
			await runWithFailover({
				state,
				key: conversationKey("blocked pool"),
				now: () => now,
				sleep: async () => undefined,
				attempt: async () => "never reached",
			});
		} catch (error) {
			failure = error;
		}
		const message = (failure as Error).message;
		console.log(`error -> ${message}`);
		expect(failure).toBeInstanceOf(AllAccountsBlockedError);
		expect(message).toContain("server_error");
		expect(message).toMatch(/47s|47 s/);
		expect(message).toMatch(/quota is not/i);
	});
});
