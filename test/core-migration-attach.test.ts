import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import senpiAccounts from "../src/index.js";

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	return {
		events: {},
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		}),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		registerCommand: vi.fn((name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) => {
			commands.set(name, spec);
		}),
		handlers,
		commands,
	};
}

function uiCtx() {
	const notify = vi.fn();
	return { ctx: { mode: "tui", hasUI: true, ui: { notify } }, notify };
}

describe("the extension attaches a UI context for migration notices", () => {
	it("subscribes to a session lifecycle event so a provider can notify later", async () => {
		const pi = fakePi();
		process.env.SENPI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "senpi-accounts-attach-"));
		await senpiAccounts(pi as never);
		console.log(`subscribed events -> ${[...pi.handlers.keys()].join(", ")}`);
		expect(pi.handlers.has("session_start")).toBe(true);
	});

	it("routes a provider notice to the attached context", async () => {
		const pi = fakePi();
		process.env.SENPI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "senpi-accounts-attach-"));
		await senpiAccounts(pi as never);

		const handler = pi.handlers.get("session_start");
		if (!handler) throw new Error("no session_start handler was registered");
		const { ctx, notify } = uiCtx();
		await handler({ type: "session_start", reason: "startup" }, ctx);

		const { migrationSink } = await import("../src/core/migration-sink.js");
		migrationSink.report("kiro", { from: "acc-a", to: "acc-b" });

		console.log(`after attach -> notify calls=${notify.mock.calls.length}`);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).toContain("acc-a");
	});
});
