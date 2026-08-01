import { afterEach, describe, expect, it, vi } from "vitest";
import { KiroAuthError, type KiroTokens, type LoginCallbacks, loginKiro, refreshKiro } from "../src/providers/kiro/oauth.js";

type FetchArgs = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

const originalFetch = globalThis.fetch;
const calls: FetchArgs[] = [];

function mockFetch(routes: Record<string, { status?: number; body: unknown }>): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({
			url,
			body: init?.body ? JSON.parse(String(init.body)) : {},
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		const route = Object.entries(routes).find(([pattern]) => url.includes(pattern))?.[1];
		if (!route) throw new Error(`unexpected fetch: ${url}`);
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

function callbacks(overrides: Partial<LoginCallbacks> = {}): LoginCallbacks {
	return {
		onAuth: vi.fn(),
		onPrompt: vi.fn(async () => ""),
		...overrides,
	};
}

function socialTokens(overrides: Partial<KiroTokens> = {}): KiroTokens {
	return {
		access: "old-access",
		refresh: "refresh-token",
		expires: 0,
		authMethod: "google",
		region: "us-east-1",
		...overrides,
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	calls.length = 0;
	vi.restoreAllMocks();
});

describe("social login", () => {
	it("exchanges a pasted callback for tokens and keeps the profile ARN", async () => {
		mockFetch({
			"/oauth/token": {
				body: {
					accessToken: "new-access",
					refreshToken: "new-refresh",
					expiresIn: 3600,
					profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/ABC",
				},
			},
		});

		let authorizeUrl = "";
		const tokens = await loginKiro(
			callbacks({
				onAuth: (info) => {
					authorizeUrl = info.url;
				},
				onPrompt: async () => {
					const state = new URL(authorizeUrl).searchParams.get("state");
					return `http://localhost:3128/oauth/callback?code=auth-code&state=${state}`;
				},
			}),
			"google",
		);

		expect(tokens.access).toBe("new-access");
		expect(tokens.refresh).toBe("new-refresh");
		expect(tokens.authMethod).toBe("google");
		expect(tokens.profileArn).toBe("arn:aws:codewhisperer:us-east-1:1:profile/ABC");
		expect(tokens.expires).toBeGreaterThan(Date.now());

		const exchange = calls.find((call) => call.url.includes("/oauth/token"));
		expect(exchange?.body.code).toBe("auth-code");
		expect(exchange?.body.code_verifier).toEqual(expect.any(String));
	});

	it("sends a PKCE S256 challenge, never the verifier", async () => {
		mockFetch({ "/oauth/token": { body: { accessToken: "a", refreshToken: "r", expiresIn: 60 } } });

		let authorizeUrl = "";
		await loginKiro(
			callbacks({
				onAuth: (info) => {
					authorizeUrl = info.url;
				},
				onPrompt: async () => {
					const state = new URL(authorizeUrl).searchParams.get("state");
					return `http://localhost:3128/oauth/callback?code=c&state=${state}`;
				},
			}),
			"google",
		);

		const params = new URL(authorizeUrl).searchParams;
		expect(params.get("code_challenge_method")).toBe("S256");
		const challenge = params.get("code_challenge");
		const verifier = calls.find((call) => call.url.includes("/oauth/token"))?.body.code_verifier;
		expect(challenge).toBeTruthy();
		expect(challenge).not.toBe(verifier);
	});

	it("rejects a callback whose state does not match", async () => {
		mockFetch({ "/oauth/token": { body: {} } });

		await expect(
			loginKiro(
				callbacks({ onPrompt: async () => "http://localhost:3128/oauth/callback?code=c&state=attacker" }),
				"google",
			),
		).rejects.toThrow(/state did not match/);
		expect(calls.some((call) => call.url.includes("/oauth/token"))).toBe(false);
	});

	it("reports a denied authorization", async () => {
		mockFetch({ "/oauth/token": { body: {} } });
		await expect(
			loginKiro(callbacks({ onPrompt: async () => "http://localhost:3128/oauth/callback?error=access_denied" }), "github"),
		).rejects.toThrow(/denied/);
	});
});

describe("builder id login", () => {
	it("polls until authorization completes, then returns tokens with client metadata", async () => {
		mockFetch({
			"client/register": { body: { clientId: "cid", clientSecret: "secret" } },
			device_authorization: {
				// 1s is the smallest interval the flow honours; keeps the poll real but fast.
				body: { deviceCode: "dev", userCode: "USER-CODE", verificationUriComplete: "https://device.example", interval: 1, expiresIn: 60 },
			},
			"/token": { body: { accessToken: "idc-access", refreshToken: "idc-refresh", expiresIn: 3600 } },
		});

		const onDeviceCode = vi.fn();
		const tokens = await loginKiro(callbacks({ onDeviceCode }), "builder-id");

		expect(tokens.authMethod).toBe("builder-id");
		expect(tokens.access).toBe("idc-access");
		// Client metadata must persist or the credential can never refresh.
		expect(tokens.clientId).toBe("cid");
		expect(tokens.clientSecret).toBe("secret");
		expect(onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: "USER-CODE" }));
	});

	it("stops polling as soon as the login is aborted", async () => {
		mockFetch({
			"client/register": { body: { clientId: "cid", clientSecret: "secret" } },
			device_authorization: {
				body: { deviceCode: "dev", userCode: "CODE", verificationUriComplete: "https://device.example", interval: 30, expiresIn: 600 },
			},
			"/token": { body: { error: "authorization_pending" } },
		});

		const controller = new AbortController();
		const pending = loginKiro(callbacks({ signal: controller.signal }), "builder-id");
		// Abort while the flow is sleeping between polls; it must reject promptly
		// rather than waiting out the 30s interval.
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "KiroAuthError", permanent: true });
	});
});

