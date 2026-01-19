# LangCache Attributes Implementation Design

## Executive Summary

This document outlines the design for implementing LangCache attributes to enable:
1. **Token-scoped caching** - Prevent cache pollution across different tokens with different policies
2. **Router-model-specific caching** - Cache separate responses for OpenAI, Gemini, and consensus routing decisions
3. **Improved cache hit rates** - More granular cache keys lead to correct hits and avoid false positives

## Requirements Analysis

### 1. Scope Attribute ✅ **VALID & RECOMMENDED**

**Proposed Values:** `"global"` or custom token-specific scope

**Analysis:**
- **Problem it solves:** Current implementation has a global cache shared across all tokens, which can cause incorrect cache hits when:
  - Token A allows models X, Y, Z
  - Token B only allows model X
  - Same prompt for both tokens should NOT return the same cached result

- **Why it's critical:**
  - Different tokens have different policies (RestrictModelsByIntent, ForceModelByIntent, etc.)
  - Different tokens may have different `allowed_models` or `eligible_models`
  - Cache hits from Token A's policy context should never be returned for Token B

- **Current workaround:** We include `eligible_models_hash` in the cache key, but this doesn't capture all policy differences (e.g., confidence thresholds, anchor models)

**Recommendation:** ✅ **IMPLEMENT** - Use `token_id` as scope attribute for production. Use `"global"` for testing only.

### 2. Router Model Attribute ✅ **VALID & RECOMMENDED**

**Proposed Values:** `"openai"` | `"gemini"` | `"consensus"`

**Analysis:**
- **Problem it solves:** Same prompt can produce different routing decisions depending on which router LLM is used:
  - OpenAI GPT-4o-mini might rank models differently than Gemini 1.5-flash
  - Consensus aggregates both providers' rankings using weighted scoring
  - Users can specify `router_model` in request to get specific provider's decision

- **Current issue:** Cache doesn't differentiate between router models, so:
  - If prompt is cached with OpenAI's decision, a request specifying `router_model: "gemini"` would get the wrong cached result
  - Consensus results might be returned when user explicitly requested a specific provider

- **Multi-provider context:**
  - Location: `src/routing/router-llm/multi-provider-router-llm.ts`
  - Supports aggregating results from multiple providers
  - Each provider can be enabled/disabled independently

**Recommendation:** ✅ **IMPLEMENT** - Critical for correctness when users specify `router_model` preference.

## Additional Attributes Recommended

### 3. Policy Version Attribute ⚠️ **CONSIDER**

**Proposed Values:** Hash of token policy configuration

**Rationale:**
- When token policy is updated (e.g., adding RestrictModelsByIntent rule), old cached responses may violate new policy
- Including policy version in attributes would auto-invalidate cache on policy changes

**Trade-off:**
- **Pro:** Automatic cache invalidation on policy changes
- **Con:** Reduced cache hit rate when policies are updated frequently
- **Con:** Added complexity in computing policy hash

**Recommendation:** ⚠️ **DEFER** - Current `eligible_models_hash` provides similar protection. Implement only if cache correctness issues arise.

### 4. Model Registry Version ❌ **NOT RECOMMENDED**

**Rationale:**
- Available models change infrequently
- When they do change, it's a deployment event (new code)
- LangCache TTL (default 1 hour) provides natural cache refresh

**Recommendation:** ❌ **SKIP** - Not worth the complexity.

## Architectural Decision: Remove default_model Field

### Current State: default_model is Vestigial

**Analysis:** After reviewing the entire codebase, `default_model` is **stored and validated but never actually used** in routing logic.

**Findings:**
- ✅ Defined in `src/types/index.ts` - type definitions
- ✅ Validated in `src/models/registry.ts:409-417` - validates it exists
- ✅ Validated in `src/models/registry.ts:466-495` - validates not denied, in allowed_models
- ✅ Accepted in `src/tokens/routes.ts` - admin API accepts it
- ✅ Stored in `src/tokens/store.ts` - stores it in token config
- ❌ **NEVER REFERENCED** in `src/routing/engine.ts` - the actual routing code
- ❌ No fallback logic anywhere that uses it
- ❌ The `RoutingReason` type includes `'default_model_fallback'` but it's **dead code**

**Current failure behavior (src/routing/engine.ts:248-255):**
```typescript
// When policy evaluation results in zero eligible models
if (eligibleModels.length === 0) {
  throw new Error(
    'No eligible models available after policy evaluation. ' +
    'Please check your token configuration...'
  );
  // NOTE: Does NOT fall back to default_model - just throws error
}
```

**What happens when routing completely fails:**
1. If zero eligible models: Throws error (never uses default_model)
2. If router LLM fails: Error is propagated (never uses default_model)
3. If policy forces invalid model: Throws error (never uses default_model)

**Conclusion:** `default_model` adds complexity (validation, documentation, user confusion) without providing any value.

### Proposed Change: Remove default_model Entirely

**Rationale:**
1. It's never used in routing logic (vestigial code)
2. Users expect it to be a fallback, but it isn't (misleading)
3. Adds validation complexity with no benefit
4. If we need a fallback, use first model in `eligible_models` list

**Fallback Strategy:**
```typescript
// When router fails or needs fallback, use first model in eligible_models
function getFallbackModel(tokenConfig: TokenConfig, modelRegistry: ModelRegistry): string {
  const eligibleModels = getEligibleModels(tokenConfig, modelRegistry);

  if (eligibleModels.length === 0) {
    throw new Error('No eligible models available for fallback');
  }

  return eligibleModels[0];  // First model in list is fallback
}
```

**Migration:**
- Remove `default_model` from TokenConfig type
- Remove `default_model` validation from ModelRegistry
- Remove `default_model` from token creation/update APIs
- Update documentation to remove `default_model` references
- Use first model in `eligible_models` if fallback needed (or continue throwing error)

**User Impact:**
- **Breaking change:** Tokens with `default_model` will ignore it (no error, just unused)
- **Benefit:** Clearer mental model - eligible_models defines what's available, first in list is preferred
- **Migration:** Users can simply remove `default_model` from their token configs

## Architectural Decision: Eligible Models in Token Config

### Current Architecture (Dynamic Computation)

**How it works now:**
```typescript
// src/routing/engine.ts - computed on every request
const eligibleModels = this.policyEngine.evaluatePolicy(
  tokenConfig,
  prompt,
  allModelsFromRegistry
);
// Result: Models filtered by allowed_models, denied_models, RestrictModelsByIntent, etc.
```

**Problems:**
1. **Variable cache key**: Same token + prompt can have different eligible models depending on:
   - Policy rule updates
   - Intent classification changes
   - Model registry changes
