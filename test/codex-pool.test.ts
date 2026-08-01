import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emptyPool, readPool, writePool } from "../src/core/store.js";
import { codexProviderPackage } from "../src/providers/codex/index.js";
import { resolveCodexModels } from "../src/providers/codex/models.js";
import { createCodexStreamSimple, slotToCodexTokens } from "../src/providers/codex/stream.js";

const read = (rel: string) => readFile(new URL(`../${rel}`, import.meta.url), "utf8");

const context = { env: {} as NodeJS.ProcessEnv, agentDir: "/tmp/codex-pool-test" };

const slot = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	access: `access-${name}`,
	refresh: `refresh-${name}`,
	expires: Date.now() + 3_600_000,
	source: "login" as const,
	meta: { accountId: `acct-${name}`, email: `${name}@example.com` },
	...extra,
});

/**
 * `readPool` returns an `AccountPoolState` (accounts required), while
 * `emptyPool()` is a `StoredPool` (accounts optional), so the stub builds the
 * state shape the stream layer actually receives.
 */
const poolWith = (...names: string[]) => ({
	...emptyPool(),
	accounts: names.map((name) => slot(name)),
});

/** Minimal stream stub: yields one event, or throws to force failover. */
const streamStub = (onCall: (options: unknown) => void, fail?: string) =>
	((_model: never, _ctx: never, options: never) => {
		onCall(options);
		return (async function* () {
			if (fail) throw new Error(fail);
			yield { type: "text_delta", delta: "ok" };
		})();
	}) as never;

const streamContext = { messages: [{ role: "user", content: "hello" }] } as never;

describe("codex-pool provider registration", () => {
	it("registers a non-empty model catalog", () => {
		// An extension-registered provider id inherits no built-in catalog, so
		// omitting `models` registers zero models and `--provider codex-pool`
		// fails with "Unknown provider". Verified live before this was fixed.
		const config = codexProviderPackage().build(context) as { models?: unknown[] };
		expect(config.models?.length ?? 0).toBeGreaterThan(0);
	});

	it("routes requests through streamSimple rather than a fixed provider key", () => {
		// getApiKey() resolves once from the stored credential, so a pool could
		// never rotate through it; routing must be per request.
		const config = codexProviderPackage().build(context) as { streamSimple?: unknown };
		expect(typeof config.streamSimple).toBe("function");
	});

	it("stays opt-in so stock openai-codex remains the default", () => {
		const pkg = codexProviderPackage();
		expect(pkg.enabled?.({} as NodeJS.ProcessEnv)).toEqual(expect.stringContaining("SENPI_ACCOUNTS_CODEX_POOL"));
		expect(pkg.enabled?.({ SENPI_ACCOUNTS_CODEX_POOL: "1" } as NodeJS.ProcessEnv)).toBe(true);
	});

	it("narrows the catalog via SENPI_ACCOUNTS_CODEX_MODELS", () => {
		const models = resolveCodexModels({ SENPI_ACCOUNTS_CODEX_MODELS: "gpt-5.5" } as NodeJS.ProcessEnv);
		expect(models.map((model) => model.id)).toEqual(["gpt-5.5"]);
	});

	it("falls back to the full catalog when the override matches nothing", () => {
		const models = resolveCodexModels({ SENPI_ACCOUNTS_CODEX_MODELS: "nope" } as NodeJS.ProcessEnv);
		expect(models.length).toBeGreaterThan(1);
	});
});

