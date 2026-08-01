import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@code-yeongyu/senpi";
import type { AccountSlot } from "./accounts.js";
import type { AccountUsage } from "./usage-window.js";

export type { ProviderConfig, ExtensionCommandContext };

/**
 * Compile-time guard: if the `@code-yeongyu/senpi` declarations fail to resolve
 * (e.g. silently suppressed under `skipLibCheck`), this alias becomes an
 * unassignable marker tuple rather than weakening every consumer to `any`.
 */
type IsUnresolved<T> = 0 extends 1 & T ? true : false;
type Resolved<T> = IsUnresolved<T> extends true
	? ["@code-yeongyu/senpi ExtensionAPI type failed to resolve"]
	: T;

export type SenpiExtensionAPI = Resolved<ExtensionAPI>;

/** Health of a single provider package after a registration attempt. */
export type ProviderHealth =
	| { status: "registered"; providerId: string }
	| { status: "skipped"; providerId: string; reason: string }
	| { status: "degraded"; providerId: string; reason: string; error: unknown };

export interface ProviderBuildContext {
	readonly env: NodeJS.ProcessEnv;
	/** Absolute path to the senpi agent directory (`~/.senpi/agent` by default). */
	readonly agentDir: string;
}

/**
 * What every addon package shares: an identity, an opt-out, and the account
 * reporting the dashboard reads. Nothing here registers a provider with senpi.
 */
export interface AccountPackage {
	/** Provider id registered with senpi; also the `/login <id>` name. */
	readonly id: string;
	/** Human-readable label used in diagnostics. */
	readonly label: string;
	/**
	 * Whether this package should register. Returning a string skips
	 * registration and reports that string as the reason. The context is passed
	 * so a package can also refuse on credential state, not just on env.
	 */
	enabled?(env: NodeJS.ProcessEnv, context?: ProviderBuildContext): true | string;
	/**
	 * Run the provider's interactive login and return the slot to store.
	 * Present only on providers that support managed multi-account pools.
	 */
	accountLogin?(name: string, ctx: ExtensionCommandContext): Promise<AccountSlot>;
	/**
	 * Report remaining headroom per account, 0..1, for usage-aware placement and
	 * the usage dashboard. Absent or throwing means "unknown".
	 */
	accountUsage?(context: ProviderBuildContext): Promise<Record<string, number | undefined>>;
	/**
	 * Report every metered window per account, for the dashboard. Richer than
	 * {@link accountUsage}, which collapses them to one number for routing.
	 */
	accountUsageDetail?(context: ProviderBuildContext): Promise<Record<string, AccountUsage | undefined>>;
	/** Enumerate the pool when it is not stored in this addon's own format. */
	readAccounts?(context: ProviderBuildContext): AccountSlot[];
}

/**
 * A provider package. Each lives in its own directory under `src/providers/`,
 * owns its credentials and failure modes, and never imports a sibling.
 */
export interface ProviderPackage extends AccountPackage {
	/** Build the senpi provider config. Throwing here degrades only this package. */
	build(context: ProviderBuildContext): ProviderConfig | Promise<ProviderConfig>;
}

/**
 * A package that manages a pool stock senpi already owns and streams.
 *
 * `claude` is the case: stock mints the tokens and does the routing, so
 * registering a second provider id would duplicate stock's streaming under a
 * name the user never selected. An observer therefore has no `build`, and the
 * registry skips registration for it while the dashboard still reads its pool.
 */
export interface ObserverPackage extends AccountPackage {
	build?: never;
}

export type AddonPackage = ProviderPackage | ObserverPackage;
