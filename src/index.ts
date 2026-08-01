import { homedir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ID, registerProviderPackages } from "./core/registry.js";
import type {
	ExtensionCommandContext,
	ProviderBuildContext,
	ProviderHealth,
	AddonPackage,
	SenpiExtensionAPI,
} from "./core/types.js";
import { migrationSink } from "./core/migration-sink.js";
import { buildUsageReport } from "./core/usage.js";

export type { AddonPackage, ProviderPackage, ObserverPackage, ProviderHealth, ProviderBuildContext } from "./core/types.js";
export { EXTENSION_ID } from "./core/registry.js";

/**
 * senpi-multiaccounts — multi-provider subscription addon.
 *
 * Stock senpi is the base layer and is never modified. This addon sits above it
 * and fills only the gaps stock leaves. Anthropic's pool is stock-owned and
 * stock-streamed, so the `claude` package observes it rather than replacing it:
 * it adds the per-account usage, pin and unblock controls stock's
 * `/claude-account` never had.
 *
 * Every provider lives in its own package under `src/providers/` and is loaded
 * lazily inside a try/catch, so one broken provider degrades only itself.
 */

function agentDir(env: NodeJS.ProcessEnv): string {
	const configured = env.SENPI_CODING_AGENT_DIR?.trim();
	if (configured) {
		return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
	}
	return join(homedir(), ".senpi", "agent");
}

async function loadProviderPackages(): Promise<{ packages: AddonPackage[]; failures: ProviderHealth[] }> {
	const packages: AddonPackage[] = [];
	const failures: ProviderHealth[] = [];

	const loaders: { id: string; load: () => Promise<AddonPackage> }[] = [
		{ id: "kiro", load: async () => (await import("./providers/kiro/index.js")).kiroProviderPackage() },
		{ id: "claude", load: async () => (await import("./providers/claude/index.js")).claudeProviderPackage() },
		{ id: "codex-pool", load: async () => (await import("./providers/codex/index.js")).codexProviderPackage() },
		{
			id: "tokenrouter",
			load: async () => (await import("./providers/tokenrouter/index.js")).tokenrouterProviderPackage(),
		},
		{
			id: "opengateway",
			load: async () => (await import("./providers/opengateway/index.js")).opengatewayProviderPackage(),
		},
	];

	for (const loader of loaders) {
		try {
			packages.push(await loader.load());
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({ status: "degraded", providerId: loader.id, reason, error });
			console.error(`${EXTENSION_ID}: provider '${loader.id}' failed to load: ${reason}`);
		}
	}

	return { packages, failures };
}

export default async function senpiAccounts(pi: SenpiExtensionAPI): Promise<void> {
	const env = process.env;
	const context: ProviderBuildContext = { env, agentDir: agentDir(env) };

	const { packages, failures } = await loadProviderPackages();
	const { health } = await registerProviderPackages(pi, packages, context);
	const allHealth = [...failures, ...health];
	const registered = packages.filter((entry) =>
		allHealth.some((item) => item.providerId === entry.id && item.status === "registered"),
	);

	// A provider stream has no ExtensionContext of its own, so the newest session
	// context is captured here and migration notices are delivered through it.
	pi.on("session_start", (_event, ctx) => {
		migrationSink.attach(ctx);
	});

	pi.registerCommand("usage", {
		description: "Show remaining usage across every configured subscription.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(await buildUsageReport(registered, context), "info");
		},
	});

	pi.registerCommand("claude-accounts", {
		description: "List Claude accounts with per-account usage; pin, unblock or log out.",
		argumentHint: "[list | pin <name> | unpin | unblock <name> | logout <name|all>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const { runClaudeAccountsCommand } = await import("./providers/claude/command.js");
			const { claudeProviderPackage } = await import("./providers/claude/index.js");
			const pkg = claudeProviderPackage();
			const result = await runClaudeAccountsCommand(
				{ context, usage: () => pkg.accountUsageDetail?.(context) ?? Promise.resolve({}) },
				args,
			);
			ctx.ui.notify(result.text, result.level);
		},
	});

	pi.registerCommand("senpi-multiaccounts", {
		description: "Show senpi-multiaccounts provider health.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = allHealth.map((entry) => {
				if (entry.status === "registered") return `  ${entry.providerId}: registered`;
				if (entry.status === "skipped") return `  ${entry.providerId}: skipped (${entry.reason})`;
				return `  ${entry.providerId}: DEGRADED (${entry.reason})`;
			});
			ctx.ui.notify(
				[`${EXTENSION_ID}:`, ...(lines.length > 0 ? lines : ["  (no providers)"])].join("\n"),
				allHealth.some((entry) => entry.status === "degraded") ? "error" : "info",
			);
		},
	});
}