2. **Cache pollution**: `eligible_models_hash` changes even though token hasn't changed
3. **Complexity**: Need to hash eligible models and include in cache key
4. **Poor cache hit rate**: Small policy tweaks invalidate entire cache

### Proposed Architecture (Token-Scoped Configuration)

**How it should work:**
```typescript
// Token configuration with optional eligible_models override
interface TokenConfig {
  token_id: string;
  eligible_models?: string[];  // OPTIONAL: Override system default
  // ... other fields
}

// System-wide default eligible_models (all models in registry)
function getEligibleModels(tokenConfig: TokenConfig): string[] {
  return tokenConfig.eligible_models ?? modelRegistry.getAllModels().map(m => m.id);
}

// Fallback strategy: Use first model in eligible_models when router fails
function getFallbackModel(tokenConfig: TokenConfig, modelRegistry: ModelRegistry): string {
  const eligible = getEligibleModels(tokenConfig, modelRegistry);
  if (eligible.length === 0) {
    throw new Error('No eligible models available for fallback');
  }
  return eligible[0];  // First model in list is fallback
}

// Cache key is simple - no eligible_models hash needed
const cacheKey = {
  prompt: hashedPrompt,
  attributes: {
    scope: tokenConfig.token_id,  // Implicitly includes eligible_models
    router_model: routerModel
  }
};
```

**Benefits:**
1. ✅ **Simpler caching**: Token scope implicitly captures eligible models
2. ✅ **Higher cache hit rate**: Policy updates don't invalidate cache (unless eligible_models changed)
3. ✅ **Better isolation**: Each token's cache contains only its configured models
4. ✅ **Clearer semantics**: Token config is single source of truth for what models are available
5. ✅ **Predictable behavior**: Same token always has same eligible models
6. ✅ **Flexible defaults**: Most tokens use system default, only override when needed

### Implementation Strategy

#### Option A: Replace Dynamic Policy with Static Config (RECOMMENDED)

**Token configuration:**
```typescript
interface TokenConfig {
  token_id: string;
  eligible_models?: string[];  // OPTIONAL: Override system default
  confidence_threshold?: number;
  // Remove: allowed_models, denied_models (replaced by eligible_models)
  // Remove: default_model (vestigial - never used in routing logic)
}

// System default (all models in registry)
const DEFAULT_ELIGIBLE_MODELS = () => modelRegistry.getAllModels().map(m => m.id);

// Fallback: Use first model in eligible_models list
const getFallbackModel = (tokenConfig: TokenConfig, modelRegistry: ModelRegistry): string => {
  const eligible = tokenConfig.eligible_models ?? DEFAULT_ELIGIBLE_MODELS();
  return eligible[0];  // First model in list
};
```

**Policy engine becomes simpler:**
```typescript
// Policy engine only handles intent-based forcing, not filtering
class PolicyEngine {
  evaluatePolicy(tokenConfig, prompt) {
    // Check ForceModelByIntent rules
    const forcedModel = this.checkForceModelRules(tokenConfig, prompt);
    if (forcedModel) {
      return { forced: true, model: forcedModel };
    }

    // Return token's eligible models (or system default)
    const eligibleModels = tokenConfig.eligible_models ?? DEFAULT_ELIGIBLE_MODELS();
    return { forced: false, eligibleModels };
  }
}
```

**Routing engine:**
```typescript
// No more eligible_models hash in cache key!
const cacheKey = {
  prompt: hashedPrompt,
  attributes: {
    scope: tokenConfig.token_id,  // Scope includes eligible_models implicitly
    router_model: routerModel
  }
};
```

#### Option B: Compute Once at Token Creation (Alternative)

**Token creation/update:**
```typescript
// When token is created or updated, compute eligible_models once
async function createToken(config) {
  const allModels = modelRegistry.getAllModels();

  // Apply allowed/denied filters once
  let eligibleModels = allModels.filter(m =>
    !config.denied_models?.includes(m.id)
  );

  if (config.allowed_models) {
    eligibleModels = eligibleModels.filter(m =>
      config.allowed_models.includes(m.id)
    );
  }

  // Store as static list
  return {
    ...config,
    eligible_models: eligibleModels.map(m => m.id)
  };
}
```

**Trade-offs:**
- **Option A**: Simpler, more explicit, easier to understand
- **Option B**: Preserves some dynamic behavior, more complex

**Recommendation:** ✅ **Option A** - Make eligible_models a required token configuration field.

### Migration Path for Existing Tokens

**Step 1: eligible_models is optional - no migration needed**
```typescript
// Existing tokens without eligible_models automatically use system default
for (const token of allTokens) {
  // No migration needed - tokens without eligible_models use DEFAULT_ELIGIBLE_MODELS()
  // Only tokens with allowed_models/denied_models need explicit eligible_models

  if (token.allowed_models || token.denied_models) {
    // Optionally convert to eligible_models for clarity
    const eligible = computeEligibleModels(token);
    console.log(`Token ${token.token_id} could use eligible_models: [${eligible.join(', ')}]`);
    // But don't automatically migrate - let users opt-in
  }
}
```

**Step 2: Update admin API to accept optional eligible_models**
```typescript
// POST /admin/tokens
{
  "eligible_models": ["gpt-4o", "claude-3-5-sonnet"],  // OPTIONAL: Override default
  // ... other config
}

// Token without eligible_models uses system default (all models)
{
  "trusted_anchor_model": "claude-3-5-sonnet"  // Uses all models in registry
  // No eligible_models = system default
}
```

**Step 3: Deprecate allowed_models/denied_models**
- Keep for backward compatibility initially
- Log warnings when used
- Recommend users migrate to eligible_models for clarity
- Remove in next major version

### Impact on Policy Rules

**ForceModelByIntent** - Still works:
```typescript
// Token config
{
  "eligible_models": ["gpt-4o", "claude-3-5-sonnet"],
  "policy": {
    "rules": [
      {
        "type": "ForceModelByIntent",
        "intent": "code_generation",
        "model": "gpt-4o"  // Must be in eligible_models
      }
    ]
  }
}
```

**RestrictModelsByIntent** - Becomes validation:
```typescript
// OLD: RestrictModelsByIntent dynamically filters
{
  "type": "RestrictModelsByIntent",
  "intent": "data_analysis",
  "models": ["gpt-4o"]  // Reduce eligible models for this intent
}

// NEW: Validate at token creation
// If user wants different models for different intents, use separate tokens
// OR: Keep RestrictModelsByIntent but it can only narrow, not expand
```

