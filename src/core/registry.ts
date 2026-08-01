import type { AddonPackage, ProviderBuildContext, ProviderHealth, SenpiExtensionAPI } from "./types.js";

const EXTENSION_ID = "@eddieparc/senpi-multiaccounts";

/**
 * Senpi builds a fresh extension module and API object on reload but keeps the
 * EventBus owned by its resource loader. A global symbol lets the reloaded
 * module find the ids this extension registered previously, so providers that
 * disappear from the manifest can be unregistered instead of leaking.
 */
const ownedProviderIdsKey = Symbol.for(`${EXTENSION_ID}:owned-provider-ids`);

function ownedProviderIds(pi: SenpiExtensionAPI): Set<string> {
	const eventBus = pi.events as unknown as Record<symbol, unknown>;
	const existing = eventBus[ownedProviderIdsKey];
	if (existing instanceof Set) return existing as Set<string>;

	const created = new Set<string>();
	Object.defineProperty(eventBus, ownedProviderIdsKey, { value: created });
	return created;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface RegisterResult {
	health: ProviderHealth[];
}

/**
 * Register every provider package in isolation.
 *
 * Each package is built and registered inside its own try/catch: a package that
 * throws while loading, building, or registering is reported as `degraded` and
 * every other package still registers. This is the fault-isolation guarantee —
 * one broken provider must never take the addon (or senpi) down with it.
 */
export async function registerProviderPackages(
	pi: SenpiExtensionAPI,
	packages: readonly AddonPackage[],
	context: ProviderBuildContext,
): Promise<RegisterResult> {
	const owned = ownedProviderIds(pi);
	const health: ProviderHealth[] = [];
	const registeredNow = new Set<string>();

	for (const providerPackage of packages) {
		const { id } = providerPackage;
		try {
			const enabled = providerPackage.enabled?.(context.env, context) ?? true;
			if (enabled !== true) {
				health.push({ status: "skipped", providerId: id, reason: enabled });
				continue;
			}

			// An observer package (claude) has no config of its own: stock senpi
			// already registers and streams that provider, and this addon only
			// reads and edits its pool. Registering a second id would shadow it.
			if (providerPackage.build === undefined) {
				health.push({ status: "registered", providerId: id });
				continue;
			}

			const config = await providerPackage.build(context);
			pi.registerProvider(id, config);
			owned.add(id);
			registeredNow.add(id);
			health.push({ status: "registered", providerId: id });
		} catch (error) {
			health.push({
				status: "degraded",
				providerId: id,
				reason: errorMessage(error),
				error,
			});
			console.error(`${EXTENSION_ID}: provider '${id}' failed to register: ${errorMessage(error)}`);
		}
	}

	// Providers this module registered on an earlier load but which no longer
	// register (removed or now disabled) must be released, or a stale provider
	// would linger with credentials senpi can no longer refresh.
	for (const providerId of [...owned]) {
		if (registeredNow.has(providerId)) continue;
		try {
			pi.unregisterProvider(providerId);
			owned.delete(providerId);
		} catch (error) {
			console.error(`${EXTENSION_ID}: could not unregister provider '${providerId}': ${errorMessage(error)}`);
		}
	}

	return { health };
}

export { EXTENSION_ID };
