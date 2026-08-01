export type HeaderDropReporter = (headerName: string) => void;

export function isAuthorizationHeaderName(headerName: string): boolean {
  return headerName.trim().toLowerCase() === "authorization";
}

export function omitAuthorizationHeaders(headers: Record<string, string> | undefined, onDrop?: HeaderDropReporter): Record<string, string> {
  if (!headers) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isAuthorizationHeaderName(key)) {
      onDrop?.(key);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