describe("method selection", () => {
	it("offers Google, GitHub and Builder ID", async () => {
		mockFetch({ "/oauth/token": { body: { accessToken: "a", refreshToken: "r", expiresIn: 60 } } });
		const onSelect = vi.fn(async (_prompt: { message: string; options: { id: string; label: string }[] }) => "google");

		let authorizeUrl = "";
		await loginKiro(
			callbacks({
				onSelect,
				onAuth: (info) => {
					authorizeUrl = info.url;
				},
				onPrompt: async () => {
					const state = new URL(authorizeUrl).searchParams.get("state");
					return `http://localhost:3128/oauth/callback?code=c&state=${state}`;
				},
			}),
		);

		const offered = onSelect.mock.calls[0]?.[0] as unknown as { options: { id: string }[] } | undefined;
		expect(offered?.options.map((option) => option.id)).toEqual(["google", "github", "builder-id"]);
	});

	it("treats a cancelled selection as permanent", async () => {
		await expect(loginKiro(callbacks({ onSelect: async () => undefined }))).rejects.toMatchObject({
			name: "KiroAuthError",
			permanent: true,
		});
	});
});

describe("refresh", () => {
	it("refreshes social tokens through the Kiro auth service", async () => {
		mockFetch({
			"/refreshToken": { body: { accessToken: "rotated", refreshToken: "rotated-refresh", expiresIn: 3600, profileArn: "arn:new" } },
		});

		const refreshed = await refreshKiro(socialTokens());

		expect(refreshed.access).toBe("rotated");
		expect(refreshed.refresh).toBe("rotated-refresh");
		expect(refreshed.profileArn).toBe("arn:new");
		expect(calls[0]?.url).toContain("/refreshToken");
	});

	it("keeps the existing refresh token when the service does not rotate it", async () => {
		mockFetch({ "/refreshToken": { body: { accessToken: "rotated", expiresIn: 3600 } } });
		const refreshed = await refreshKiro(socialTokens());
		expect(refreshed.refresh).toBe("refresh-token");
	});

	it("refreshes Builder ID tokens through SSO OIDC", async () => {
		mockFetch({ "oidc.us-east-1.amazonaws.com/token": { body: { accessToken: "idc-new", expiresIn: 3600 } } });

		const refreshed = await refreshKiro(
			socialTokens({ authMethod: "builder-id", clientId: "cid", clientSecret: "secret" }),
		);

		expect(refreshed.access).toBe("idc-new");
		expect(calls[0]?.url).toContain("oidc.us-east-1.amazonaws.com/token");
		expect(calls[0]?.body.grantType).toBe("refresh_token");
	});

	it("fails permanently when Builder ID client metadata is missing", async () => {
		await expect(refreshKiro(socialTokens({ authMethod: "builder-id" }))).rejects.toMatchObject({
			permanent: true,
		});
	});

	it("marks a rejected refresh token as permanent so the account blocks", async () => {
		mockFetch({ "/refreshToken": { status: 400, body: { error: "invalid_grant" } } });

		const error = await refreshKiro(socialTokens()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(KiroAuthError);
		expect((error as KiroAuthError).permanent).toBe(true);
	});

	it("treats a 429 during refresh as retryable", async () => {
		mockFetch({ "/refreshToken": { status: 429, body: { message: "slow down" } } });

		const error = await refreshKiro(socialTokens()).catch((caught: unknown) => caught);
		expect((error as KiroAuthError).permanent).toBe(false);
	});
});
