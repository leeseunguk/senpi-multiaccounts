import {
	type AccountPoolState,
	type AccountSlot,
	addAccount,
	assertValidAccountName,
	DEFAULT_MIGRATION_POLICY,
	isBlocked,
	MIGRATION_POLICIES,
	type MigrationPolicy,
	pinAccount,
	removeAccount,
	type SelectionStrategy,
	unblockAccount,
	unpinAccount,
} from "./accounts.js";
import type { SchedulingMode } from "./affinity.js";
import { readPool, writePool } from "./store.js";

/**
 * Shared `/<provider>-account` command surface.
 *
 * Mirrors stock senpi's `/claude-account` so multi-account management feels the
 * same whether the provider is stock or supplied by this addon.
 */

export interface AccountCommandDeps {
	agentDir: string;
	providerId: string;
	/** Run the provider's login flow and return the slot to store. */
	login: (name: string) => Promise<AccountSlot>;
	readPoolState?: typeof readPool;
	writePoolState?: typeof writePool;
	now?: () => number;
}

export interface CommandOutput {
	text: string;
	level: "info" | "error";
}

function formatSlot(slot: AccountSlot, state: AccountPoolState, now: number): string {
	const marks: string[] = [];
	if (state.pinned === slot.name) marks.push("pinned");

	if (slot.blockReason === "auth_error") {
		marks.push("blocked: needs re-login");
	} else if (slot.blockedUntil !== undefined && slot.blockedUntil > now) {
		const seconds = Math.ceil((slot.blockedUntil - now) / 1_000);
		marks.push(`blocked ${seconds}s (${slot.blockReason ?? "unknown"})`);
	} else {
		marks.push("available");
	}

	const method = (slot.meta as { authMethod?: string } | undefined)?.authMethod;
	if (method) marks.push(method);

	const email = (slot.meta as { email?: string } | undefined)?.email;
	const label = email ? `${slot.name} <${email}>` : slot.name;
	return `  ${label} — ${marks.join(", ")}`;
}

function listOutput(providerId: string, state: AccountPoolState, now: number): CommandOutput {
	if (state.accounts.length === 0) {
		return {
			text: `No ${providerId} accounts yet. Add one with: /${providerId}-account add <name>`,
			level: "info",
		};
	}

	const strategy = state.strategy ?? "fill-first";
	const available = state.accounts.filter((slot) => !isBlocked(slot, now)).length;
	const migration = state.migration ?? DEFAULT_MIGRATION_POLICY;
	const lines = [
		`${providerId} accounts (${available}/${state.accounts.length} available, strategy: ${strategy}, ` +
			`migration: ${migration}):`,
		...state.accounts.map((slot) => formatSlot(slot, state, now)),
	];
	return { text: lines.join("\n"), level: "info" };
}

const USAGE =
	"add <name> | remove <name> | logout [all] | pin <name> | unpin | " +
	"mode <cache-first|balanced|spread> | migrate <auto|ask|never> | " +
	"strategy <fill-first|rotate> | unblock <name> | list";

const SCHEDULING_MODES: SchedulingMode[] = ["cache-first", "balanced", "spread"];

/**
 * Execute one account subcommand and return the message to show.
 *
 * Pure with respect to the terminal: the caller decides how to render, which
 * keeps this testable without a senpi UI.
 */
