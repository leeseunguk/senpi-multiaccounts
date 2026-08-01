import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AccountPoolState } from "../src/core/accounts.js";
import { createKiroStreamSimple } from "../src/providers/kiro/provider.js";

function pool(names = ["primary"]): AccountPoolState {
	return {
		accounts: names.map((name) => ({
				name,
				access: `${name}-access-token`,
				refresh: `${name}-refresh-token`,
				expires: Number.MAX_SAFE_INTEGER,
				source: "login",
			})),
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
	};
}

function context(): Context {
	return {
		messages: [{ role: "user", content: "stream this response", timestamp: Date.now() }],
	};
}

describe("Kiro provider streaming", () => {
	it("does not pull upstream past the first visible delta before yielding it", async () => {
		let pulls = 0;
		const upstream: AsyncIterable<Record<string, unknown>> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						pulls += 1;
						if (pulls === 1) {
							return { done: false as const, value: { type: "text_delta", delta: "hello" } };
						}
						throw new Error("upstream was pulled before the consumer requested another event");
					},
				};
			},
		};
		const writePoolState = vi.fn();
		const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-test", {
			readPoolState: () => pool(),
			writePoolState,
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: (() => () => upstream as unknown as AssistantMessageEventStream) as never,
		});

		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({
			done: false,
			value: { type: "text_delta", delta: "hello" },
		});
		expect(pulls).toBe(1);
		expect(writePoolState).toHaveBeenCalledOnce();
	});

	it("persists a pre-delta rate-limit block when every account fails", async () => {
		const writePoolState = vi.fn();
		const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-test", {
			readPoolState: () => pool(),
			writePoolState,
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: (() => () =>
				(async function* () {
					yield { type: "error", error: { errorMessage: "HTTP 429: rate limited" } };
				})() as unknown as AssistantMessageEventStream) as never,
		});
		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).rejects.toThrow("HTTP 429");
		const persisted = writePoolState.mock.calls.at(-1)?.[2] as AccountPoolState | undefined;
		expect(persisted?.accounts[0]?.blockReason).toBe("rate_limit");
	});

	it("blocks a post-delta failure without replaying the turn", async () => {
		const writePoolState = vi.fn();
		const createStream = vi.fn(
			() => () =>
				(async function* () {
					yield { type: "text_delta", delta: "partial" };
					yield { type: "error", error: { errorMessage: "HTTP 429: rate limited" } };
				})() as unknown as AssistantMessageEventStream,
		);
		const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-test", {
			readPoolState: () => pool(["primary", "secondary"]),
			writePoolState,
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: createStream as never,
		});
		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toMatchObject({
			done: false,
			value: { type: "text_delta", delta: "partial" },
		});
		await expect(iterator.next()).rejects.toThrow("HTTP 429");
		expect(createStream).toHaveBeenCalledOnce();
		const persisted = writePoolState.mock.calls.at(-1)?.[2] as AccountPoolState | undefined;
		const blocked = persisted?.accounts.find((account) => account.blockReason === "rate_limit");
		expect(blocked).toBeDefined();
		// CONTRACT CHANGE (cache affinity): the blocked account KEEPS its binding.
		// Blocking already routes this and later requests elsewhere; retaining the
		// binding is what lets the conversation return to its still-warm prompt
		// cache once the block expires. The previous rule ("binding must not name
		// the blocked account") permanently migrated the conversation and is the
		// second root cause of the cache-hit drop.
		expect(Object.values(persisted?.bindings ?? {})).toContain(blocked?.name);
	});

	it("passes an opt-in diagnostic logger to the vendored stream", async () => {
		const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
		let receivedLogger: unknown;
		const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-test", {
			readPoolState: () => pool(),
			writePoolState: vi.fn(),
			usage: { get: () => undefined, refresh: async () => ({}) },
			logger: logger as never,
			createStream: ((_config: unknown, _runtime: unknown, candidate: unknown) => {
				receivedLogger = candidate;
				return () =>
					(async function* () {
						yield { type: "text_delta", delta: "ok" };
					})() as unknown as AssistantMessageEventStream;
			}) as never,
		});
		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();

		await iterator.next();
		expect(receivedLogger).toBe(logger);
	});

	it("retries before a delta without leaking failed-attempt events", async () => {
		let attempts = 0;
		const writePoolState = vi.fn();
		const createStream = vi.fn(() => () => {
			attempts += 1;
			return (async function* () {
				if (attempts === 1) {
					yield { type: "start" };
					yield { type: "error", error: { errorMessage: "HTTP 429: rate limited" } };
					return;
				}
				yield { type: "text_delta", delta: "healthy" };
			})() as unknown as AssistantMessageEventStream;
		});
		const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-test", {
			readPoolState: () => pool(["primary", "secondary"]),
			writePoolState,
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: createStream as never,
		});
		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toMatchObject({
			done: false,
			value: { type: "text_delta", delta: "healthy" },
		});
		expect(createStream).toHaveBeenCalledTimes(2);
		const persisted = writePoolState.mock.calls.at(-1)?.[2] as AccountPoolState | undefined;
		expect(persisted?.accounts.filter((account) => account.blockReason === "rate_limit")).toHaveLength(1);
		expect(Object.values(persisted?.bindings ?? {})).toHaveLength(1);
	});

	it("closes the upstream iterator when a failure arrives before any delta", async () => {
		const upstreamReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
		const upstream: AsyncIterable<Record<string, unknown>> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({
						done: false as const,
						value: { type: "error", error: { errorMessage: "HTTP 429: rate limited" } },
					}),
					return: upstreamReturn,
				};
			},
		};
		const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-test", {
			readPoolState: () => pool(),
			writePoolState: vi.fn(),
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: (() => () => upstream as unknown as AssistantMessageEventStream) as never,
		});
		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).rejects.toThrow("HTTP 429");
		expect(upstreamReturn).toHaveBeenCalledOnce();
	});

	it("closes the upstream iterator when the consumer cancels during buffered events", async () => {
		const upstreamReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
		let pulls = 0;
		const upstream: AsyncIterable<Record<string, unknown>> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						pulls += 1;
						if (pulls === 1) return { done: false as const, value: { type: "start" } };
						return { done: false as const, value: { type: "text_delta", delta: "hello" } };
					},
					return: upstreamReturn,
				};
			},
		};
		const streamSimple = createKiroStreamSimple("/tmp/senpi-accounts-test", {
			readPoolState: () => pool(),
			writePoolState: vi.fn(),
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: (() => () => upstream as unknown as AssistantMessageEventStream) as never,
		});
		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "start" } });
		await iterator.return?.();
		expect(pulls).toBe(2);
		expect(upstreamReturn).toHaveBeenCalledOnce();
	});
});
