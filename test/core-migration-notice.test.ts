import { describe, expect, it } from "vitest";
import { type AccountPoolState, type AccountSlot, removeAccount } from "../src/core/accounts.js";
import { conversationKey, placeRequest } from "../src/core/affinity.js";
import { type MigrationNotice, runWithFailover } from "../src/core/failover.js";

function slot(name: string): AccountSlot {
	return { name, access: `${name}-a`, refresh: `${name}-r`, expires: Number.MAX_SAFE_INTEGER, source: "login" };
}

function pool(names: string[], extra: Partial<AccountPoolState> = {}): AccountPoolState {
	return { accounts: names.map(slot), ...extra };
}

const key = conversationKey("notice wiring conversation");

async function runOnce(state: AccountPoolState) {
	const notices: MigrationNotice[] = [];
	const result = await runWithFailover({
		state,
		key,
		attempt: async (account) => `ok:${account.name}`,
		onMigration: (notice) => notices.push(notice),
	});
	return { notices, result };
}

describe("permanent-rebind notice reaches the caller", () => {
	it("reports the account left behind under policy ask", async () => {
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "ask" }), { key });
		const home = first.account.name;
		const { notices, result } = await runOnce(removeAccount(first.state, home));
		console.log(`ask -> notices=${JSON.stringify(notices)} served=${result.account.name}`);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.from).toBe(home);
		expect(notices[0]?.to).toBe(result.account.name);
		expect(result.value).toBe(`ok:${result.account.name}`);
	});

	it("stays silent under policy auto", async () => {
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "auto" }), { key });
		const { notices, result } = await runOnce(removeAccount(first.state, first.account.name));
		console.log(`auto -> notices=${notices.length} served=${result.account.name}`);
		expect(notices).toHaveLength(0);
	});

	it("stays silent on a reversible detour even under policy ask", async () => {
		const t0 = 1_000_000;
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "ask" }), { key, now: t0 });
		const home = first.account.name;
		const notices: MigrationNotice[] = [];
		const result = await runWithFailover({
			state: first.state,
			key,
			now: () => t0,
			attempt: async (account) => {
				if (account.name === home) {
					throw Object.assign(new Error("429 too many requests, retry-after: 60"), { status: 429 });
				}
				return `ok:${account.name}`;
			},
			onMigration: (notice) => notices.push(notice),
		});
		console.log(`ask+detour -> notices=${notices.length} served=${result.account.name}`);
		expect(result.account.name).not.toBe(home);
		expect(notices).toHaveLength(0);
	});
});
