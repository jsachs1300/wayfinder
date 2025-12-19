# Wayfinder — System Requirements & Design Contract

## Authority

This document is the **authoritative contract** for Wayfinder.

All code changes, tooling, and LLM-generated implementations **MUST strictly adhere** to this document.

If a behavior is not explicitly permitted here, it is **not allowed**.  
Deletion is preferred over invention when requirements are unclear.

---

## 1. Purpose & Scope

Wayfinder is an AI navigation and routing service that determines **which LLM should handle a given query**.

Wayfinder:
- **does not generate answers**
- **does not modify prompts**
- **does not hide uncertainty**

Wayfinder delegates routing judgment to a **router LLM**, subject to explicit policy constraints and token configuration.

Wayfinder returns:
- a primary model
- a reasonable alternate
- a confidence score
- an explainable rationale
- inferred intent metadata (internal)

---

## 2. Core Principles (MUST HOLD)

These principles are non-negotiable.

### 2.1 LLM-Driven Routing

- All routing decisions (primary, alternate, confidence) **MUST originate from a router LLM**.
- No heuristic, rule-based, or metadata-based routing is permitted.
- The system MUST NOT re-rank, override, or reinterpret the router LLM’s decision.

### 2.2 Policy as Constraint, Not Selector

- Policy **constrains eligibility** of models.
- Policy MUST NOT select, rank, or score models.
- If policy forces a model, routing MUST terminate immediately.

### 2.3 Intent Is Metadata, Not Control Flow

- Intent is inferred **only by the router LLM**.
- Intent is stored as metadata for analysis and future features.
- Intent MUST NOT directly drive routing decisions.
- Removing intent MUST NOT break routing behavior.

### 2.4 No Heuristics, No Capabilities

- The system MUST NOT use:
  - regex classifiers
  - keyword matching
  - static intent-to-model mappings
  - model “capabilities” or task labels
- All such logic is explicitly forbidden.

### 2.5 Deterministic Behavior

- Given the same:
  - token configuration
  - policy constraints
  - eligible model set
  - cached state
- Routing results MUST be deterministic.

---

## 3. System Boundaries

Wayfinder:

- Authenticates requests
- Loads token configuration
- Enforces policy constraints
- Determines eligible models
- Requests routing judgment from a router LLM
- Returns the LLM’s routing decision with explanation
- Records metadata for observability and learning

Wayfinder does NOT:

- Answer user prompts
- Implement local routing logic
- Infer intent heuristically
- Learn silently without logging

---

## 4. Authentication & Tokens

### 4.1 Token Model

Each API token represents a **policy boundary**.

A token MAY define:

- trusted_anchor_model
- allowed_models (allowlist)
- denied_models (denylist)
- policy_rules
- default_model
- confidence_threshold
- knowledge_scope
- logging_level
- environment

All token configuration MUST be validated at ingestion time.

---

## 5. Model Registry

### 5.1 Registry Role

The model registry is a **passive catalog and validation layer**.

It MAY contain:
- model identifiers
- provider
- availability
- status (active / deprecated / disabled)
- context window size
- descriptive cost / speed tiers
- eligibility constraints

It MUST NOT:
- rank models
- score models
- declare capabilities
- encode routing logic
- infer suitability

### 5.2 Validation

Model identifiers MUST be validated at:
- token creation/update
- policy ingestion
- routing results
- feedback ingestion

Invalid identifiers MUST fail fast.

---

## 6. Intent (Metadata Only)

### 6.1 Intent Semantics

- Every routing decision MUST include an inferred intent label.
- Intent is inferred **only by the router LLM**.
- Intent classification MUST be replaceable without affecting routing.

### 6.2 Intent Taxonomy

Canonical intents (initial set):

- code_change
- debugging
- architecture_design
- explanation
- summarization
- data_analysis
- content_generation
- planning
- other

Rules:
- Exactly one intent MUST be returned.
- `other` SHOULD be avoided.
- If used, `other` MUST be of the form `other:<single_word_subcategory>`.

Intent labels are **experimental telemetry**, not a stable API.

---

## 7. Policy Engine

### 7.1 Policy Role

Policies:
- constrain which models are eligible
- never choose or rank models

### 7.2 Policy Evaluation Order (MANDATORY)

1. Global allow/deny
2. Intent-based eligibility constraints (if defined)
3. Forced model rules

If a forced model is selected, routing MUST terminate.

### 7.3 Guarantees

- Policies MUST be validated at ingestion.
- Invalid policy MUST fail fast.
- Policy application MUST be auditable.

---

## 8. Routing Decision Flow (Authoritative)

For every request:

1. Authenticate token
2. Load token config
3. Apply policy constraints
4. Determine eligible model set
5. Invoke router LLM with:
   - user prompt
   - eligible models
   - routing criteria
6. Receive from LLM:
   - primary model
   - alternate model
   - confidence score (0–10)
   - inferred intent
   - concise reasoning
7. Validate response
8. Cache decision
9. Return result

At no point may local logic override the LLM’s decision.

---

## 9. Confidence Semantics

Confidence represents:

> How confident the router LLM is that the primary model is the best choice compared to the alternate.

- Range: 0–10
- Derived solely from the router LLM
- MUST NOT be computed heuristically

---

## 10. Knowledge & Feedback (Observational)

### 10.1 Knowledge Role

- Knowledge is observational telemetry.
- Knowledge is **not used to select or rank models in v1**.
- Knowledge exists to support:
  - analysis
  - explainability
  - future evolution

### 10.2 Scope

Supported scopes:
- global (default)
- token (enterprise)

No cross-scope reads or writes are permitted.

---

## 11. Opinion Polling

- Opinion polling exists to populate knowledge.
- Polling MUST be asynchronous.
- Polling MUST NOT block routing.
- Interfaces MUST exist even if stubbed.

---

## 12. Observability & Logging

Wayfinder MUST log:

- routing decision
- explanation
- confidence
- inferred intent
- applied policy
- knowledge scope
- request ID

Logs MUST allow full post-hoc reconstruction of decisions.

---

## 13. Failure Modes

Wayfinder MUST:

- Fail fast on invalid configuration
- Surface policy conflicts explicitly
- Treat uncertainty as a first-class state
- Never silently degrade correctness

---

## 14. Explicit Non-Goals

Wayfinder is NOT:

- a chatbot
- a prompt optimizer
- a heuristic router
- a capability-based system
- a model marketplace
- an auto-ML engine

---

## 15. Success Criteria

The system is compliant if:

- Routing decisions originate solely from the router LLM
- Policy constraints cannot be bypassed
- Removing intent does not break routing
- Removing alternates does not break routing
- Adding new models requires no code changes
- Architecture remains simple, explainable, and reversible
