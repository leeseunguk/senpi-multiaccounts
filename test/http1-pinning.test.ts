import { describe, expect, it, vi } from "vitest";

/**
 * Regression lock for the protocol pin.
 *
 * `chatgpt.com` answers an HTTP/2 request to `/backend-api/codex/usage` with a
 * 403 bot-challenge page instead of JSON; the identical request over HTTP/1.1
 * returns 200. Node's global `fetch` negotiates h2 over ALPN, so routing the
 * probe through it silently reported every Codex account as "quota unknown".
 * This asserts the probe never falls back to the global fetch.
 */

describe("codex usage transport", () => {
	it("does not issue the probe through the global fetch", async () => {
		const globalFetch = vi.fn(async () => {
			throw new Error("global fetch must not be used: it negotiates h2 and is answered with 403");
		});
		vi.stubGlobal("fetch", globalFetch);

		const http1 = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 604_800 } } }),
		}));
		const { fetchCodexUsage } = await import("../src/providers/codex/usage.js");

		const usage = await fetchCodexUsage("t", "a", http1 as never);

		expect(globalFetch).not.toHaveBeenCalled();
		expect(http1).toHaveBeenCalledOnce();
		expect(usage.windows[0]?.usedFraction).toBe(0.03);
		vi.unstubAllGlobals();
	});

	it("passes a timeout the caller can bound rather than a fetch AbortSignal", async () => {
		const http1 = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
		const { fetchCodexUsage } = await import("../src/providers/codex/usage.js");

		await fetchCodexUsage("t", undefined, http1 as never);

		const init = (http1.mock.calls[0] as unknown as [string, { timeoutMs?: number }])[1];
		expect(init.timeoutMs).toBeGreaterThan(0);
	});

	it("surfaces the status so a challenge page is distinguishable from an outage", async () => {
		const http1 = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
		const { fetchCodexUsage } = await import("../src/providers/codex/usage.js");

		await expect(fetchCodexUsage("t", "a", http1 as never)).rejects.toMatchObject({
			name: "CodexUsageError",
			status: 403,
		});
	});
});
