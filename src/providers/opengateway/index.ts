import type { ProviderPackage } from "../../core/types.js";
import { OPENGATEWAY_MODELS } from "./models.js";

export const OPENGATEWAY_PROVIDER_ID = "opengateway";
export const OPENGATEWAY_BASE_URL = "https://apis.opengateway.ai/v1";

export { OPENGATEWAY_MODELS, type OpenGatewayModel } from "./models.js";

/**
 * OpenGateway is a single API-key provider. Declaring the environment-backed
 * key without a custom OAuth flow lets senpi supply its native `/login`
 * API-key prompt, persistence, replacement, and `/logout` management.
 *
 * The package deliberately registers before a key exists: `/login` discovers
 * extension providers from the registered model catalog, so credential-gating
 * registration would make first-time login impossible.
 */
export function opengatewayProviderPackage(): ProviderPackage {
	return {
		id: OPENGATEWAY_PROVIDER_ID,
		label: "OpenGateway",
		build() {
			return {
				name: "OpenGateway",
				baseUrl: OPENGATEWAY_BASE_URL,
				api: "openai-completions",
				apiKey: "$OPENGATEWAY_API_KEY",
				models: OPENGATEWAY_MODELS,
			};
		},
	};
}
