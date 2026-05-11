export type MinTrust = 'any' | 'verified' | 'human';

export type TrustLevel =
  | 'unverified_agent'
  | 'agent_verified'
  | 'human_verified'
  | 'human_curated'
  | 'imported_unknown';

export type VerifiedMode = 'none' | 'agent' | 'human' | 'source';

export interface TrustInfo {
  trust_level: TrustLevel;
  verified: boolean;
  verified_mode: VerifiedMode;
}

function verifierList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return [];
}

export function computeTrustLevel(fm: Record<string, any> | null | undefined, humanVerifiers: string[]): TrustInfo {
  if (fm?.source === 'human-curated') {
    return { trust_level: 'human_curated', verified: true, verified_mode: 'source' };
  }

  const verifiers = verifierList(fm?.verified_by);
  if (verifiers.length > 0) {
    const humans = new Set(humanVerifiers.map((v) => v.trim()).filter(Boolean));
    const verifiedByHuman = verifiers.some((v) => humans.has(v));
    return {
      trust_level: verifiedByHuman ? 'human_verified' : 'agent_verified',
      verified: true,
      verified_mode: verifiedByHuman ? 'human' : 'agent',
    };
  }

  if (fm?.source === 'imported') {
    return { trust_level: 'imported_unknown', verified: false, verified_mode: 'none' };
  }

  return { trust_level: 'unverified_agent', verified: false, verified_mode: 'none' };
}

export function passesMinTrust(info: TrustInfo, minTrust: MinTrust): boolean {
  if (minTrust === 'any') return true;
  if (minTrust === 'verified') return info.verified;
  return info.trust_level === 'human_curated' || info.trust_level === 'human_verified';
}
