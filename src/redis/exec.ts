export type RedisExecResult = Array<[Error | null, unknown]>;

export function assertRedisExecResults(
  results: RedisExecResult | null,
  context: string
): RedisExecResult {
  if (!results) {
    throw new Error(`Redis transaction aborted in ${context}`);
  }

  for (const [error] of results) {
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Redis command error in ${context}: ${message}`, { cause: error });
    }
  }

  return results;
}
