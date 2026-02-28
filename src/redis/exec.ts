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
      throw error;
    }
  }

  return results;
}
