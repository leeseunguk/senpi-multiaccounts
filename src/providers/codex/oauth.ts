import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

/**
 * OpenAI Codex (ChatGPT) OAuth.
 *
 * Mirrors the parameters stock senpi uses for its `openai-codex` provider, so
 * the tokens minted here are the same ones stock would mint. senpi does not
 * export its Codex OAuth flow to extensions (only the Anthropic one), hence
 * this local implementation.
 */

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SCOPE = "openid profile email offline_access";
const REQUEST_TIMEOUT_MS = 300_000;

export interface CodexTokens {
	access: string;
	refresh: string;
	/** Epoch millis. */
	expires: number;
	/** ChatGPT account id embedded in the access token. */
	accountId?: string;
	email?: string;
}

export interface CodexLoginCallbacks {
	onAuth(info: { url: string; instructions?: string }): void;
	onProgress?(message: string): void;
	onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
	signal?: AbortSignal;
}

export class CodexAuthError extends Error {
	readonly permanent: boolean;
	readonly status?: number;

	constructor(message: string, options: { permanent?: boolean; status?: number } = {}) {
		super(message);
		this.name = "CodexAuthError";
		this.permanent = options.permanent ?? false;
		if (options.status !== undefined) this.status = options.status;
	}
}

/** Read a claim out of a JWT payload without verifying it. */
function jwtClaim(token: string, path: string[]): string | undefined {
	const segment = token.split(".")[1];
	if (!segment) return undefined;
	try {
		let value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
		for (const key of path) {
			if (typeof value !== "object" || value === null) return undefined;
			value = (value as Record<string, unknown>)[key];
		}
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export function accountIdFromToken(access: string): string | undefined {
	return jwtClaim(access, ["https://api.openai.com/auth", "chatgpt_account_id"]);
}

export function emailFromToken(access: string): string | undefined {
	return jwtClaim(access, ["email"]);
}

function pkce(): { verifier: string; challenge: string; state: string } {
	const verifier = randomBytes(32).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
		state: randomBytes(16).toString("hex"),
	};
}

async function readTokens(response: Response, operation: string): Promise<CodexTokens> {
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const detail =
			(typeof body.error_description === "string" && body.error_description) ||
			(typeof body.error === "string" && body.error) ||
			`HTTP ${response.status}`;
		throw new CodexAuthError(`OpenAI Codex ${operation} failed: ${detail}`, {
			status: response.status,
			permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
		});
	}

	const access = typeof body.access_token === "string" ? body.access_token : undefined;
	const refresh = typeof body.refresh_token === "string" ? body.refresh_token : undefined;
	if (!access || !refresh) throw new CodexAuthError(`OpenAI Codex ${operation} returned no tokens`);

	const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3_600;
	const tokens: CodexTokens = { access, refresh, expires: Date.now() + expiresIn * 1_000 };
	const accountId = accountIdFromToken(access);
	if (accountId) tokens.accountId = accountId;
	const email = emailFromToken(access);
	if (email) tokens.email = email;
	return tokens;
}

interface Callback {
	redirectUri: string;
	wait(): Promise<string | null>;
	cancel(): void;
	close(): Promise<void>;
}

/** Bind the fixed callback port OpenAI requires; null when it is unavailable. */
async function startCallback(): Promise<Callback | null> {
	let settle: ((value: string | null) => void) | null = null;
	let settled = false;
	const received = new Promise<string | null>((resolve) => {
		settle = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
		if (url.pathname !== CALLBACK_PATH) {
			response.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
			response.end("Not found");
			return;
		}
		settle?.(`http://127.0.0.1:${CALLBACK_PORT}${request.url ?? ""}`);
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
		response.end(
			"<!doctype html><meta charset=utf-8><title>OpenAI sign-in complete</title>" +
				"<h1>OpenAI sign-in complete</h1><p>You can close this tab and return to senpi.</p>",
		);
	});

	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("error", onError);
				reject(error);
			};
			server.once("error", onError);
			server.listen(CALLBACK_PORT, "127.0.0.1", () => {
				server.off("error", onError);
				resolve();
			});
		});
	} catch {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		return null;
	}

	return {
		redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
		wait: () => received,
		cancel: () => settle?.(null),
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function parseCallback(input: string, expectedState: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new CodexAuthError("OpenAI sign-in needs the full callback URL", { permanent: true });
	}

	const error = url.searchParams.get("error");
	if (error) throw new CodexAuthError(`OpenAI sign-in was denied: ${error}`, { permanent: true });

	const states = url.searchParams.getAll("state");
	if (states.length !== 1 || states[0] !== expectedState) {
		throw new CodexAuthError("OpenAI sign-in state did not match; start the login again", { permanent: true });
	}

	const codes = url.searchParams.getAll("code");
	const code = codes.length === 1 ? codes[0]?.trim() : undefined;
	if (!code) throw new CodexAuthError("OpenAI sign-in callback carried no authorization code", { permanent: true });
	return code;
}

export async function loginCodex(callbacks: CodexLoginCallbacks): Promise<CodexTokens> {
	const { verifier, challenge, state } = pkce();
	const server = await startCallback();
	const redirectUri = server?.redirectUri ?? `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

	try {
		const authorizeUrl = new URL(AUTHORIZE_URL);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", CODEX_CLIENT_ID);
		authorizeUrl.searchParams.set("redirect_uri", redirectUri);
		authorizeUrl.searchParams.set("scope", SCOPE);
		authorizeUrl.searchParams.set("code_challenge", challenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("state", state);
		// Force the chooser so a second ChatGPT account can be added without
		// signing out of the first.
		authorizeUrl.searchParams.set("prompt", "login");

		callbacks.onAuth({
			url: authorizeUrl.toString(),
			instructions: server
				? "Sign in to ChatGPT. senpi captures the callback automatically; paste the callback URL only if that fails."
				: `Port ${CALLBACK_PORT} is in use, so paste the full callback URL after signing in.`,
		});
		callbacks.onProgress?.("Waiting for the OpenAI sign-in callback...");

		let callbackInput: string;
		if (server) {
			const manual = callbacks
				.onPrompt({ message: "Paste the OpenAI callback URL (only if the browser did not return automatically)" })
				.then((value) => ({ source: "manual" as const, value }));
			const captured = server.wait().then((value) => (value ? { source: "server" as const, value } : null));
			const winner = await Promise.race([captured, manual]);
			if (winner?.source === "manual") server.cancel();
			callbackInput = winner?.value ?? (await server.wait()) ?? "";
		} else {
			callbackInput = await callbacks.onPrompt({ message: "Paste the full OpenAI callback URL" });
		}

		const code = parseCallback(callbackInput, state);
		callbacks.onProgress?.("Exchanging the OpenAI authorization code...");

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CODEX_CLIENT_ID,
				code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		return await readTokens(response, "token exchange");
	} finally {
		await server?.close().catch(() => undefined);
	}
}

export async function refreshCodex(tokens: CodexTokens): Promise<CodexTokens> {
	if (!tokens.refresh) throw new CodexAuthError("OpenAI credential has no refresh token", { permanent: true });

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CODEX_CLIENT_ID,
			refresh_token: tokens.refresh,
			scope: SCOPE,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	const refreshed = await readTokens(response, "token refresh");
	// OpenAI may omit a rotated refresh token; keep the existing one.
	return { ...refreshed, refresh: refreshed.refresh || tokens.refresh };
}
