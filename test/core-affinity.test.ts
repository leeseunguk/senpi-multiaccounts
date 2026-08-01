import { describe, expect, it } from "vitest";
import type { AccountPoolState, AccountSlot } from "../src/core/accounts.js";
import { NoAvailableAccountError } from "../src/core/accounts.js";
import { conversationKey, placeRequest, releaseBinding, rendezvousOrder } from "../src/core/affinity.js";

function slot(name: string, overrides: Partial<AccountSlot> = {}): AccountSlot {
	return {
		name,
		access: `${name}-a`,
		refresh: `${name}-r`,
		expires: Number.MAX_SAFE_INTEGER,
		source: "login",
		...overrides,
	};
}

function pool(names: string[], overrides: Partial<AccountPoolState> = {}): AccountPoolState {
	return { accounts: names.map((name) => slot(name)), ...overrides };
}

describe("conversation key", () => {
	it("is stable for the same first message", () => {
		expect(conversationKey("build me a parser")).toBe(conversationKey("build me a parser"));
	});

	it("ignores surrounding whitespace so retries do not rebind", () => {
		expect(conversationKey("  hello  ")).toBe(conversationKey("hello"));
	});

	it("differs across conversations", () => {
		expect(conversationKey("first task")).not.toBe(conversationKey("second task"));
	});

	it("falls back when there is no user text yet", () => {
		expect(conversationKey(undefined, "session-7")).toBe("session-7");
		expect(conversationKey(undefined)).toBe("default");
	});
});

describe("rendezvous ordering", () => {
	it("is deterministic for a key", () => {
		const accounts = ["a", "b", "c"].map((name) => slot(name));
		expect(rendezvousOrder("k", accounts).map((a) => a.name)).toEqual(
			rendezvousOrder("k", accounts).map((a) => a.name),
		);
	});

	it("keeps most conversations put when an account is added", () => {
		const before = ["a", "b", "c"].map((name) => slot(name));
		const after = [...before, slot("d")];
		const keys = Array.from({ length: 60 }, (_, i) => `conv-${i}`);

		const moved = keys.filter(
			(key) => rendezvousOrder(key, before)[0]!.name !== rendezvousOrder(key, after)[0]!.name,
		).length;

		// Only conversations that rendezvous with the new account should move;
		// a naive modulo scheme would reshuffle nearly all of them.
		expect(moved).toBeLessThan(keys.length / 2);
	});
});

describe("cache-first placement", () => {
	it("returns the same account for the same conversation", () => {
		const state = pool(["a", "b", "c"]);
		const first = placeRequest(state, { key: "conv" });
		const second = placeRequest(first.state, { key: "conv" });

		expect(second.account.name).toBe(first.account.name);
		expect(second.reusedBinding).toBe(true);
	});

	it("records the binding so a warm cache survives a restart", () => {
		const placement = placeRequest(pool(["a", "b"]), { key: "conv" });
		expect(placement.state.bindings?.conv).toBe(placement.account.name);
	});

	it("ignores quota so a warm conversation is never moved for headroom", () => {
		const state = pool(["a", "b"]);
		const first = placeRequest(state, { key: "conv", usage: { a: 1, b: 1 } });
		const starved = { [first.account.name]: 0.01 };
		const second = placeRequest(first.state, { key: "conv", usage: starved });

		expect(second.account.name).toBe(first.account.name);
	});

	it("places a blocked account's conversation elsewhere", () => {
		const first = placeRequest(pool(["a", "b"]), { key: "conv", now: 0 });
		const blocked: AccountPoolState = {
			...first.state,
			accounts: first.state.accounts.map((account) =>
				account.name === first.account.name
					? { ...account, blockedUntil: 10_000, blockReason: "rate_limit" as const }
					: account,
			),
		};

		expect(placeRequest(blocked, { key: "conv", now: 0 }).account.name).not.toBe(first.account.name);
	});
});

