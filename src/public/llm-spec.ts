import type { RouterModelPreference } from '../types';

export interface LLMIntegrationEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: 'none' | 'token' | 'session' | 'admin';
  purpose: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  notes?: string[];
}

export interface LLMIntegrationSpec {
  name: string;
  version: string;
  generated_at: string;
  summary: string;
  auth_headers: Array<{
    header: string;
    used_for: string[];
    obtain_via: string;
  }>;
  core_endpoints: LLMIntegrationEndpoint[];
  admin_endpoints: LLMIntegrationEndpoint[];
  user_self_service: {
    enabled: boolean;
    endpoints: LLMIntegrationEndpoint[];
  };
  routing_contract: {
    request: {
      prompt: string;
      router_model: RouterModelPreference;
    };
    response_fields: string[];
    cache_behavior: string[];
  };
  integration_patterns: Array<{
    name: string;
    why: string;
    implementation: string[];
  }>;
  implementation_checklist: string[];
  llm_discovery: {
    llms_txt: string;
    prompt_txt: string;
    mcp_endpoint: string;
    well_known: string[];
  };
}

export function renderLLMSpecText(spec: LLMIntegrationSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.name}`);
  lines.push(`Version: ${spec.version}`);
  lines.push(`Generated: ${spec.generated_at}`);
  lines.push('');
  lines.push(spec.summary);
  lines.push('');
  lines.push('## Auth Headers');
  for (const header of spec.auth_headers) {
    lines.push(`- ${header.header}: used for ${header.used_for.join(', ')}.`);
    lines.push(`  Obtain via: ${header.obtain_via}`);
  }
  lines.push('');
  lines.push('## Core Endpoints');
  for (const endpoint of spec.core_endpoints) {
    lines.push(`- ${endpoint.method} ${endpoint.path} (${endpoint.auth})`);
    lines.push(`  Purpose: ${endpoint.purpose}`);
  }
  lines.push('');
  lines.push('## Admin Endpoints');
  for (const endpoint of spec.admin_endpoints) {
    lines.push(`- ${endpoint.method} ${endpoint.path} (${endpoint.auth})`);
    lines.push(`  Purpose: ${endpoint.purpose}`);
  }
  lines.push('');
  lines.push(`## User Self-Service Enabled: ${spec.user_self_service.enabled ? 'yes' : 'no'}`);
  if (spec.user_self_service.enabled) {
    for (const endpoint of spec.user_self_service.endpoints) {
      lines.push(`- ${endpoint.method} ${endpoint.path} (${endpoint.auth})`);
      lines.push(`  Purpose: ${endpoint.purpose}`);
    }
  }
  lines.push('');
  lines.push('## /route Contract');
  lines.push(`- Request fields: ${Object.keys(spec.routing_contract.request).join(', ')}`);
  lines.push(`- Response fields: ${spec.routing_contract.response_fields.join(', ')}`);
  lines.push('');
  lines.push('## Cache Behavior');
  for (const note of spec.routing_contract.cache_behavior) {
    lines.push(`- ${note}`);
  }
  lines.push('');
  lines.push('## Integration Patterns');
  for (const pattern of spec.integration_patterns) {
    lines.push(`- ${pattern.name}: ${pattern.why}`);
    for (const step of pattern.implementation) {
      lines.push(`  - ${step}`);
    }
  }
  lines.push('');
  lines.push('## LLM Discovery');
  lines.push(`- llms.txt: ${spec.llm_discovery.llms_txt}`);
  lines.push(`- prompt.txt: ${spec.llm_discovery.prompt_txt}`);
  lines.push(`- MCP endpoint: ${spec.llm_discovery.mcp_endpoint}`);
  lines.push(`- Well-known: ${spec.llm_discovery.well_known.join(', ')}`);
  lines.push('');
  lines.push('## Implementation Checklist');
  for (const item of spec.implementation_checklist) {
    lines.push(`- ${item}`);
  }

  return `${lines.join('\n')}\n`;
}

