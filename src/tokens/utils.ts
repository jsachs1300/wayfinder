export interface DefaultTokenLike {
  is_default?: boolean;
  name?: string | null;
  user_id?: string | null;
}

export function isDefaultToken(config: DefaultTokenLike): boolean {
  if (config.is_default === true) {
    return true;
  }
  // Backward compatibility for legacy default tokens.
  return typeof config.user_id === 'string' && config.name === 'Default Token';
}
