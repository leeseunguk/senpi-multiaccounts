import { isBlocked, unblockAccount } from "../../core/accounts.js";
import type { ProviderBuildContext } from "../../core/types.js";
import { type AccountUsage, formatUsage } from "../../core/usage-window.js";
import { CLAUDE_SDK_PROVIDER_ID, readClaudePool, updateClaudePool } from "./store.js";

/**
 * `/claude-accounts` — the controls stock's `/claude-account` never had.
 *
 * Stock offers list/add/remove/pin/unpin. It has no way to lift a block early,
 * no full logout, and its listing cannot show usage. This command adds those
 * without shadowing stock's own: the name is deliberately plural so both
 * coexist and `add` still routes to stock's OAuth flow.
 */

export interface CommandOutput {
	text: string;
	level: "info" | "error";
}

export interface ClaudeCommandDeps {
	context: ProviderBuildContext;
	usage?: () => Promise<Record<string, AccountUsage | undefined>>;
	now?: () => number;
}

const USAGE_TEXT = "list | pin <name> | unpin | unblock <name> | logout <name|all>";

/** Keep the pin only when it still names a slot that exists. */
function withPin(accounts: { name: string }[], pinned: string | undefined) {
	return pinned !== undefined && accounts.some((slot) => slot.name === pinned) ? { pinned } : {};
}

async function listOutput(deps: ClaudeCommandDeps): Promise<CommandOutput> {
	const now = (deps.now ?? Date.now)();
	const pool = readClaudePool(deps.context.agentDir);
	if (!pool.present) {
		return { text: "No claude-agent-sdk credential. Add one with /claude-account add.", level: "error" };
	}
	if (pool.accounts.length === 0) {
		return { text: "No Claude accounts yet. Add one with /claude-account add.", level: "info" };
	}

	let detail: Record<string, AccountUsage | undefined> = {};
	if (deps.usage) {
		try {
			detail = await deps.usage();
		} catch {
			detail = {};
		}
	}

	const lines = pool.accounts.map((slot) => {
		const marks: string[] = [];
		if (pool.pinned === slot.name) marks.push("pinned");
		if (slot.blockReason === "auth_error") marks.push("needs re-login");
		else if (isBlocked(slot, now)) {
			marks.push(`blocked ${Math.ceil(((slot.blockedUntil ?? now) - now) / 1000)}s (${slot.blockReason})`);
		} else marks.push("available");

		const usage = detail[slot.name];
		const quota = usage && usage.windows.length > 0 ? `${formatUsage(usage, now)} — ` : "";
		return `  ${slot.name} — ${quota}${marks.join(", ")}`;
	});

	const available = pool.accounts.filter((slot) => !isBlocked(slot, now)).length;
	return {
		text: [`Claude accounts (${available}/${pool.accounts.length} available):`, ...lines].join("\n"),
		level: "info",
	};
}

export async function runClaudeAccountsCommand(deps: ClaudeCommandDeps, rawArgs: string): Promise<CommandOutput> {
	const agentDir = deps.context.agentDir;
	const args = rawArgs.trim().split(/\s+/).filter(Boolean);
	const action = args[0] ?? "list";
	const target = args[1];

	try {
		switch (action) {
			case "list":
				return await listOutput(deps);

			case "pin": {
				if (!target) return { text: "Usage: /claude-accounts pin <name>", level: "error" };
				if (!readClaudePool(agentDir).accounts.some((slot) => slot.name === target)) {
					return { text: `Claude account '${target}' does not exist.`, level: "error" };
				}
				updateClaudePool(agentDir, (pool) => ({ accounts: pool.accounts, pinned: target }));
				return { text: `Pinned Claude account '${target}'.`, level: "info" };
			}

			case "unpin":
				updateClaudePool(agentDir, (pool) => ({ accounts: pool.accounts }));
				return { text: "Unpinned Claude account.", level: "info" };

			case "unblock": {
				if (!target) return { text: "Usage: /claude-accounts unblock <name>", level: "error" };
				const pool = readClaudePool(agentDir);
				if (!pool.accounts.some((slot) => slot.name === target)) {
					return { text: `Claude account '${target}' does not exist.`, level: "error" };
				}
				updateClaudePool(agentDir, (current) => ({
					accounts: current.accounts.map((slot) => (slot.name === target ? unblockAccount(slot) : slot)),
					...withPin(current.accounts, current.pinned),
				}));
				return { text: `Cleared the block on Claude account '${target}'.`, level: "info" };
			}

			case "logout": {
				if (!target) return { text: "Usage: /claude-accounts logout <name|all>", level: "error" };
				const pool = readClaudePool(agentDir);
				if (target === "all") {
					if (pool.accounts.length === 0) return { text: "No Claude accounts to log out.", level: "info" };
					const count = pool.accounts.length;
					updateClaudePool(agentDir, () => ({ accounts: [] }));
					return { text: `Logged out of all ${count} Claude account(s).`, level: "info" };
				}
				if (!pool.accounts.some((slot) => slot.name === target)) {
					return { text: `Claude account '${target}' does not exist.`, level: "error" };
				}
				updateClaudePool(agentDir, (current) => {
					const accounts = current.accounts.filter((slot) => slot.name !== target);
					return { accounts, ...withPin(accounts, current.pinned) };
				});
				return { text: `Logged out of Claude account '${target}'.`, level: "info" };
			}

			default:
				return { text: `Usage: /claude-accounts ${USAGE_TEXT}`, level: "error" };
		}
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), level: "error" };
	}
}

export { USAGE_TEXT as CLAUDE_ACCOUNTS_USAGE, CLAUDE_SDK_PROVIDER_ID };