describe("codex-pool request routing", () => {
	it("injects the selected account's token and account id", async () => {
		const seen: Record<string, unknown>[] = [];
		const stream = createCodexStreamSimple("/tmp/x", {
			readPoolState: () => poolWith("alpha"),
			writePoolState: () => {},
			createStream: streamStub((options) => seen.push(options as Record<string, unknown>)),
		});

		for await (const _ of stream({} as never, streamContext) as AsyncIterable<unknown>) {
			// drain
		}

		expect(seen[0]?.apiKey).toBe("access-alpha");
		expect((seen[0]?.headers as Record<string, string>)["chatgpt-account-id"]).toBe("acct-alpha");
	});

	it("rotates to the next account when an attempt fails", async () => {
		const used: string[] = [];
		let first = true;
		const stream = createCodexStreamSimple("/tmp/x", {
			readPoolState: () => poolWith("alpha", "bravo"),
			writePoolState: () => {},
			createStream: ((model: never, ctx: never, options: never) => {
				const key = (options as { apiKey: string }).apiKey;
				used.push(key);
				const shouldFail = first;
				first = false;
				return (async function* () {
					if (shouldFail) throw new Error("429 rate limit");
					yield { type: "text_delta", delta: "ok" };
				})();
			}) as never,
		});

		for await (const _ of stream({} as never, streamContext) as AsyncIterable<unknown>) {
			// drain
		}

		expect(used).toHaveLength(2);
		expect(new Set(used).size).toBe(2);
	});

	it("persists pool state so a block survives to the next request", async () => {
		const writes: unknown[] = [];
		let first = true;
		const stream = createCodexStreamSimple("/tmp/x", {
			readPoolState: () => poolWith("alpha", "bravo"),
			writePoolState: (_dir, _id, state) => writes.push(state),
			createStream: ((model: never, ctx: never, _options: never) => {
				const shouldFail = first;
				first = false;
				return (async function* () {
					if (shouldFail) throw new Error("429 rate limit");
					yield { type: "text_delta", delta: "ok" };
				})();
			}) as never,
		});

		for await (const _ of stream({} as never, streamContext) as AsyncIterable<unknown>) {
			// drain
		}

		expect(writes).toHaveLength(1);
	});

	it("carries accountId and email from slot metadata", () => {
		expect(slotToCodexTokens(slot("alpha"))).toMatchObject({
			access: "access-alpha",
			accountId: "acct-alpha",
			email: "alpha@example.com",
		});
	});

	it("omits optional metadata that is absent", () => {
		expect(slotToCodexTokens({ ...slot("bare"), meta: {} })).not.toHaveProperty("accountId");
	});

	it("surfaces a missing stream implementation as an attempt error", async () => {
		const stream = createCodexStreamSimple("/tmp/x", {
			readPoolState: () => poolWith("alpha"),
			writePoolState: () => {},
		});

		await expect(async () => {
			for await (const _ of stream({} as never, streamContext) as AsyncIterable<unknown>) {
				// drain
			}
		}).rejects.toThrow(/no stream implementation/);
	});

	it("reports failover with both account names", async () => {
		const messages: string[] = [];
		let first = true;
		const stream = createCodexStreamSimple("/tmp/x", {
			readPoolState: () => poolWith("alpha", "bravo"),
			writePoolState: () => {},
			onFailover: (message) => messages.push(message),
			createStream: ((model: never, ctx: never, _options: never) => {
				const shouldFail = first;
				first = false;
				return (async function* () {
					if (shouldFail) throw new Error("429 rate limit");
					yield { type: "text_delta", delta: "ok" };
				})();
			}) as never,
		});

		for await (const _ of stream({} as never, streamContext) as AsyncIterable<unknown>) {
			// drain
		}

		expect(messages[0]).toMatch(/codex-pool: account '\w+' failed/);
		expect(messages[0]).toMatch(/retrying on/);
	});

	it("reports usage per account so the dashboard lists them", async () => {
		const usage = await codexProviderPackage().accountUsage?.({
			env: {} as NodeJS.ProcessEnv,
			agentDir: "/tmp/codex-pool-missing",
		});
		expect(usage).toBeDefined();
	});
});

