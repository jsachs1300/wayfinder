const MAX_ERROR_BODY_CHARS = 1200;

export function sanitizeSensitive(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(x-api-key[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, 'sk-[REDACTED]')
    .replace(/(AIza[0-9A-Za-z_-]{8,})/g, 'AIza[REDACTED]');
}

export function validateProviderApiKey(provider: string, apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) {
    throw new Error(`${provider} model catalog API key must be non-empty`);
  }
  if (/\s/.test(normalized)) {
    throw new Error(`${provider} model catalog API key must not contain whitespace`);
  }
  return normalized;
}

export async function buildCatalogRequestError(
  provider: string,
  response: Response
): Promise<Error> {
  const body = sanitizeSensitive((await response.text()).slice(0, MAX_ERROR_BODY_CHARS));
  return new Error(`${provider} model catalog request failed (${response.status}): ${body}`);
}
