import type { Request } from 'express';

function extractBearerToken(authorizationHeader: unknown): string | undefined {
  if (typeof authorizationHeader !== 'string') {
    return undefined;
  }

  if (!authorizationHeader.startsWith('Bearer ')) {
    return undefined;
  }

  const token = authorizationHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function extractMcpBodyToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const maybeParams = (body as Record<string, unknown>).params;
  if (typeof maybeParams !== 'object' || maybeParams === null) {
    return undefined;
  }

  const maybeArgs = (maybeParams as Record<string, unknown>).arguments;
  if (typeof maybeArgs !== 'object' || maybeArgs === null) {
    return undefined;
  }

  const maybeToken = (maybeArgs as Record<string, unknown>).token;
  return typeof maybeToken === 'string' && maybeToken.length > 0 ? maybeToken : undefined;
}

export function extractWayfinderToken(req: Request, argsToken?: string): string | undefined {
  const tokenHeader = req.headers['x-wayfinder-token'];
  if (typeof tokenHeader === 'string' && tokenHeader.length > 0) {
    return tokenHeader;
  }

  const bearerToken = extractBearerToken(req.headers.authorization);
  if (bearerToken) {
    return bearerToken;
  }

  if (argsToken) {
    return argsToken;
  }

  return extractMcpBodyToken(req.body);
}

export function extractWayfinderTokenForRateLimit(req: Request): string | undefined {
  return extractWayfinderToken(req);
}
