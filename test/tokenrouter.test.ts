import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resolveTokenRouterModels,
	TOKENROUTER_MODELS,
	TOKENROUTER_PROVIDER_ID,
	tokenrouterProviderPackage,
} from "../src/providers/tokenrouter/index.js";

function agentDirWith(auth: Record<string, unknown>): string {
	const dir = mkdtempSync(resolve(tmpdir(), "senpi-accounts-tokenrouter-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
	return dir;
}

describe("tokenrouter provider package", () => {
	let dirs: string[];

	beforeEach(() => {
		dirs = [];
	});

	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	function context(auth: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
		const dir = agentDirWith(auth);
		dirs.push(dir);
		return { env, agentDir: dir };
	}

	it("registers under the id senpi's /login uses", () => {
		expect(tokenrouterProviderPackage().id).toBe("tokenrouter");
		expect(TOKENROUTER_PROVIDER_ID).toBe("tokenrouter");
	});

	it("exposes kimi-k3 in its catalog, since an extension provider inherits none", () => {
		const built = tokenrouterProviderPackage().build(context({ tokenrouter: { type: "api_key", key: "sk-x" } }));
		const ids = (built as { models?: { id: string }[] }).models?.map((model) => model.id) ?? [];
		expect(ids).toContain("moonshotai/kimi-k3-free");
	});

	it("points at TokenRouter's OpenAI-compatible endpoint", () => {
		const built = tokenrouterProviderPackage().build(context({ tokenrouter: { type: "api_key", key: "sk-x" } }));
		expect(built).toMatchObject({ baseUrl: "https://api.tokenrouter.com/v1", api: "openai-completions" });
	});

	it("serves the stored key to senpi so /login is enough to authenticate", () => {
		const built = tokenrouterProviderPackage().build(context({ tokenrouter: { type: "api_key", key: "sk-stored" } }));
		const oauth = (built as { oauth?: { getApiKey?: (credentials: unknown) => string } }).oauth;
		expect(oauth?.getApiKey?.({ type: "api_key", key: "sk-stored" })).toBe("sk-stored");
	});

	it("prefers an explicit env key over the stored credential", () => {
		const built = tokenrouterProviderPackage().build(
			context({ tokenrouter: { type: "api_key", key: "sk-stored" } }, { TOKENROUTER_API_KEY: "sk-env" }),
		);
		expect((built as { apiKey?: string }).apiKey).toBe("sk-env");
	});

	it("skips registration when no credential exists rather than degrading the addon", () => {
		const dir = agentDirWith({});
		dirs.push(dir);
		const reason = tokenrouterProviderPackage().enabled?.({}, { env: {}, agentDir: dir });
		expect(typeof reason).toBe("string");
		expect(reason).toMatch(/login tokenrouter/);
	});

	it("registers once a credential is present", () => {
		const dir = agentDirWith({ tokenrouter: { type: "api_key", key: "sk-x" } });
		dirs.push(dir);
		expect(tokenrouterProviderPackage().enabled?.({}, { env: {}, agentDir: dir })).toBe(true);
	});

	it("keeps every catalog entry priced and bounded, so senpi can budget a turn", () => {
		for (const model of TOKENROUTER_MODELS) {
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.cost.input).toBeGreaterThanOrEqual(0);
			expect(model.cost.output).toBeGreaterThanOrEqual(0);
		}
	});

	it("declares the dialect limits TokenRouter actually rejects", () => {
		// Measured against the live endpoint: role "developer" answers HTTP 400
		// "role 'developer' is not allowed", and `store: false` answers HTTP 200 with a
		// whitespace body and no completion. senpi sends both by default for an
		// `openai-completions` provider, which turned a working curl into a 422 turn.
		for (const model of TOKENROUTER_MODELS) {
			expect(model.compat.supportsDeveloperRole).toBe(false);
			expect(model.compat.supportsStore).toBe(false);
			expect(model.compat.maxTokensField).toBe("max_tokens");
		}
	});

	it("carries the same limits onto an overridden model, which is where they bite", () => {
		const [model] = resolveTokenRouterModels({ TOKENROUTER_MODELS_OVERRIDE: "vendor/unknown-model" });
		expect(model?.id).toBe("vendor/unknown-model");
		expect(model?.compat.supportsDeveloperRole).toBe(false);
		expect(model?.compat.supportsStore).toBe(false);
	});

	it("exposes both kimi-k3 variants, since the free one queues for minutes", () => {
		const ids = TOKENROUTER_MODELS.map((model) => model.id);
		expect(ids).toContain("moonshotai/kimi-k3-free");
		expect(ids).toContain("moonshotai/kimi-k3");
	});
});
