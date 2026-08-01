import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildKiroProviderConfig } from "../src/providers/kiro/provider.js";
import { DebugLogger } from "../src/providers/kiro/vendor/debug-logger.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function captureLogger(debug: boolean): Promise<{ agentDir: string; logger: DebugLogger }> {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-accounts-debug-"));
	directories.push(agentDir);
	let logger: DebugLogger | undefined;
	const provider = buildKiroProviderConfig(
		{ agentDir, env: debug ? ({ KIRO_DEBUG: "1" } as NodeJS.ProcessEnv) : ({} as NodeJS.ProcessEnv) },
		undefined,
		{
			readPoolState: () => ({
				accounts: [
					{
						name: "primary",
						access: "access-token",
						refresh: "refresh-token",
						expires: Number.MAX_SAFE_INTEGER,
						source: "login",
					},
				],
			}),
			writePoolState: () => undefined,
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: ((_config: unknown, _runtime: unknown, candidate: DebugLogger) => {
				logger = candidate;
				return () =>
					(async function* () {
						yield { type: "text_delta", delta: "ok" };
					})() as unknown as AssistantMessageEventStream;
			}) as never,
		},
	);
	const stream = provider.streamSimple?.(
		provider.models?.[0] as never,
		{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
	);
	await (stream as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
	if (!logger) throw new Error("Kiro logger was not supplied to the stream");
	return { agentDir, logger };
}

describe("Kiro diagnostics", () => {
	it("writes redacted diagnostics only when KIRO_DEBUG is enabled", async () => {
		const { agentDir, logger } = await captureLogger(true);

		logger.error("request_failed", {
			authorization: "Bearer private-access-token",
			detail: "refresh_token=private-refresh-token",
		});
		await logger.flush();

		const log = readFileSync(join(agentDir, "debug", "debug.log"), "utf8");
		expect(log).toContain("request_failed");
		expect(log).toContain("[REDACTED]");
		expect(log).not.toContain("private-access-token");
		expect(log).not.toContain("private-refresh-token");
	});

	it("does not create a diagnostic file by default", async () => {
		const { agentDir, logger } = await captureLogger(false);

		logger.error("request_failed", { detail: "no file" });
		await logger.flush();

		expect(existsSync(join(agentDir, "debug", "debug.log"))).toBe(false);
	});
});