**Recommendation:**
- Keep ForceModelByIntent (forces specific model, ignores router)
- Keep RestrictModelsByIntent but validate it only narrows eligible_models
- Document that different intents needing different model sets should use different tokens

### Updated Cache Key Structure

**Before (with eligible_models hash):**
```typescript
const cacheKey = {
  prompt: hashedPrompt,
  attributes: {
    scope: tokenConfig.token_id,
    router_model: routerModel,
    eligible_models: hashEligibleModels(eligibleModels)  // ❌ Complex
  }
};
```

**After (token-scoped, no hash needed):**
```typescript
const cacheKey = {
  prompt: hashedPrompt,
  attributes: {
    scope: tokenConfig.token_id,  // ✅ Simple - token scope includes eligible_models
    router_model: routerModel
  }
};
```

**Rationale:**
- Token's eligible_models are static (part of token config)
- Cache is already scoped to token_id
- No need to hash eligible_models - it's implicit in the scope
- Simpler, cleaner, fewer moving parts

### Summary: Eligible Models as Token Config

| Aspect | Current (Dynamic) | Proposed (Static with Default) |
|--------|------------------|-------------------------------|
| **Eligible models** | Computed per request | Optional token config + system default |
| **System default** | N/A | All models in registry |
| **Cache key** | Includes eligible_models hash | Just token_id scope |
| **Policy engine** | Filters models dynamically | Forces specific models only |
| **Cache hit rate** | Lower (hash changes) | Higher (stable scope) |
| **Complexity** | Higher (hashing, filtering) | Lower (static config) |
| **Flexibility** | High (rules change behavior) | High (override or use default) |
| **Ease of use** | Medium (need allowed/denied) | High (default works for most) |

**Recommendation:** ✅ **Implement** - Make eligible_models part of token configuration. This aligns perfectly with token-scoped caching and simplifies the entire caching architecture.

## Implementation Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Routing Request                           │
│  { prompt, token_id, router_model?, ... }                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Cache Key Construction                          │
│                                                              │
│  Prompt Hash: SHA-256(prompt text)                          │
│  Attributes:                                                 │
│    - scope: token_id (implicitly includes eligible_models) │
│    - router_model: "openai" | "gemini" | "consensus"       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  LangCache Query                             │
│                                                              │
│  cache.get(promptHash, {                                    │
│    scope: "token-abc123",                                   │
│    router_model: "consensus"                                │
│  })                                                          │
│                                                              │
│  Note: scope includes token's eligible_models implicitly    │
└────────────────────────┬────────────────────────────────────┘
                         │
                ┌────────┴────────┐
                │                 │
                ▼                 ▼
         ┌──────────┐      ┌──────────┐
         │   HIT    │      │   MISS   │
         └─────┬────┘      └─────┬────┘
               │                 │
               │                 ▼
               │      ┌────────────────────┐
               │      │  Invoke Router LLM │
               │      └─────┬──────────────┘
               │            │
               │            ▼
               │      ┌────────────────────┐
               │      │  Store with attrs  │
               │      │  for all 3 models  │
               │      └─────┬──────────────┘
               │            │
               └────────────┴──────────────┐
                                           │
                                           ▼
                                   ┌──────────────┐
                                   │Return Response│
                                   └──────────────┘
```

### Data Flow

#### Current Implementation (src/routing/engine.ts)

```typescript
// Current cache key construction
const cacheKey = {
  prompt: hashedPrompt,
  token_id: tokenConfig.token_id,
  eligible_models_hash: hashEligibleModels(eligibleModels)  // ❌ Computed dynamically
};
```

**Problems:**
1. No differentiation by router model
2. eligible_models computed dynamically (varies based on policy)
3. scope is token_id in key (not attribute)
4. No token isolation via LangCache attributes

#### Proposed Implementation

```typescript
// NEW: Cache key with attributes + token config includes eligible_models
const cacheKey = {
  prompt: hashedPrompt,  // Semantic search happens on this
  attributes: {
    scope: tokenConfig.token_id,  // Implicitly includes tokenConfig.eligible_models
    router_model: routerModel || 'consensus'
  }
};

// Token config now includes static eligible_models list
interface TokenConfig {
  token_id: string;
  eligible_models?: string[];  // NEW: Optional static list (e.g., ["gpt-4o", "claude-3-5-sonnet"])
  // System default if not specified: all models in registry
  // ...
}
```

**Improvements:**
1. ✅ Token-scoped caching (scope attribute)
2. ✅ Router model differentiation (router_model attribute)
3. ✅ Simpler cache key (no eligible_models hash needed)
4. ✅ Higher cache hit rate (eligible_models stable per token)
5. ✅ Clearer semantics (token config is source of truth)

### Cache Storage Strategy

When router LLM returns a response, we need to cache it for all three router model variants:

```typescript
// Pseudo-code for cache storage
async function cacheRoutingDecision(prompt, decision, context) {
  const promptHash = hashPrompt(prompt);

  // Cache for each router model variant
  const routerModels = ['openai', 'gemini', 'consensus'];

  for (const routerModel of routerModels) {
    await cache.set(promptHash, decision, {
      scope: context.tokenId,  // Token scope includes eligible_models implicitly
      router_model: routerModel
    });
  }
}
```

**Note:** No need to include `eligible_models` in attributes because:
- Token's `eligible_models` are static (part of token configuration or system default)
- Cache is already scoped to `token_id`
- All cached responses for a token naturally contain only that token's eligible models

**Cache Behavior for System Default:**
- Tokens using system default (no `eligible_models` override) have cache isolated by `token_id`
- Even though they share the same effective eligible models, cache doesn't leak between tokens
- This is correct because tokens may have different policies (ForceModelByIntent, etc.) even with same eligible models
- If you want tokens to share cache, use a single token with multiple API keys (future feature)

**Rationale:** Since we computed the decision using consensus (or a specific provider), we cache it for all variants. If user later requests a specific router model, they get the cached consensus result rather than re-invoking the LLM.

**Trade-off Analysis:**
- **Pro:** 3x cache hit rate (any router_model request can hit cache)
- **Pro:** Cost savings (avoid redundant LLM calls)
- **Con:** 3x cache storage (minimal cost with LangCache)
- **Con:** If providers truly diverge in decisions, cached consensus might not match individual provider (acceptable trade-off)

### Implementation Plan

#### Phase 0: Add eligible_models and Remove default_model ✅ **PREREQUISITE**

**Files to modify:**
1. `src/types/index.ts` - Add `eligible_models` to TokenConfig, **remove `default_model`**
2. `src/tokens/token-store.ts` - Update token creation/validation
3. `src/tokens/routes.ts` - Update admin API to accept eligible_models, **remove `default_model` validation**
4. `src/models/registry.ts` - **Remove `default_model` validation** (lines 409-417, 466-495)
5. `src/routing/engine.ts` - Use `tokenConfig.eligible_models` instead of computing dynamically
6. `README.md`, `REQUIREMENTS.md` - **Remove all `default_model` references**

**Changes:**

```typescript
// src/types/index.ts
export interface TokenConfig {
  token_id: string;
  eligible_models?: string[];  // OPTIONAL: Override system default (all models in registry)
  // DEPRECATED: allowed_models, denied_models (use eligible_models instead)
  allowed_models?: string[];  // Keep for backward compatibility
  denied_models?: string[];   // Keep for backward compatibility
  // REMOVED: default_model (vestigial - never used in routing logic)
  // ... rest
}