export async function runAccountCommand(deps: AccountCommandDeps, rawArgs: string): Promise<CommandOutput> {
	const read = deps.readPoolState ?? readPool;
	const write = deps.writePoolState ?? writePool;
	const now = (deps.now ?? Date.now)();
	const args = rawArgs.trim().split(/\s+/).filter(Boolean);
	const action = args[0] ?? "list";
	const target = args[1];
	const state = read(deps.agentDir, deps.providerId);

	try {
		switch (action) {
			case "list":
				return listOutput(deps.providerId, state, now);

			case "add": {
				if (!target) return { text: `Usage: /${deps.providerId}-account add <name>`, level: "error" };
				assertValidAccountName(target);
				if (state.accounts.some((slot) => slot.name === target)) {
					return { text: `Account '${target}' already exists.`, level: "error" };
				}
				const slot = await deps.login(target);
				write(deps.agentDir, deps.providerId, addAccount(state, slot));
				return { text: `Added ${deps.providerId} account '${target}'.`, level: "info" };
			}

			case "remove": {
				if (!target) return { text: `Usage: /${deps.providerId}-account remove <name>`, level: "error" };
				if (!state.accounts.some((slot) => slot.name === target)) {
					return { text: `Account '${target}' does not exist.`, level: "error" };
				}
				write(deps.agentDir, deps.providerId, removeAccount(state, target));
				return { text: `Removed ${deps.providerId} account '${target}'.`, level: "info" };
			}

			// Logout is the credential-facing name for removal: `logout <name>` drops
			// one account, `logout all` empties the pool (and with it the pin and
			// conversation bindings, which would otherwise dangle).
			case "logout": {
				if (!target) {
					return {
						text: `Usage: /${deps.providerId}-account logout <name|all>`,
						level: "error",
					};
				}
				if (target === "all") {
					const count = state.accounts.length;
					if (count === 0) return { text: `No ${deps.providerId} accounts to log out.`, level: "info" };
					const cleared = { ...state, accounts: [], bindings: {} };
					delete (cleared as { pinned?: string }).pinned;
					write(deps.agentDir, deps.providerId, cleared);
					return {
						text: `Logged out of all ${count} ${deps.providerId} account(s).`,
						level: "info",
					};
				}
				if (!state.accounts.some((slot) => slot.name === target)) {
					return { text: `Account '${target}' does not exist.`, level: "error" };
				}
				write(deps.agentDir, deps.providerId, removeAccount(state, target));
				return { text: `Logged out of ${deps.providerId} account '${target}'.`, level: "info" };
			}

			// Scheduling mode decides *where* a request lands: cache-first keeps a
			// conversation on one account for prompt-cache hits, balanced evens out
			// usage, spread avoids herding. `strategy` below is the older
			// fill-first/rotate knob and is kept for compatibility.
			case "mode": {
				if (!target || !SCHEDULING_MODES.includes(target as SchedulingMode)) {
					return {
						text: `Usage: /${deps.providerId}-account mode <${SCHEDULING_MODES.join("|")}>`,
						level: "error",
					};
				}
				write(deps.agentDir, deps.providerId, { ...state, mode: target as SchedulingMode });
				return { text: `${deps.providerId} scheduling mode set to ${target}.`, level: "info" };
			}

			// Migration policy decides what happens when a conversation can no longer
			// use the account holding its warm prompt cache. A blocked account is a
			// reversible detour and is never gated; this covers only the irreversible
			// case, where the bound account has left the pool.
			case "migrate": {
				if (!target || !MIGRATION_POLICIES.includes(target as MigrationPolicy)) {
					return {
						text: `Usage: /${deps.providerId}-account migrate <${MIGRATION_POLICIES.join("|")}>`,
						level: "error",
					};
				}
				write(deps.agentDir, deps.providerId, { ...state, migration: target as MigrationPolicy });
				return { text: `${deps.providerId} migration policy set to ${target}.`, level: "info" };
			}

			case "pin": {
				if (!target || target === "unpin") {
					write(deps.agentDir, deps.providerId, unpinAccount(state));
					return { text: `Unpinned ${deps.providerId} account.`, level: "info" };
				}
				write(deps.agentDir, deps.providerId, pinAccount(state, target));
				return { text: `Pinned ${deps.providerId} account '${target}'.`, level: "info" };
			}

			case "unpin":
				write(deps.agentDir, deps.providerId, unpinAccount(state));
				return { text: `Unpinned ${deps.providerId} account.`, level: "info" };

			case "strategy": {
				if (target !== "fill-first" && target !== "rotate") {
					return {
						text: `Usage: /${deps.providerId}-account strategy <fill-first|rotate>`,
						level: "error",
					};
				}
				write(deps.agentDir, deps.providerId, { ...state, strategy: target as SelectionStrategy });
				return { text: `${deps.providerId} selection strategy set to ${target}.`, level: "info" };
			}

			case "unblock": {
				if (!target) return { text: `Usage: /${deps.providerId}-account unblock <name>`, level: "error" };
				const slot = state.accounts.find((candidate) => candidate.name === target);
				if (!slot) return { text: `Account '${target}' does not exist.`, level: "error" };
				write(deps.agentDir, deps.providerId, {
					...state,
					accounts: state.accounts.map((candidate) =>
						candidate.name === target ? unblockAccount(candidate) : candidate,
					),
				});
				return { text: `Cleared the block on '${target}'.`, level: "info" };
			}

			default:
				return { text: `Usage: /${deps.providerId}-account ${USAGE}`, level: "error" };
		}
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), level: "error" };
	}
}

export { USAGE as ACCOUNT_COMMAND_USAGE };
