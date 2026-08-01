import type { Api, Model } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

import { nonEmptyString } from "./validation.js";

/**
 * Header carrying the Kiro profile ARN. Previously redeclared as an
 * identical string literal across index.ts, kiro.ts, and oauth.ts.
 */
export const KIRO_PROFILE_ARN_HEADER = "x-kiro-profile-arn";

/**
 * Resolve the Kiro profile ARN from OAuth credentials.
 *
 * Reads the persisted `profileArn` field first, then falls back to a
 * case-insensitive lookup of the profile-ARN request header. Previously
 * defined with identical bodies in index.ts and oauth.ts.
 */
export function profileArnFromCredentials(credentials: OAuthCredentials): string | undefined {
  const profileArn = nonEmptyString(credentials.profileArn);
  if (profileArn) return profileArn;
  const request = credentials.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
  const headers = (request as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === KIRO_PROFILE_ARN_HEADER && typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Stamp the resolved profile ARN onto every model's headers.
 *
 * Returns the models unchanged when no profile ARN is present. Previously
 * the body of the `modifyModels` OAuth-provider method was duplicated in
 * index.ts and oauth.ts.
 */
export function applyProfileArnToModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
  const profileArn = profileArnFromCredentials(credentials);
  if (!profileArn) return models;
  return models.map((model) => ({
    ...model,
    headers: { ...(model.headers ?? {}), [KIRO_PROFILE_ARN_HEADER]: profileArn },
  }));
}

/**
 * Resolve the OAuth provider id and display name from options and config.
 *
 * Previously inlined identically in `createLazyKiroOAuthProvider`
 * (index.ts) and `createKiroOAuthProvider` (oauth.ts). Accepts a narrow
 * structural config type to avoid a circular import with config.ts.
 */
export function resolveOAuthProviderIdentity(
  options: { providerId?: string; displayName?: string },
  config: { providerId?: string },
): { providerId: string; displayName: string } {
  return {
    providerId: nonEmptyString(options.providerId) ?? nonEmptyString(config.providerId) ?? "kiro",
    displayName: nonEmptyString(options.displayName) ?? "Kiro",
  };
}
