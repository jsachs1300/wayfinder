import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RAW_RESPONSE_DUMP_ENV = 'ROUTER_LLM_RAW_RESPONSE_DUMP_DIR';

interface RawResponseDumpInput {
  provider: string;
  model?: string;
  rawResponse: string;
  parseError: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function dumpRawRouterResponse(input: RawResponseDumpInput): Promise<string | undefined> {
  const dumpDir = process.env[RAW_RESPONSE_DUMP_ENV];
  if (!dumpDir) {
    return undefined;
  }

  const now = new Date();
  const timestamp = now.toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');
  const fileName = `${safeTimestamp}-${input.provider}-${randomUUID()}.json`;
  const dumpPath = path.join(dumpDir, fileName);

  await mkdir(dumpDir, { recursive: true });
  await writeFile(
    dumpPath,
    JSON.stringify(
      {
        timestamp,
        provider: input.provider,
        model: input.model,
        parse_error: input.parseError,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        response_length: input.rawResponse.length,
        raw_response: input.rawResponse,
      },
      null,
      2
    ),
    'utf8'
  );

  return dumpPath;
}
