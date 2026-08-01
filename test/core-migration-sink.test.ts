import { describe, expect, it, vi } from "vitest";
import { createMigrationSink } from "../src/core/migration-sink.js";

function uiContext(mode: string, hasUI: boolean) {
	const notify = vi.fn();
	return { ctx: { mode, hasUI, ui: { notify } }, notify };
}

describe("migration notices reach the user only where a user can see them", () => {
	it("notifies in tui mode", () => {
		const sink = createMigrationSink();
		const { ctx, notify } = uiContext("tui", true);
		sink.attach(ctx as never);
		sink.report("kiro", { from: "acc-a", to: "acc-b" });
		console.log(`tui -> notify calls=${notify.mock.calls.length} msg=${notify.mock.calls[0]?.[0]}`);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).toContain("acc-a");
		expect(String(notify.mock.calls[0]?.[0])).toContain("acc-b");
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
	});

	it("stays silent in print mode, where nobody is watching", () => {
		const sink = createMigrationSink();
		const { ctx, notify } = uiContext("print", false);
		sink.attach(ctx as never);
		sink.report("kiro", { from: "acc-a", to: "acc-b" });
		console.log(`print -> notify calls=${notify.mock.calls.length}`);
		expect(notify).not.toHaveBeenCalled();
	});

	it("is a no-op before any context is attached, so a provider can fire early", () => {
		const sink = createMigrationSink();
		expect(() => sink.report("kiro", { from: "acc-a", to: "acc-b" })).not.toThrow();
	});

	it("swallows a UI failure rather than breaking the request that triggered it", () => {
		const sink = createMigrationSink();
		const notify = vi.fn(() => {
			throw new Error("UI is gone");
		});
		sink.attach({ mode: "tui", hasUI: true, ui: { notify } } as never);
		expect(() => sink.report("kiro", { from: "acc-a", to: "acc-b" })).not.toThrow();
	});

	it("uses the newest attached context, so a reloaded session notifies once", () => {
		const sink = createMigrationSink();
		const first = uiContext("tui", true);
		const second = uiContext("tui", true);
		sink.attach(first.ctx as never);
		sink.attach(second.ctx as never);
		sink.report("kiro", { from: "acc-a", to: "acc-b" });
		expect(first.notify).not.toHaveBeenCalled();
		expect(second.notify).toHaveBeenCalledTimes(1);
	});
});
