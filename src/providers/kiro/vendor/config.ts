/**
 * Minimal configuration surface required by the vendored CodeWhisperer stream.
 *
 * The upstream package (pi-kiro-provider, MIT) carried a much larger config
 * loader covering JSON files, model catalogs and OAuth settings. This addon
 * supplies those from its own modules, so only the fields `kiro.ts` actually
 * reads are declared here.
 */

export const KIRO_API = "kiro-codewhisperer" as const;

/**
 * `codewhisperer` targets the CodeWhisperer streaming endpoint used by Kiro
 * subscriptions; `amazonq` targets the Amazon Q CLI endpoint, which needs
 * different headers and message origins.
 */
export type KiroEndpoint = "codewhisperer" | "amazonq";

export interface ExtensionConfig {
	providerId: string;
	upstreamUrl: string;
	endpoint: KiroEndpoint;
	apiKey: string;
	requestTimeoutMs: number;
	headers: Record<string, string>;
	profileArn?: string;
}