// Helper to get eligible models with system default fallback
export function getEligibleModels(
  tokenConfig: TokenConfig,
  modelRegistry: ModelRegistry
): string[] {
  if (tokenConfig.eligible_models) {
    return tokenConfig.eligible_models;
  }

  // System default: all models in registry
  return modelRegistry.getAllModels().map(m => m.id);
}

// src/tokens/routes.ts - POST /admin/tokens
router.post('/tokens', async (req, res) => {
  const { eligible_models, ...rest } = req.body;

  // Validate eligible_models if provided (optional)
  if (eligible_models !== undefined) {
    if (!Array.isArray(eligible_models)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'eligible_models must be an array of model IDs'
      });
    }

    if (eligible_models.length === 0) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'eligible_models must contain at least one model'
      });
    }

    // Validate all models exist in registry
    const allModels = modelRegistry.getAllModels().map(m => m.id);
    const invalidModels = eligible_models.filter(m => !allModels.includes(m));
    if (invalidModels.length > 0) {
      return res.status(400).json({
        error: 'ValidationError',
        message: `Invalid model IDs: ${invalidModels.join(', ')}`
      });
    }
  }

  // Create token (eligible_models is optional - uses system default if not specified)
  const token = await tokenStore.create({
    eligible_models,  // May be undefined (uses system default: all models)
    ...rest
  });

  res.status(201).json(token);
});

// src/routing/engine.ts - Simplified routing
async route(request: RouteRequest, tokenConfig: TokenConfig) {
  // Get eligible models (token override or system default)
  const eligibleModels = getEligibleModels(tokenConfig, this.modelRegistry);

  // Validate policy rules don't expand beyond eligible_models
  const forcedModel = this.policyEngine.checkForceModelByIntent(tokenConfig, request.prompt);
  if (forcedModel && !eligibleModels.includes(forcedModel)) {
    throw new Error(`Policy forces model ${forcedModel} which is not in eligible_models`);
  }

  // Router only considers eligible_models
  const decision = await this.routerLLM.invoke(request.prompt, eligibleModels, context);

  // Validate response only includes eligible_models
  if (!eligibleModels.includes(decision.primary.model)) {
    throw new Error(`Router returned ${decision.primary.model} which is not in eligible_models`);
  }

  return decision;
}
```

**Migration Script (Optional):**

```typescript
// scripts/migrate-eligible-models.ts
// NOTE: Migration is OPTIONAL - tokens without eligible_models use system default
// This script is only needed if you want to explicitly set eligible_models for existing tokens

import { tokenStore } from './src/tokens';
import { modelRegistry } from './src/models';

async function migrateTokensWithAllowedDenied() {
  const allTokens = await tokenStore.getAll();
  const allModels = modelRegistry.getAllModels().map(m => m.id);

  let migratedCount = 0;

  for (const token of allTokens) {
    // Only migrate tokens that have allowed_models or denied_models
    if ((token.allowed_models || token.denied_models) && !token.eligible_models) {
      let eligible = allModels;

      if (token.denied_models) {
        eligible = eligible.filter(m => !token.denied_models.includes(m));
      }

      if (token.allowed_models) {
        eligible = eligible.filter(m => token.allowed_models.includes(m));
      }

      // Update token with explicit eligible_models
      await tokenStore.update(token.token_id, {
        ...token,
        eligible_models: eligible
      });

      console.log(`Migrated token ${token.token_id}: ${eligible.length} models`);
      migratedCount++;
    }
  }

  console.log(`\nMigration complete: ${migratedCount} tokens migrated`);
  console.log(`Tokens without eligible_models will use system default (${allModels.length} models)`);
}

migrateTokensWithAllowedDenied();
```

**Testing:**
- Unit tests for token validation with eligible_models (optional field)
- Unit tests for getEligibleModels() helper with and without override
- Unit tests for getFallbackModel() helper (first model in eligible_models)
- Integration tests for token creation/update with and without eligible_models
- Verify tokens without eligible_models use system default (all models in registry)
- Verify tokens with eligible_models are restricted correctly
- Ensure eligible_models cannot be empty array (minimum 1 model required)
- Verify fallback uses first model in eligible_models list

#### Phase 1: Add Attributes to Cache Interface ✅

**Files to modify:**
1. `src/cache/types.ts` - Add attributes to CacheConfig and method signatures
2. `src/cache/semantic-cache.ts` - Update `get()` and `set()` methods to accept attributes

**Changes:**

```typescript
// src/cache/types.ts
export interface CacheAttributes {
  scope: string;           // token_id (contains eligible_models implicitly)
  router_model: 'openai' | 'gemini' | 'consensus';
}

export interface CacheKey {
  prompt: string;          // Already hashed
  attributes?: CacheAttributes;
}

// Update method signatures
interface SemanticCache {
  get(key: CacheKey): Promise<string | null>;
  set(key: CacheKey, value: string): Promise<void>;
  // ... rest
}

// Token config now includes optional eligible_models
// src/types/index.ts
export interface TokenConfig {
  token_id: string;
  eligible_models?: string[];  // OPTIONAL: Override system default (all models)
  // REMOVED: default_model (vestigial field, never used in routing)
  // ... rest
}

// Helper function for getting effective eligible models
export function getEligibleModels(
  tokenConfig: TokenConfig,
  modelRegistry: ModelRegistry
): string[] {
  return tokenConfig.eligible_models ?? modelRegistry.getAllModels().map(m => m.id);
}
```

**Testing:**
- Unit tests for SemanticCache with attributes
- Verify attributes are correctly passed to LangCache API

#### Phase 2: Update Routing Engine to Use Attributes ✅

**Files to modify:**
1. `src/routing/engine.ts` - Update cache key construction and storage logic

**Changes:**

```typescript
// src/routing/engine.ts - DefaultRoutingEngine.route()

