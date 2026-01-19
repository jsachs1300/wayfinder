import { readFileSync } from 'fs';
import { buildRoutingPrompt } from '../src/routing/router-llm/prompt-builder';
import { DefaultModelRegistry } from '../src/models/registry';

function readPrompt(): string {
  const promptFile = process.env.PROMPT_FILE;
  const prompt = process.env.PROMPT;

  if (promptFile) {
    return readFileSync(promptFile, 'utf8');
  }

  if (prompt) {
    return prompt;
  }

  throw new Error('Set PROMPT or PROMPT_FILE to build the router prompt.');
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function readEligibleModels(): string[] {
  const modelsFile = process.env.ELIGIBLE_MODELS_FILE;
  const models = process.env.ELIGIBLE_MODELS;

  if (modelsFile) {
    return parseList(readFileSync(modelsFile, 'utf8'));
  }

  if (models) {
    return parseList(models);
  }

  const registry = new DefaultModelRegistry();
  return registry
    .getAvailableModels()
    .filter(model => model.global_eligible)
    .map(model => model.id);
}

const prompt = readPrompt();
const eligibleModels = readEligibleModels();
const preferModel = process.env.PREFER_MODEL || undefined;

const routingPrompt = buildRoutingPrompt({
  prompt,
  eligibleModels,
  tokenConfig: {
    id: process.env.TOKEN_ID || 'manual',
    token_hash: process.env.TOKEN_HASH || 'manual',
    created_at: process.env.TOKEN_CREATED_AT || new Date().toISOString(),
    updated_at: process.env.TOKEN_UPDATED_AT || new Date().toISOString(),
  },
  preferModel,
  requestMetadata: {},
});

process.stdout.write(routingPrompt);
