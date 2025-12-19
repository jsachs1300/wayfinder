# Wayfinder — System Requirements & Design Contract

## 1. Purpose & Scope

Wayfinder is an AI navigation and routing service that determines **which LLM should handle a given query**, based on:

* user intent
* explicit policy
* user trust preferences
* accumulated knowledge about model behavior

Wayfinder **does not generate answers**.
It **directs execution** by returning a model decision and a fully explainable rationale.

This document defines the **non-negotiable requirements** that the system must satisfy.

---

## 2. Core Principles (MUST HOLD)

1. **Policy First**

   * Policy enforcement MUST always occur before any optimization or learning logic.
   * If policy forces a model, no routing logic may override it.

2. **Explainability by Default**

   * Every routing decision MUST include a structured explanation:

     * why the model was selected
     * what alternatives were eligible
     * whether uncertainty existed

3. **Knowledge ≠ Cache**

   * Knowledge is long-lived.
   * Knowledge decays in influence, not existence.
   * Knowledge is an asset, not a performance optimization.

4. **Global Intelligence, Optional Isolation**

   * Global knowledge is the default behavior.
   * Enterprise tokens MAY opt into scoped knowledge.
   * Scoped knowledge MUST NOT contaminate global knowledge.

5. **Deterministic Behavior**

   * Given the same token config, policy, and knowledge state, routing decisions MUST be deterministic.

---

## 3. System Boundaries

Wayfinder:

* Authenticates requests
* Classifies intent
* Enforces policy
* Consults knowledge
* Selects a model
* Returns an explainable decision

Wayfinder does NOT:

* Call LLMs to generate responses (yet)
* Modify user prompts
* Hide uncertainty
* Learn silently without logging

---

## 4. Authentication & Tokens

### 4.1 Token Model

Each API token represents a **policy boundary**.

A token MUST support:

* trusted_anchor_model (optional)
* allowed_models (optional allowlist)
* denied_models (optional denylist)
* policy_rules (structured, deterministic)
* confidence_threshold
* default_model
* knowledge_scope
* logging_level
* environment (optional)

### 4.2 Token Types

* Standard tokens: global knowledge only
* Enterprise tokens: configurable knowledge scope

---

## 5. Knowledge Scope

### 5.1 Supported Scopes

* `global` (default)
* `token` (enterprise)
* `org` (stubbed, future)
* `hybrid` (stubbed, future)

### 5.2 Scope Rules

* Global scope shares learning across all tokens.
* Token scope isolates learning per token.
* No cross-scope reads or writes are permitted.
* Knowledge scope MUST be explicit in all store operations.

---

## 6. Intent Classification

* Every request MUST be classified into an intent cluster.
* Initial intents are coarse and human-interpretable (e.g. code_review, reasoning).
* Intent classification MUST be replaceable without changing routing logic.
* Misclassification MUST degrade gracefully, not crash routing.

---

## 7. Policy Engine

### 7.1 Policy Types

Supported rule types:

* ForceModelByIntent
* RestrictModelsByIntent
* AllowModelsGlobal
* DenyModelsGlobal

### 7.2 Evaluation Order (MANDATORY)

1. Global allow/deny
2. Intent-based restrictions
3. Forced model rules

### 7.3 Policy Guarantees

* Forced models MUST still be eligible.
* Invalid policy MUST fail fast at ingestion time.
* Policy application MUST be auditable.

---

## 8. Model Registry & Validation

### 8.1 Curated Registry

* Only curated core models participate in global knowledge.
* Model identifiers MUST be validated at all ingestion points:

  * token creation/update
  * policy rules
  * feedback ingestion
  * opinion polling

### 8.2 Invalid Models

* Invalid model identifiers MUST be rejected.
* No silent fallback or coercion is permitted.

---

## 9. Knowledge Store

### 9.1 Stored Fields

Each knowledge record MUST include:

* model_votes
* total_votes
* agreement_score
* confidence_level
* last_updated
* decay parameters

### 9.2 Agreement Calculation

* agreement_score = max_votes / total_votes

### 9.3 Confidence Levels

* strong: agreement ≥ 0.8 AND sufficient votes
* moderate: agreement ≥ 0.6
* low: otherwise

Full disagreement (all different) MUST be treated as low confidence, not failure.

---

## 10. Routing Decision Flow (MANDATORY)

For every request:

1. Authenticate token
2. Load token config
3. Classify intent
4. Apply policy
5. If forced → return
6. Load scoped knowledge
7. If confidence ≥ threshold → consensus model
8. Else → trusted anchor (if present)
9. Else → default model

At no point may routing bypass this sequence.

---

## 11. Opinion Polling

* Opinion polling exists to populate knowledge.
* Polling MUST be asynchronous and non-blocking.
* Polling MUST respect knowledge scope.
* Stub polling is acceptable in v1, but interfaces MUST exist.

---

## 12. Feedback

* Feedback ingestion MUST validate model identifiers.
* Feedback MUST be scoped consistently with token knowledge.
* Feedback storage MUST be auditable.
* Feedback does not need to update routing weights yet, but plumbing MUST exist.

---

## 13. Observability & Logging

Wayfinder MUST log:

* routing reason
* policy application
* confidence level
* knowledge scope
* request ID

Logs MUST allow post-hoc reconstruction of decisions.

---

## 14. Failure Modes

Wayfinder MUST:

* Fail fast on invalid config
* Surface policy conflicts clearly
* Treat uncertainty as a first-class state
* Never silently downgrade correctness for availability

---

## 15. Non-Goals (Explicit)

Wayfinder is NOT:

* A chatbot
* A prompt optimizer
* A model marketplace
* An auto-ML system

Those are out of scope unless explicitly added later.

---

## 16. Success Criteria

The system is considered compliant if:

* Routing decisions are explainable and deterministic
* Policy enforcement cannot be bypassed
* Knowledge remains clean and scoped
* Adding future features does not require architectural rewrites

