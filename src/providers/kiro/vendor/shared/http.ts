import { isRecord, type JsonRecord } from "./validation.js";

/**
 * Read and parse an HTTP response body as a JSON record.
 *
 * Returns `{}` for empty bodies and `{ message }` for non-object or
 * unparseable bodies. Previously duplicated in kiro.ts and oauth.ts with
 * only the non-object message string differing; the message is now passed
 * by each caller so behavior is preserved exactly.
 */
export async function readJsonResponse(response: Response, nonObjectMessage: string): Promise<JsonRecord> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { message: nonObjectMessage };
  } catch {
    return { message: text };
  }
}