// BEFORE cache lookup
const routerModel = request.router_model || 'consensus';
const cacheKey = {
  prompt: hashedPrompt,
  attributes: {
    scope: tokenConfig.token_id,  // Implicitly includes tokenConfig.eligible_models
    router_model: routerModel
  }
};

// Cache lookup
const cachedResult = await this.cache?.get(cacheKey);

// AFTER router LLM response
if (this.cache) {
  // Cache for all router model variants
  const routerModels: Array<'openai' | 'gemini' | 'consensus'> =
    ['openai', 'gemini', 'consensus'];

  for (const rm of routerModels) {
    await this.cache.set(
      {
        prompt: hashedPrompt,
        attributes: {
          scope: tokenConfig.token_id,  // Same scope for all variants
          router_model: rm
        }
      },
      JSON.stringify(routerResponse)
    );
  }
}
```

**Note:** Router must validate that response only includes models from `tokenConfig.eligible_models` before caching.

**Testing:**
- Integration tests verifying cache hits with different router_model values
- Integration tests verifying cache isolation between tokens
- Integration tests verifying cache hits with same eligible_models across different prompts

#### Phase 3: Update Cache Configuration ✅

**Files to modify:**
1. `src/cache/config.ts` - Document attribute usage
2. `.env.example` - Add examples of attribute behavior

**Changes:**

```bash
# .env.example

# LangCache attributes (automatic, no configuration needed):
# - scope: Isolates cache by token (prevents cross-token pollution)
# - router_model: Separates OpenAI, Gemini, and consensus results
# - eligible_models: Ensures policy-aligned cache hits
```

#### Phase 4: Add router_model Support to Route Request ✅

**Files to modify:**
1. `src/routing/routes.ts` - Accept `router_model` in request body
2. `src/types/index.ts` - Add to RouteRequest type

**Changes:**

```typescript
// src/types/index.ts
export interface RouteRequest {
  prompt: string;
  router_model?: 'openai' | 'gemini' | 'consensus'; // NEW
  // ... existing fields
}

// src/routing/routes.ts - Validate router_model
if (request.router_model) {
  if (!['openai', 'gemini', 'consensus'].includes(request.router_model)) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'router_model must be one of: openai, gemini, consensus'
    });
  }
}
```

**Testing:**
- API tests with valid router_model values
- API tests with invalid router_model values (400 error)
- API tests verifying different decisions for different router_model values

#### Phase 5: Documentation Updates ✅

**Files to modify:**
1. `README.md` - Document router_model parameter
2. `docs/design/SEMANTIC_CACHE.md` - Create new doc explaining attribute strategy
3. `CLAUDE.md` - Update for Claude Code understanding

**Content:**

```markdown
## Router Model Selection

You can specify which router LLM to use for routing decisions:

POST /route
{
  "prompt": "Write a Python function to reverse a string",
  "router_model": "openai"  // Optional: "openai", "gemini", or "consensus" (default)
}

- **openai**: Use only OpenAI's GPT-4o-mini for routing decision
- **gemini**: Use only Gemini 1.5-flash for routing decision
- **consensus**: Use both providers and aggregate rankings (default, most accurate)

**Caching:** All three variants are cached for each prompt, so switching between
router models doesn't cause redundant LLM calls.

## Token Eligible Models

Tokens can optionally specify which models they're allowed to use:

POST /admin/tokens
{
  "eligible_models": ["gpt-4o", "claude-3-5-sonnet"],  // Optional override
  "trusted_anchor_model": "claude-3-5-sonnet"
}

- **With eligible_models**: Token restricted to specified models only (first model is preferred/fallback)
- **Without eligible_models**: Token can use all models in registry (system default)
- **Default behavior**: Most tokens should omit eligible_models to use system default
- **Fallback**: If router fails, use first model in eligible_models list

**Caching:** Each token has isolated cache (by token_id), regardless of eligible_models configuration.
```

### Migration & Rollout

#### Backward Compatibility

**Question:** What happens to existing cache entries without attributes?

**Answer:** LangCache queries with attributes won't match entries without attributes.

**Strategy:**
1. **Option A (Recommended):** Accept cache miss on upgrade
   - Old cache entries expire naturally (TTL = 1 hour default)
   - New requests populate cache with attributes
   - Zero migration code required

2. **Option B:** Cache flush on deployment
   - Add migration script to flush LangCache on deployment
   - Ensures clean slate
   - Temporary increase in router LLM costs

**Recommendation:** Option A - Natural cache expiry is simpler and less risky.

#### Rollout Plan

1. **Deploy with attributes feature behind feature flag**
   ```bash
   LANGCACHE_ATTRIBUTES_ENABLED=true  # Default: false initially
   ```

2. **Monitor for 24 hours:**
   - Cache hit/miss rates (should normalize after TTL expires)
   - Router LLM costs (expect temporary increase, then decrease)
   - Routing decision correctness (no policy violations)

3. **Enable by default** after validation

4. **Remove feature flag** after 1 week of stable operation

### Testing Strategy

#### Unit Tests

**File:** `test/cache/semantic-cache.test.ts`

```typescript
describe('SemanticCache with Attributes', () => {
  it('should cache separately for different scopes (tokens)', async () => {
    await cache.set(
      { prompt: 'hash1', attributes: { scope: 'token-a', router_model: 'consensus' }},
      'result-a'
    );

    const miss = await cache.get(
      { prompt: 'hash1', attributes: { scope: 'token-b', router_model: 'consensus' }}
    );

    expect(miss).toBeNull(); // Different scope = miss (different token)
  });

  it('should cache separately for different router_model', async () => {
    await cache.set(
      { prompt: 'hash1', attributes: { scope: 'token-a', router_model: 'openai' }},
      'result-openai'
    );

    const miss = await cache.get(
      { prompt: 'hash1', attributes: { scope: 'token-a', router_model: 'gemini' }}
    );

    expect(miss).toBeNull(); // Different router_model = miss
  });

  it('should return cached result for same token and router_model', async () => {
    await cache.set(
      { prompt: 'hash1', attributes: { scope: 'token-a', router_model: 'consensus' }},
      'result-consensus'
    );

    const hit = await cache.get(
      { prompt: 'hash1', attributes: { scope: 'token-a', router_model: 'consensus' }}
    );

    expect(hit).toBe('result-consensus'); // Same scope + router_model = hit
  });
});
```

#### Integration Tests

**File:** `test/cache/langcache-integration.test.ts`

```typescript
describe('LangCache Integration with Attributes', () => {
  it('should return cached result for same token and router_model', async () => {
    // First request - cache miss, invokes router LLM
    const response1 = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', token)
      .send({ prompt: 'Test prompt', router_model: 'openai' });

    // Second request - cache hit, no LLM call
    const response2 = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', token)
      .send({ prompt: 'Test prompt', router_model: 'openai' });

    expect(response1.body.primary).toEqual(response2.body.primary);
  });

  it('should isolate cache between different tokens', async () => {
    // Token A with policy allowing only gpt-4
    const responseA = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', tokenA)
      .send({ prompt: 'Same prompt' });

    // Token B with policy allowing all models
    const responseB = await request(app)
      .post('/route')
      .set('X-Wayfinder-Token', tokenB)
      .send({ prompt: 'Same prompt' });

    // Results should differ due to different eligible models
    // (cache should NOT return Token A's result for Token B)
    expect(responseA.body.primary).not.toEqual(responseB.body.primary);
  });
});
```

#### Manual Testing

**Test Case 1: Token Isolation**
```bash
# Create two tokens with different policies
curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: $ADMIN_KEY" \
  -d '{"allowed_models": ["gpt-4o"]}'
