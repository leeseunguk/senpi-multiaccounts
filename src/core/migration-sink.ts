import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { MigrationNotice } from "./failover.js";

/**
 * Delivery point for migration notices.
 *
 * A provider stream runs with no `ExtensionContext` of its own, so the
 * extension entry point attaches the newest one here and the provider reports
 * through it. Notices are fire-and-forget: a stream that already lost its warm
 * cache must not also fail because the UI is unavailable.
 */
export interface MigrationSink {
	attach(ctx: ExtensionContext): void;
	report(providerId: string, notice: MigrationNotice): void;
}

function message(providerId: string, notice: MigrationNotice): string {
	return (
		`${providerId}: this conversation left account '${notice.from}' for good and is now on '${notice.to}'. ` +
		"Its prompt cache starts cold. Set a different policy with: " +
		`/${providerId}-account migrate <auto|ask|never>`
	);
}

export function createMigrationSink(): MigrationSink {
	let current: ExtensionContext | undefined;
	return {
		attach(ctx) {
			current = ctx;
		},
		report(providerId, notice) {
			const ctx = current;
			if (!ctx?.hasUI) return;
			try {
				ctx.ui.notify(message(providerId, notice), "warning");
			} catch {
				// A failed notification must never surface as a request failure.
			}
		},
	};
}

export const migrationSink: MigrationSink = createMigrationSink();