export function buildLLMIntegrationSpec(userSelfServiceEnabled: boolean): LLMIntegrationSpec {
  const coreEndpoints: LLMIntegrationEndpoint[] = [
    {
      method: 'GET',
      path: '/health',
      auth: 'none',
      purpose: 'Service health, Redis status, LangCache status',
    },
    {
      method: 'POST',
      path: '/route',
      auth: 'token',
      purpose: 'Get model routing decision for a prompt',
      request: {
        prompt: 'Write a SQL query to find churned users this month',
        router_model: 'consensus',
      },
      response: {
        primary: { model: 'gpt-4o-mini', score: 9, reason: '...' },
        alternate: { model: 'gemini-2.5-flash', score: 8, reason: '...' },
        router_model_used: 'consensus',
        from_cache: false,
        request_id: 'uuid',
      },
      notes: [
        'Use X-Wayfinder-Token header.',
        'router_model is optional and defaults to consensus.',
      ],
    },
    {
      method: 'POST',
      path: '/feedback',
      auth: 'token',
      purpose: 'Send user feedback to improve future routing decisions',
      request: {
        request_id: 'uuid-from-route-response',
        selected_model: 'gpt-4o-mini',
        intent_label: 'coding',
        rating: 'positive',
      },
      response: {
        feedback_id: 'uuid',
        acknowledged: true,
      },
      notes: [
        'Use this after downstream execution to teach model preference per intent.',
      ],
    },
  ];

  const adminEndpoints: LLMIntegrationEndpoint[] = [
    {
      method: 'GET',
      path: '/admin/tokens',
      auth: 'admin',
      purpose: 'List all tokens, configs, and usage metrics',
    },
    {
      method: 'POST',
      path: '/admin/tokens',
      auth: 'admin',
      purpose: 'Create token for integration and automation clients',
    },
    {
      method: 'GET',
      path: '/admin/registry',
      auth: 'admin',
      purpose: 'Read full model registry with metadata',
    },
    {
      method: 'POST',
      path: '/admin/registry/refresh',
      auth: 'admin',
      purpose: 'Sync registry from provider catalogs',
    },
    {
      method: 'GET',
      path: '/admin/default-token-profile',
      auth: 'admin',
      purpose: 'Read system-wide default token model set',
    },
    {
      method: 'PUT',
      path: '/admin/default-token-profile',
      auth: 'admin',
      purpose: 'Update system-wide default token model set',
      notes: [
        'Changing this updates default-token cache scope version.',
        'Cache clear is recommended after major model-set changes.',
      ],
    },
    {
      method: 'GET',
      path: '/admin/cache/stats',
      auth: 'admin',
      purpose: 'Observe cache hit/miss/store behavior',
    },
  ];

  const userEndpoints: LLMIntegrationEndpoint[] = userSelfServiceEnabled
    ? [
      {
        method: 'POST',
        path: '/api/users/register',
        auth: 'none',
        purpose: 'Email-based registration start',
      },
      {
        method: 'POST',
        path: '/api/users/complete-registration',
        auth: 'none',
        purpose: 'Set password after email verification',
      },
      {
        method: 'POST',
        path: '/api/sessions/login',
        auth: 'none',
        purpose: 'Create user session and return session token + user tokens',
      },
      {
        method: 'POST',
        path: '/api/sessions/validate',
        auth: 'session',
        purpose: 'Validate session and refresh app state',
      },
      {
        method: 'GET',
        path: '/api/tokens',
        auth: 'session',
        purpose: 'List user tokens with metrics and eligible_models',
      },
      {
        method: 'POST',
        path: '/api/tokens/:token_id/route',
        auth: 'session',
        purpose: 'Route using selected token id without exposing token secret to the frontend',
      },
      {
        method: 'POST',
        path: '/api/tokens',
        auth: 'session',
        purpose: 'Create additional user token',
      },
      {
        method: 'GET',
        path: '/api/registry',
        auth: 'session',
        purpose: 'Read effective model registry (for real-time model validation UX)',
      },
    ]
    : [];

  return {
    name: 'Wayfinder LLM Integration Spec',
    version: '1.0',
    generated_at: new Date().toISOString(),
    summary:
      'Public machine-readable integration guide for LLM-driven app builders using Wayfinder routing.',
    auth_headers: [
      {
        header: 'X-Wayfinder-Token',
        used_for: ['/route', '/feedback'],
        obtain_via: 'Create token via admin or user token APIs.',
      },
      {
        header: 'X-Session-Token',
        used_for: ['/api/sessions/validate', '/api/tokens', '/api/registry'],
        obtain_via: 'Returned by /api/sessions/login.',
      },
      {
        header: 'X-Admin-Api-Key',
        used_for: ['/admin/*'],
        obtain_via: 'Server-side secret for admin operations.',
      },
    ],
    core_endpoints: coreEndpoints,
    admin_endpoints: adminEndpoints,
    user_self_service: {
      enabled: userSelfServiceEnabled,
      endpoints: userEndpoints,
    },
    routing_contract: {
      request: {
        prompt: 'Example prompt text',
        router_model: 'consensus',
      },
      response_fields: [
        'primary.model',
        'primary.score',
        'primary.reason',
        'alternate.model',
        'alternate.score',
        'alternate.reason',
        'router_model_used',
        'from_cache',
        'request_id',
      ],
      cache_behavior: [
        'Non-default tokens use token-scoped cache keys.',
        'Default tokens use global cache scope.',
        'Cache hits are indicated by from_cache=true on /route responses.',
      ],
    },
    integration_patterns: [
      {
        name: 'Chat Orchestrator',
        why: 'Select best model per user message before generation.',
        implementation: [
          'Call POST /route for each inbound message.',
          'Invoke selected provider/model in your app runtime.',
          'Submit POST /feedback once user outcome is known.',
        ],
      },
      {
        name: 'Task-Type Routing',
        why: 'Use different tokens per workload (support, coding, analytics).',
        implementation: [
          'Create multiple tokens with different eligible_models.',
          'Map app feature areas to specific tokens.',
          'Track metrics via token list endpoints for tuning.',
        ],
      },
      {
        name: 'Cost + Latency Control Loop',
        why: 'Continuously optimize cost and response time.',
        implementation: [
          'Monitor cache hit rate and route request volume per token.',
          'Adjust token eligible_models and default-token profile.',
          'Refresh model registry and prune deprecated models.',
        ],
      },
      {
        name: 'Admin Control Plane',
        why: 'Expose internal tools to tune routing safely in production.',
        implementation: [
          'Use /admin/registry for model metadata curation.',
          'Use /admin/default-token-profile for global default behavior.',
          'Use /admin/cache/* after profile/model changes.',
        ],
      },
    ],
    implementation_checklist: [
      'Store X-Wayfinder-Token server-side when possible.',
      'Always pass request_id from /route into /feedback.',
      'Handle HTTP 429 with retry/backoff and UI fallback.',
      'Use /api/registry data for real-time eligible_models validation in token forms.',
      'Support switching router_model (openai/gemini/consensus) per request when needed.',
      'Add telemetry for selected model, latency, and downstream outcome.',
    ],
    llm_discovery: {
      llms_txt: '/llms.txt',
      prompt_txt: '/prompt.txt',
      mcp_endpoint: '/mcp',
      well_known: ['/.well-known/ai-plugin.json'],
    },
  };
}