# Save token as TOKEN_A

curl -X POST http://localhost:3000/admin/tokens \
  -H "X-Admin-Api-Key: $ADMIN_KEY" \
  -d '{"allowed_models": ["claude-3-5-sonnet"]}'
# Save token as TOKEN_B

# Same prompt, different tokens
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN_A" \
  -d '{"prompt": "Write a sorting algorithm"}'
# Should recommend gpt-4o

curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN_B" \
  -d '{"prompt": "Write a sorting algorithm"}'
# Should recommend claude-3-5-sonnet (NOT cached from TOKEN_A)
```

**Test Case 2: Router Model Selection**
```bash
# Same token, different router models
curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -d '{"prompt": "Explain quantum computing", "router_model": "openai"}'

curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -d '{"prompt": "Explain quantum computing", "router_model": "gemini"}'

curl -X POST http://localhost:3000/route \
  -H "X-Wayfinder-Token: $TOKEN" \
  -d '{"prompt": "Explain quantum computing", "router_model": "consensus"}'

# All three should return (potentially different) cached results
# Verify in logs that no additional router LLM calls were made
```

### Performance Considerations

#### Cache Hit Rate Impact

**Current:**
- Single cache entry per unique (prompt, eligible_models_hash) pair
- Hit rate: ~40-70% (based on semantic similarity threshold 0.9)
- Cache key includes dynamically computed eligible_models_hash

**After Implementation:**
- Three cache entries per unique (prompt, scope) pair (one per router_model)
- Hit rate: Should remain ~40-70% per router_model variant
- **Net effect:**
  - Higher cache hit rate (eligible_models stable per token, not computed per request)
  - Higher cache utility (users can switch router_model without LLM calls)
  - Better isolation (tokens can't pollute each other's cache)

#### Storage Impact

**Analysis:**
- 3x storage per prompt (one entry for each router_model)
- Average cache entry size: ~500 bytes (JSON routing decision)
- Estimated entries: 10,000 active entries (depends on traffic)
- Storage increase: 10,000 * 3 * 500 bytes = ~15 MB

**Verdict:** ✅ Negligible storage impact

#### Latency Impact

**Analysis:**
- LangCache attribute filtering happens server-side
- No additional network round-trips
- Semantic search remains the same (prompt hash)

**Verdict:** ✅ No measurable latency impact

### Edge Cases & Error Handling

#### Edge Case 1: Cache Inconsistency During Multi-Provider Rollout

**Scenario:** User enables Gemini provider mid-flight while some prompts are already cached with consensus results.

**Behavior:**
- Cached consensus results remain valid (they were computed with available providers at the time)
- New requests with `router_model: "gemini"` will miss cache initially (expected)
- After first Gemini-specific call, all three variants are cached

**Mitigation:** None needed - this is correct behavior.

#### Edge Case 2: Token's eligible_models Updated

**Scenario:** Token's `eligible_models` list is updated (e.g., add a new model or remove one).

**Behavior:**
- Cache entries for old token configuration remain (same token_id scope)
- Cached decisions may include models no longer in eligible_models
- **Solution:** Clear token's cache on eligible_models update

**Mitigation:**
```typescript
// When updating token's eligible_models
async function updateToken(tokenId: string, updates: Partial<TokenConfig>) {
  if (updates.eligible_models) {
    // Clear cache for this token scope
    await cache.clear({ scope: tokenId });
  }

  await tokenStore.update(tokenId, updates);
}
```

**Alternative:** Accept stale cache entries, rely on TTL (1 hour) for natural expiry.

#### Edge Case 3: Router Model Disabled After Caching

**Scenario:** OpenAI provider disabled via `ROUTER_LLM_OPENAI_ENABLED=false`, but cache has `router_model: "openai"` entries.

**Behavior:**
- Requests with `router_model: "openai"` should fail validation before cache lookup
- Return 400 error: "OpenAI router not available"

**Mitigation:** Add validation in routes.ts:
```typescript
if (request.router_model === 'openai' && !config.openai.enabled) {
  return res.status(400).json({
    error: 'ValidationError',
    message: 'OpenAI router model is not enabled'
  });
}
```

### Success Metrics

**Before Implementation:**
- Cache hit rate: 40-70%
- Router LLM calls per 100 requests: 30-60
- Cross-token cache pollution incidents: Unknown (no isolation)

**After Implementation (Expected):**
- Cache hit rate: 40-70% per router_model (unchanged per variant)
- Router LLM calls per 100 requests: 30-60 initially, then 10-20 after cache warms (3x variants cached)
- Cross-token cache pollution incidents: 0 (guaranteed by scope attribute)
- Router model switching LLM calls: 0 (all variants pre-cached)

**Monitoring:**
```typescript
// Add metrics
logger.info('Cache performance', {
  hit_rate: hits / (hits + misses),
  scope_distribution: { 'token-a': 45, 'token-b': 30, 'global': 5 },
  router_model_distribution: { 'consensus': 60, 'openai': 25, 'gemini': 15 }
});
```

## Summary

### Key Changes

1. **Remove default_model field entirely** (breaking change, but low impact)
   - Analysis: `default_model` is validated and stored but **never used** in routing logic
   - Impact: Vestigial code removed, clearer mental model for users
   - Fallback: Use first model in `eligible_models` list if fallback needed
   - Migration: Users can remove `default_model` from token configs (field is ignored)

2. **eligible_models becomes optional token configuration field** (biggest change)
   - Before: Computed dynamically from allowed/denied models + policy
   - After: Optional static field on TokenConfig with system default fallback
   - System Default: All models in registry (when eligible_models not specified)
   - Benefit: Simpler, more predictable, better cache hit rate, flexible defaults

3. **LangCache attributes enable token-scoped caching**
   - Before: Global cache with eligible_models_hash in key
   - After: Token-scoped cache with simple attributes
   - Benefit: Eliminates cross-token pollution

4. **Router model differentiation**
   - Before: No differentiation, wrong results when user specifies router_model
   - After: Separate cache entries for openai/gemini/consensus
   - Benefit: Correct results, no redundant LLM calls when switching models

### Cache Attribute Schema

```typescript
{
  prompt: "sha256_hash_of_prompt",  // Semantic search key
  attributes: {
    scope: "token_id",              // Isolates by token (includes eligible_models)
    router_model: "consensus"       // Differentiates by router provider
  }
}
```

**Key insights:**
- `scope` attribute (token_id) implicitly includes `eligible_models` because eligible_models is static per token
- Tokens without `eligible_models` override share the same effective eligible models (system default), but cache is still isolated by token_id scope
- This provides both flexibility (easy defaults) and correctness (token isolation)

### Benefits

1. ✅ **Correctness:** Eliminates cross-token cache pollution (critical bug fix)
2. ✅ **Flexibility:** Users can specify router_model preference
3. ✅ **Efficiency:** 3x cache variants reduce redundant LLM calls (50-70% cost savings)
4. ✅ **Scalability:** Proper attribute scoping enables multi-tenancy
5. ✅ **Simplicity:** No more dynamic eligible_models computation or hashing
6. ✅ **Higher cache hit rate:** Stable eligible_models per token

### Risks

1. ⚠️ **Migration:** Old cache entries become stale (mitigated by TTL)
2. ⚠️ **Breaking change - default_model removal:** Tokens with `default_model` will have field ignored (no error, just unused)
3. ⚠️ **Breaking change - eligible_models:** Token config changes (mitigated by optional field with system default)
4. ⚠️ **Testing:** More test scenarios (addressed in testing strategy)
5. ⚠️ **eligible_models updates:** Need to clear cache or wait for TTL

### Recommendation

✅ **PROCEED** with implementation following this design.

**Priority:** High
- **Correctness issue:** Cross-token cache pollution is a critical bug
- **Cost savings:** 3x cache variants reduce router LLM costs significantly
- **Architectural improvement:** eligible_models in token config is cleaner design

**Estimated Effort:** 3-4 days
- Day 1: Phase 0 (eligible_models in token config + **remove default_model** + migration)
- Day 2: Phase 1-2 (cache interface + routing engine)
- Day 3: Phase 3-4 (router_model support + testing)
- Day 4: Phase 5 (documentation + rollout)

**Breaking Changes:**
1. **default_model removed from TokenConfig** (low impact - field was never used)
   - Existing tokens with `default_model` will have field ignored
   - No runtime errors - graceful degradation
   - Users should remove `default_model` from token configs
   - Fallback strategy: Use first model in `eligible_models` list if needed

2. **eligible_models is optional with system default** (backward compatible)
   - Tokens without `eligible_models` use all models in registry
   - No migration needed for existing tokens

---

## Appendix: default_model Removal Details

### Evidence: default_model is Never Used

**Codebase analysis shows `default_model` is validated but never used:**

```typescript
// src/routing/engine.ts:248-255 - Actual failure behavior
if (eligibleModels.length === 0) {
  throw new Error(
    'No eligible models available after policy evaluation. ' +
    'Please check your token configuration...'
  );
  // NOTE: Does NOT fall back to default_model - just throws error
}