describe("balanced placement", () => {
	it("prefers the account with the most headroom for a new conversation", () => {
		const state = pool(["a", "b", "c"]);
		const placement = placeRequest(state, {
			key: "fresh",
			mode: "balanced",
			usage: { a: 0.05, b: 0.9, c: 0.1 },
			random: () => 0,
		});

		expect(placement.account.name).toBe("b");
	});

	it("still holds the binding once the conversation is placed", () => {
		const state = pool(["a", "b"]);
		const first = placeRequest(state, { key: "conv", mode: "balanced", usage: { a: 0.9, b: 0.1 }, random: () => 0 });
		const second = placeRequest(first.state, {
			key: "conv",
			mode: "balanced",
			usage: { a: 0.1, b: 0.9 },
			random: () => 0,
		});

		expect(second.account.name).toBe(first.account.name);
		expect(second.reusedBinding).toBe(true);
	});

	it("treats unknown headroom as plenty rather than starving the account", () => {
		const placement = placeRequest(pool(["known", "unknown"]), {
			key: "fresh",
			mode: "balanced",
			usage: { known: 0.2 },
			random: () => 0,
		});

		expect(placement.account.name).toBe("unknown");
	});
});

describe("spread placement", () => {
	it("round-robins across requests and ignores bindings", () => {
		let state = pool(["a", "b", "c"], { mode: "spread" });
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			const placement = placeRequest(state, { key: "same-conversation" });
			seen.push(placement.account.name);
			state = placement.state;
		}
		expect(seen).toEqual(["a", "b", "c", "a"]);
	});
});

describe("scheduling mode selection", () => {
	function distribution(mode: "cache-first" | "balanced" | "spread", usage: Record<string, number>) {
		let state = pool(["a", "b", "c"], { mode });
		const counts: Record<string, number> = {};
		let seed = 12_345;
		const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
		for (let i = 0; i < 300; i++) {
			const placement = placeRequest(state, { key: `conv-${i}`, usage, random });
			state = placement.state;
			counts[placement.account.name] = (counts[placement.account.name] ?? 0) + 1;
		}
		return counts;
	}

	// Three modes, three signatures over the same skewed headroom: `spread` is exactly
	// even, `balanced` starves the most-used account, `cache-first` hashes across all
	// three regardless of quota. Reading the pool's `mode` is what produces the
	// difference, so a placement that ignored it would collapse these into one.
	const usage = { a: 0.2, b: 0.6, c: 0.95 };

	it("spreads perfectly evenly in spread mode", () => {
		expect(distribution("spread", usage)).toEqual({ a: 100, b: 100, c: 100 });
	});

	it("skips the most-used account entirely in balanced mode", () => {
		const counts = distribution("balanced", usage);
		expect(counts.a).toBeUndefined();
		expect(counts.c ?? 0).toBeGreaterThan(counts.b ?? 0);
	});

	it("uses every account irrespective of quota in cache-first mode", () => {
		const counts = distribution("cache-first", usage);
		expect(Object.keys(counts).sort()).toEqual(["a", "b", "c"]);
	});

	it("gives each mode a distinct distribution, so the switch is not a no-op", () => {
		const signatures = (["cache-first", "balanced", "spread"] as const).map((mode) =>
			JSON.stringify(
				Object.entries(distribution(mode, usage))
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([name, count]) => `${name}=${count}`),
			),
		);
		expect(new Set(signatures).size).toBe(3);
	});
});

describe("pinning and exhaustion", () => {
	it("a pin overrides placement entirely", () => {
		const state = pool(["a", "b", "c"], { pinned: "c" });
		expect(placeRequest(state, { key: "anything", mode: "balanced", usage: { c: 0 } }).account.name).toBe("c");
	});

	it("falls off a pinned account that is blocked", () => {
		const state = pool(["a"], { pinned: "pinned" });
		state.accounts.push(slot("pinned", { blockedUntil: 10_000, blockReason: "rate_limit" }));
		expect(placeRequest(state, { key: "k", now: 0 }).account.name).toBe("a");
	});

	it("reports the earliest unblock time when everything is blocked", () => {
		const state: AccountPoolState = {
			accounts: [
				slot("a", { blockedUntil: 9_000, blockReason: "rate_limit" }),
				slot("b", { blockedUntil: 3_000, blockReason: "rate_limit" }),
			],
		};

		try {
			placeRequest(state, { key: "k", now: 0 });
			expect.unreachable("placement should fail when everything is blocked");
		} catch (error) {
			expect(error).toBeInstanceOf(NoAvailableAccountError);
			expect((error as NoAvailableAccountError).retryAt).toBe(3_000);
		}
	});

	it("releases a binding on demand", () => {
		const placed = placeRequest(pool(["a", "b"]), { key: "conv" });
		expect(releaseBinding(placed.state, "conv").bindings?.conv).toBeUndefined();
	});
});