describe("terminal error events", () => {
	it("treats a pushed error event as a failed attempt and rotates", async () => {
		// Stock's Codex stream does not throw on upstream failure: it pushes
		// { type: "error", ... } and ends normally. Collecting that as an ordinary
		// event made failover see a success, so a dead account was never blocked
		// and the request just failed. Observed live against chatgpt.com.
		const used: string[] = [];
		let first = true;
		const stream = createCodexStreamSimple("/tmp/x", {
			readPoolState: () => poolWith("alpha", "bravo"),
			writePoolState: () => {},
			createStream: ((_m: never, _c: never, options: never) => {
				used.push((options as { apiKey: string }).apiKey);
				const shouldFail = first;
				first = false;
				return (async function* () {
					if (shouldFail) {
						yield {
							type: "error",
							reason: "error",
							error: { errorMessage: "Could not parse your authentication token.", status: 401 },
						};
						return;
					}
					yield { type: "text_delta", delta: "ok" };
				})();
			}) as never,
		});

		const seen: unknown[] = [];
		for await (const event of stream({} as never, streamContext) as AsyncIterable<unknown>) seen.push(event);

		expect(used).toHaveLength(2);
		// The failed attempt must not leak its error event to the caller.
		expect(seen).toEqual([{ type: "text_delta", delta: "ok" }]);
	});

	it("does not treat an aborted stream as a rotatable failure", async () => {
		// A user abort must not burn through every account in the pool.
		const used: string[] = [];
		const stream = createCodexStreamSimple("/tmp/x", {
			readPoolState: () => poolWith("alpha", "bravo"),
			writePoolState: () => {},
			createStream: ((_m: never, _c: never, options: never) => {
				used.push((options as { apiKey: string }).apiKey);
				return (async function* () {
					yield { type: "error", reason: "aborted", error: { errorMessage: "Operation aborted" } };
				})();
			}) as never,
		});

		for await (const _ of stream({} as never, streamContext) as AsyncIterable<unknown>) {
			// drain
		}

		expect(used).toHaveLength(1);
	});
});

describe("account menu logout", () => {
	const menu = async (agentDir: string, answers: (string | undefined)[]) => {
		const cfg = codexProviderPackage().build({ env: {} as NodeJS.ProcessEnv, agentDir }) as {
			oauth: { login: (cb: unknown) => Promise<unknown> };
		};
		const queue = [...answers];
		return (await cfg.oauth.login({ onSelect: async () => queue.shift() })) as {
			accounts?: unknown[];
			pinned?: string;
			bindings?: Record<string, string>;
		};
	};

	const seeded = () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-menu-"));
		const pool = readPool(dir, "codex-pool");
		pool.accounts = [slot("one"), slot("two")];
		pool.pinned = "one";
		pool.bindings = { "c-1": "one" };
		writePool(dir, "codex-pool", pool);
		return dir;
	};

	it("clears every account, the pin and the bindings on confirmation", async () => {
		// Full logout is reachable only from this menu: runAccountCommand is not
		// wired to any senpi command, so menu coverage is what actually matters.
		const state = await menu(seeded(), ["logout-all", "yes"]);

		expect(state.accounts ?? []).toHaveLength(0);
		expect(state.pinned).toBeUndefined();
		expect(state.bindings).toEqual({});
	});

	it("leaves the pool untouched when cancelled", async () => {
		const state = await menu(seeded(), ["logout-all", "no"]);

		expect(state.accounts ?? []).toHaveLength(2);
		expect(state.pinned).toBe("one");
		expect(state.bindings).toEqual({ "c-1": "one" });
	});

	it("logs out of a single account without touching the others", async () => {
		const state = await menu(seeded(), ["remove", "two"]);

		expect((state.accounts ?? []).map((a) => (a as { name: string }).name)).toEqual(["one"]);
	});
});

describe("pi-ai resolution", () => {
	it("anchors on the running senpi process, not the addon's own tree", async () => {
		// senpi is a *peer* dependency, so a clean `npm install` of this addon
		// leaves no senpi (and no pi-ai) inside the addon's node_modules at all.
		// Resolving only from the addon's tree therefore failed in a real tarball
		// install even though it worked from the repo. process.argv[1] is the
		// running senpi's entry point and is the authoritative anchor.
		const source = await read("src/providers/codex/index.ts");

		expect(source).toContain("process.argv[1]");
		// The virtual-module specifier must stay first for the compiled Bun binary.
		const specifierIndex = source.indexOf('"@earendil-works/pi-ai/api/openai-codex-responses"');
		expect(specifierIndex).toBeGreaterThan(-1);
	});

	it("reports a single actionable error rather than every probed path", async () => {
		const source = await read("src/providers/codex/index.ts");

		expect(source).toContain("Ensure @code-yeongyu/senpi is installed alongside this addon");
	});
});