// Nowhere in src/routing/engine.ts is tokenConfig.default_model referenced
```

**Where it's defined (but not used):**
- ✅ `src/types/index.ts:86` - Type definition
- ✅ `src/models/registry.ts:409-417` - Validates it exists
- ✅ `src/models/registry.ts:466-475` - Validates not in denied_models
- ✅ `src/models/registry.ts:488-495` - Validates in allowed_models
- ✅ `src/tokens/store.ts:83,188,271,396` - Stores it
- ✅ `src/tokens/routes.ts:25` - Admin API accepts it
- ✅ `src/tokens/user-routes.ts:28` - User API accepts it
- ❌ `src/routing/engine.ts` - **NEVER REFERENCED**

**Dead code in types:**
```typescript
// src/types/index.ts:310
export type RoutingReason =
  | 'policy_forced'
  | 'knowledge_consensus'
  | 'trusted_anchor_fallback'
  | 'default_model_fallback'  // ❌ DEAD CODE - never used
  | 'system_default';
```

### Removal Strategy

**Phase 1: Remove from types and validation**
```typescript
// src/types/index.ts - Remove from TokenConfig
export interface TokenConfig {
  id: string;
  token_hash: string;
  trusted_anchor_model?: string;
  allowed_models?: string[];
  denied_models?: string[];
  eligible_models?: string[];  // NEW
  policy_rules?: PolicyRule[];
  confidence_threshold?: number;
  logging_level?: LoggingLevel;
  // default_model?: string;  // ❌ REMOVED
  environment?: Environment;
  knowledge_scope?: KnowledgeScope;
  router_model_preference?: RouterModelPreference;
  created_at: string;
  updated_at: string;
  rotated_at?: string;
}

// src/types/index.ts - Remove dead RoutingReason
export type RoutingReason =
  | 'policy_forced'
  | 'knowledge_consensus'
  | 'trusted_anchor_fallback'
  // | 'default_model_fallback'  // ❌ REMOVED - was never used
  | 'system_default';
```

**Phase 2: Remove validation from ModelRegistry**
```typescript
// src/models/registry.ts - Remove lines 409-417, 466-475, 488-495

// ❌ DELETE THIS
// Validate default_model
if (tokenConfig.default_model) {
  this.assertModelExists(tokenConfig.default_model, 'token_config');
  this.assertModelActive(tokenConfig.default_model, 'token_config');
  // ...
}

// ❌ DELETE THIS
// default_model must not be denied
if (tokenConfig.default_model && tokenConfig.denied_models && ...) {
  throw new ModelConfigurationError(...);
}

