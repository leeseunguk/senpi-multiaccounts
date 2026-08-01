import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AccountSlot, isBlocked } from "./accounts.js";
import { readPool } from "./store.js";
import type { AddonPackage, ProviderBuildContext } from "./types.js";
import { type AccountUsage, formatUsage } from "./usage-window.js";

/**
 * Usage dashboard.
 *
 * Covers both addon-managed pools and the subscriptions stock senpi manages on
 * its own, so one command answers "how much have I got left, everywhere".
 */

export interface ProviderUsageLine {
	provider: string;
	detail: string;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** Stock providers persist their own credentials; report what is discoverable. */
function stockAccountLines(agentDir: string): ProviderUsageLine[] {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return [];

	let data: Record<string, unknown>;
	try {
		data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
	} catch {
		return [];
	}

	const lines: ProviderUsageLine[] = [];
	for (const [provider, raw] of Object.entries(data)) {
		if (typeof raw !== "object" || raw === null) continue;
		const credential = raw as {
			type?: string;
			accounts?: { name: string; blockedUntil?: number; blockReason?: string }[];
		};
		const accounts = credential.accounts;
		if (Array.isArray(accounts) && accounts.length > 0) {
			const now = Date.now();
			const available = accounts.filter((slot) => !isBlocked(slot as never, now)).length;
			lines.push({ provider, detail: `${available}/${accounts.length} accounts available` });
			continue;
		}
		// API-key and single-credential OAuth subscriptions (alibaba-token-plan,
		// opencode-go, a lone anthropic login) have no `accounts` array. Skipping
		// them made configured subscriptions invisible to the dashboard, which is
		// exactly what it exists to answer, so report them as configured. Remaining
		// quota is added by stockPlanUsageLines() for providers that publish it.
		if (credential.type === "api_key" || credential.type === "api") {
			lines.push({ provider, detail: "configured (API key; no quota endpoint)" });
			continue;
		}
		if (credential.type === "oauth") {
			lines.push({ provider, detail: "configured (1 account)" });
		}
	}
	return lines;
}

/**
 * Codex and friends record plan usage in senpi's failover state file. It is not
 * part of senpi's public API, so absence or a shape change degrades to "no
 * data" rather than breaking the command.
 */
function stockPlanUsageLines(agentDir: string): ProviderUsageLine[] {
	const statePath = join(agentDir, "provider-failover-state.json");
	if (!existsSync(statePath)) return [];

	try {
		const state = JSON.parse(readFileSync(statePath, "utf8")) as {
			usageByProvider?: Record<string, { plan?: string; primary?: { usedPercent?: number; resetAt?: number } }>;
		};
		const usage = state.usageByProvider;
		if (!usage) return [];

		return Object.entries(usage).flatMap(([provider, entry]) => {
			const used = entry?.primary?.usedPercent;
			if (typeof used !== "number") return [];
			const plan = entry.plan ? ` (${entry.plan})` : "";
			const resets = entry.primary?.resetAt ? `, resets ${new Date(entry.primary.resetAt).toLocaleString()}` : "";
			return [{ provider, detail: `${percent(1 - used / 100)} remaining${plan}${resets}` }];
		});
	} catch {
		return [];
	}
}

function slotState(slot: AccountSlot, now: number): string {
	if (slot.blockReason === "auth_error") return "needs re-login";
	if (isBlocked(slot, now)) {
		return `blocked ${Math.ceil(((slot.blockedUntil ?? now) - now) / 1000)}s (${slot.blockReason ?? "unknown"})`;
	}
	return "available";
}

/**
 * Per-account lines for addon providers.
 *
 * A provider that reports full windows renders them all (`7% 5h 4h 7m · 38%
 * week 5d`), because one collapsed percentage is what let an account sitting at
 * 100% weekly read as plain "available". Providers that only report a single
 * headroom number keep the old one-number rendering.
 */
async function addonLines(
	packages: readonly AddonPackage[],
	context: ProviderBuildContext,
): Promise<ProviderUsageLine[]> {
	const results = await Promise.all(
		packages.map(async (entry): Promise<ProviderUsageLine[]> => {
			let detail: Record<string, AccountUsage | undefined> = {};
			let headroom: Record<string, number | undefined> = {};
			if (entry.accountUsageDetail) {
				try {
					detail = await entry.accountUsageDetail(context);
				} catch {
					detail = {};
				}
			} else if (entry.accountUsage) {
				try {
					headroom = await entry.accountUsage(context);
				} catch {
					headroom = {};
				}
			}

			// Usage refreshes may persist quota blocks or rotated credentials. Read
			// the pool afterward so the first report reflects that new routing state.
			const accounts = entry.readAccounts?.(context) ?? readPool(context.agentDir, entry.id).accounts;
			if (accounts.length === 0) return [];

			const now = Date.now();
			return accounts.map((slot) => {
				const usage = detail[slot.name];
				const email = usage?.email ?? (slot.meta as { email?: string } | undefined)?.email;
				const label = email ? `${slot.name} <${email}>` : slot.name;
				const plan = usage?.plan ? ` (${usage.plan})` : "";
				const state = slotState(slot, now);

				if (usage && usage.windows.length > 0) {
					return { provider: entry.id, detail: `${label}${plan}: ${formatUsage(usage, now)} — ${state}` };
				}
				const left = typeof headroom[slot.name] === "number" ? `${percent(headroom[slot.name] as number)} remaining, ` : "";
				const availability =
					!usage && entry.accountUsageDetail ? `usage unavailable, ${state}` : `${left}${state}`;
				return { provider: entry.id, detail: `${label}${plan}: ${availability}` };
			});
		}),
	);
	return results.flat();
}

export async function buildUsageReport(
	packages: readonly AddonPackage[],
	context: ProviderBuildContext,
): Promise<string> {
	const [addon, stockAccounts, stockPlans] = [
		await addonLines(packages, context),
		stockAccountLines(context.agentDir),
		stockPlanUsageLines(context.agentDir),
	];

	const managedIds = new Set(packages.map((entry) => entry.id));
	// A provider can appear in both stock sources: a credential in auth.json and a
	// quota entry in the failover state. Quota is strictly more informative, so it
	// wins and the provider is listed once.
	const planProviders = new Set(stockPlans.map((line) => line.provider));
	// An addon provider is filtered out of the auth.json rows only once it has
	// actually contributed per-account lines. A single-credential addon provider
	// (tokenrouter) has no pool to enumerate, so filtering purely on ownership
	// would hide the subscription from the one command that exists to show it.
	const reportedIds = new Set(addon.map((line) => line.provider));
	const lines = [
		...addon,
		// Stock pools the addon does not own (e.g. claude-agent-sdk).
		...stockAccounts.filter((line) => !reportedIds.has(line.provider) && !planProviders.has(line.provider)),
		...stockPlans.filter((line) => !managedIds.has(line.provider)),
	];

	if (lines.length === 0) return "No subscriptions found. Add one with /login <provider>.";

	const width = Math.max(...lines.map((line) => line.provider.length));
	return ["Subscription usage:", ...lines.map((line) => `  ${line.provider.padEnd(width)}  ${line.detail}`)].join("\n");
}
