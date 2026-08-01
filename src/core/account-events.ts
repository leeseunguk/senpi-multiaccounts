export interface ProviderAccountsChangedEvent {
	readonly type: "accounts_changed";
	readonly provider: string;
}

const PROVIDER_ACCOUNT_EVENT_BRIDGE = Symbol.for("senpi.provider-account-events.emit.v1");

type ProviderAccountEventGlobal = typeof globalThis & {
	[PROVIDER_ACCOUNT_EVENT_BRIDGE]?: (event: ProviderAccountsChangedEvent) => void;
};

/** Notify stock Senpi RPC/app-server listeners after an addon-owned mutation. */
export function notifyProviderAccountsChanged(provider: string): void {
	(globalThis as ProviderAccountEventGlobal)[PROVIDER_ACCOUNT_EVENT_BRIDGE]?.({
		type: "accounts_changed",
		provider,
	});
}
