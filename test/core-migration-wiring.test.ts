import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type AccountPoolState, removeAccount } from "../src/core/accounts.js";
import { conversationKeyFor, placeRequest } from "../src/core/affinity.js";
import { createKiroStreamSimple } from "../src/providers/kiro/provider.js";

function pool(names: string[], extra: Partial<AccountPoolState> = {}): AccountPoolState {
	return {
		accounts: names.map((name) => ({
			name,
			access: `${name}-access-token`,
			refresh: `${name}-refresh-token`,
			expires: Number.MAX_SAFE_INTEGER,
			source: "login" as const,
		})),
		...extra,
	};
}

function model(): Model<Api> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-completions",
		provider: "kiro",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	} as Model<Api>;
}

function context(): Context {
	return { messages: [{ role: "user", content: "hold this conversation", timestamp: 1 }] } as unknown as Context;
}

const SESSION = "sess-wiring";

async function drive(state: AccountPoolState, onMigration: (providerId: string, notice: unknown) => void) {
	let saved = state;
	let used = "";
	const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-wiring", {
		readPoolState: () => saved,
		writePoolState: (_dir, _id, next) => {
			saved = next;
		},
		usage: { get: () => undefined, refresh: async () => ({}) },
		reportMigration: onMigration,
		createStream: ((_config: unknown, _runtime: unknown, _logger: unknown) =>
			(_m: unknown, _c: unknown, opts: { apiKey?: string }) => {
				used = String(opts?.apiKey).replace(/-access-token$/, "");
				return (async function* () {
					yield { type: "text_delta", delta: "ok" };
				})() as unknown as AssistantMessageEventStream;
			}) as never,
	});
	const iterable = streamSimple(model(), context(), { sessionId: SESSION } as never) as unknown as AsyncIterable<unknown>;
	for await (const _event of iterable) {
		/* drain */
	}
	return { used, state: saved };
}

describe("the Kiro provider reports a permanent rebind through the sink", () => {
	const key = conversationKeyFor({ sessionId: SESSION });

	it("reports under policy ask", async () => {
		const report = vi.fn();
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "ask" }), { key });
		const home = first.account.name;
		const after = await drive(removeAccount(first.state, home), report);
		console.log(`ask -> served=${after.used} report=${JSON.stringify(report.mock.calls[0] ?? null)}`);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0]?.[0]).toBe("kiro");
		expect(report.mock.calls[0]?.[1]).toEqual({ from: home, to: after.used });
	});

	it("stays silent under policy auto", async () => {
		const report = vi.fn();
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "auto" }), { key });
		const after = await drive(removeAccount(first.state, first.account.name), report);
		console.log(`auto -> served=${after.used} reports=${report.mock.calls.length}`);
		expect(report).not.toHaveBeenCalled();
	});

	it("surfaces the refusal under policy never instead of moving the conversation", async () => {
		const report = vi.fn();
		const first = placeRequest(pool(["acc-a", "acc-b", "acc-c"], { migration: "never" }), { key });
		const home = first.account.name;
		let failure: unknown;
		try {
			await drive(removeAccount(first.state, home), report);
		} catch (error) {
			failure = error;
		}
		console.log(`never -> failed=${failure instanceof Error} msg=${(failure as Error)?.message?.slice(0, 80)}`);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(home);
		expect(report).not.toHaveBeenCalled();
	});
});