// ❌ DELETE THIS
// If allowed_models is specified, default must be in it
if (tokenConfig.default_model && !tokenConfig.allowed_models.includes(...)) {
  throw new ModelConfigurationError(...);
}
```

**Phase 3: Remove from API schemas**
```typescript
// src/tokens/routes.ts - Remove from Zod schema
const TokenCreateSchema = z.object({
  trusted_anchor_model: z.string().optional(),
  allowed_models: z.array(z.string()).optional(),
  denied_models: z.array(z.string()).optional(),
  eligible_models: z.array(z.string()).optional(),  // NEW
  policy_rules: z.array(PolicyRuleSchema).optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  logging_level: z.enum(['normal', 'verbose']).optional(),
  // default_model: z.string().optional(),  // ❌ REMOVED
  environment: z.enum(['prod', 'dev']).optional(),
  knowledge_scope: z.enum(['global', 'token', 'org', 'hybrid']).optional(),
  router_model_preference: z.enum(VALID_ROUTER_MODEL_PREFERENCES).optional(),
});

// src/tokens/user-routes.ts - Same removal
```

**Phase 4: Remove from token store**
```typescript
// src/tokens/store.ts - Remove from create/update methods
const tokenConfig: TokenConfig = {
  id: tokenId,
  token_hash: tokenHash,
  trusted_anchor_model: request.trusted_anchor_model,
  allowed_models: request.allowed_models,
  denied_models: request.denied_models,
  eligible_models: request.eligible_models,  // NEW
  policy_rules: request.policy_rules,
  confidence_threshold: request.confidence_threshold ?? 0.6,
  logging_level: request.logging_level ?? 'normal',
  // default_model: request.default_model,  // ❌ REMOVED
  environment: request.environment ?? 'dev',
  knowledge_scope: request.knowledge_scope ?? 'global',
  router_model_preference: request.router_model_preference,
  created_at: now,
  updated_at: now,
};
```

**Phase 5: Update documentation**
- Remove from `README.md` (lines 61, 644, 1154, 1226, 1511, 1887, 1908, 1967, 1981)
- Remove from `REQUIREMENTS.md` (line 110)
- Remove from `docs/releases/v0.1.0.md` (keep as-is for historical accuracy)
- Remove from `docs/design/USER_AUTH_BYOLLM.md` (line 296, 930)

### Fallback Strategy After Removal

**If fallback is needed (currently system just throws error):**
```typescript
// Helper function for fallback model
function getFallbackModel(tokenConfig: TokenConfig, modelRegistry: ModelRegistry): string {
  const eligibleModels = getEligibleModels(tokenConfig, modelRegistry);

  if (eligibleModels.length === 0) {
    throw new Error('No eligible models available for fallback');
  }

  // Use first model in list as fallback
  return eligibleModels[0];
}

// Usage in routing engine (if we decide to add fallback instead of throwing error)
try {
  const decision = await this.routerLLM.invoke(prompt, eligibleModels, context);
  return decision;
} catch (error) {
  // Option 1: Throw error (current behavior)
  throw error;

  // Option 2: Fallback to first model (new behavior if desired)
  const fallbackModel = getFallbackModel(tokenConfig, this.modelRegistry);
  return {
    intent: 'unknown',
    primary: {
      model: fallbackModel,
      score: 5,
      reason: 'Router LLM failed, falling back to first eligible model'
    },
    alternate: {
      model: fallbackModel,
      score: 5,
      reason: 'No alternate available (fallback mode)'
    }
  };
}
```

### Testing Changes

**Remove from test files:**
- `test/security-headers.test.ts:146,195,216,287` - Remove `default_model: 'gpt-4o'`
- `test/rate-limiting.test.ts:36,112` - Remove `default_model` references
- `test/integration.test.ts:23,81,91` - Remove `default_model` references
- `test/model-validation.test.ts:273` - Remove `default_model` validation tests
- `test/routing/config.test.ts` - No changes (tests router LLM config, not token config)

**Add new tests:**
```typescript
// test/tokens/fallback.test.ts
describe('Fallback Model Strategy', () => {
  it('should use first model in eligible_models as fallback', () => {
    const tokenConfig = {
      eligible_models: ['gpt-4o', 'claude-3-5-sonnet']
    };

    const fallback = getFallbackModel(tokenConfig, modelRegistry);
    expect(fallback).toBe('gpt-4o');  // First in list
  });

  it('should use first model from system default when no eligible_models', () => {
    const tokenConfig = {};  // No eligible_models

    const fallback = getFallbackModel(tokenConfig, modelRegistry);
    // Should be first model in registry (implementation-dependent)
    expect(fallback).toBeDefined();
  });

  it('should throw error when eligible_models is empty', () => {
    const tokenConfig = { eligible_models: [] };

    expect(() => getFallbackModel(tokenConfig, modelRegistry))
      .toThrow('No eligible models available for fallback');
  });
});
```

### Migration Guide for Users

**For users with existing tokens:**

```bash
# Before (with default_model)
curl -X POST /admin/tokens \
  -d '{
    "default_model": "gpt-4o",
    "allowed_models": ["gpt-4o", "claude-3-5-sonnet"]
  }'

# After (without default_model)
curl -X POST /admin/tokens \
  -d '{
    "eligible_models": ["gpt-4o", "claude-3-5-sonnet"]
  }'
# Note: First model in eligible_models (gpt-4o) is preferred/fallback
```

**User communication:**

> **Breaking Change in v0.2.0: `default_model` Removed**
>
> We've removed the `default_model` field from token configuration because it was never used in routing logic.
>
> **What this means:**
> - Tokens with `default_model` will have the field ignored (no error)
> - You should remove `default_model` from your token configurations
> - Use `eligible_models` to specify allowed models (first model is preferred)
>
> **Migration:**
> ```bash
> # Old config
> { "default_model": "gpt-4o", "allowed_models": [...] }
>
> # New config (equivalent)
> { "eligible_models": ["gpt-4o", ...] }  # First model is preferred
> ```
>
> **Why this change:**
> - Removes confusing vestigial field that never affected routing
> - Clearer mental model: eligible_models defines what's available
> - Simpler implementation with less validation complexity

### Rollout Plan

1. **Deploy with default_model ignored** (soft deprecation)
   - Accept `default_model` in API but ignore it
   - Log warning when `default_model` is provided
   - Give users 1 week to update configs

2. **Remove from API schema** (hard deprecation)
   - Reject requests with `default_model` field
   - Return 400 error with migration instructions
   - Update all documentation

3. **Remove from codebase entirely**
   - Remove type definitions
   - Remove validation code
   - Remove from storage layer

**Success Criteria:**
- Zero cross-token cache pollution incidents
- Cache hit rate: 40-70% per router_model (same as current overall)
- Router model switching: 0 additional LLM calls (cached)
- Tokens without eligible_models correctly use system default (all models)
- Tokens with eligible_models correctly restricted to specified models
- Fallback uses first model in eligible_models list when needed
- `default_model` field removed from all token configs, types, and documentation
- No runtime errors for existing tokens with `default_model` (field gracefully ignored)
