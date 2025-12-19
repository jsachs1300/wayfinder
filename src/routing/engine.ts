import { RouteRequest, TokenConfig } from '../types';

export interface RoutingEngine {
  route(request: RouteRequest, tokenConfig: TokenConfig, requestId?: string): Promise<never>;
}

export interface RoutingEngineDependencies {}

export class DefaultRoutingEngine implements RoutingEngine {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_deps: RoutingEngineDependencies) {}

  async route(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    request: RouteRequest,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenConfig: TokenConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    requestId?: string
  ): Promise<never> {
    throw new Error('Routing engine removed pending LLM router implementation');
  }
}

export function createRoutingEngine(deps: RoutingEngineDependencies): RoutingEngine {
  return new DefaultRoutingEngine(deps);
}
