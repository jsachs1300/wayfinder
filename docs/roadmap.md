# Roadmap

_Extracted from the previous README._

## Future Roadmap

### Recently Completed (v1.x)

- **User Authentication & Self-Service** - User registration, login, and token management
- **Bring Your Own LLM (BYOLLM)** - Users can configure their own OpenAI/Gemini API keys
- **Three-Tier User System** - Free, Paid (System), and Paid (BYOLLM) tiers
- **Tier-Based Rate Limiting** - Different rate limits per user tier
- **Encrypted Key Storage** - AES-256-GCM encryption for user LLM keys
- **Email Verification** - Required email verification before password setup

### Short-term (v1.x)

- **Intent-Based Policy Rules (Full Support)** - Fix timing limitation to enable true intent-based routing policies (P1)
- **Real Opinion Polling** - Asynchronous polling of actual models to populate knowledge
- **Org-Scoped Knowledge** - Shared learning within organizations (in addition to global and token scopes)
- **Hybrid Knowledge Scope** - Combination of global and token-scoped learning
- **Advanced Observability** - Enhanced logging and metrics
- **Billing Integration** - Stripe integration for automatic tier upgrades

### Medium-term (v2.x)

- **Knowledge-Guided Routing** - Use knowledge store to optimize router LLM decisions
- **Model Metadata in Decisions** - Return expanded model information in routing responses
- **Compliance & Audit** - Detailed audit trails and compliance reporting
- **Admin User Management UI** - Web interface for managing users and tiers

### Longer-term (v3.x)

- **Custom Model Registry** - Support for custom/internal LLM models beyond OpenAI and Gemini
- **Multi-Modal Routing** - Route based on content type (text, image, etc.)
- **Cost Optimization** - Automatic model selection based on cost targets
- **Advanced Prompt Optimization** - Rewrite prompts for specific models
- **Organization Management** - Multi-user organizations with shared billing and resources

## What Wayfinder Does NOT Do

Wayfinder is NOT:
- A chatbot or conversational interface
- A prompt optimizer or rewriter
- A local heuristic router
- A model execution engine
- A capability matcher based on static task labels
- An auto-ML engine

These are intentional non-goals that keep the system focused and maintainable.

## License

MIT
