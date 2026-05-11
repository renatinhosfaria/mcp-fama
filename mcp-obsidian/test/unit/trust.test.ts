import { describe, expect, it } from 'vitest';
import { computeTrustLevel, passesMinTrust } from '../../src/vault/trust.js';

const humans = ['Renato Faria', 'Maria'];

describe('computeTrustLevel', () => {
  it('treats human-curated source as human_curated', () => {
    expect(computeTrustLevel({ source: 'human-curated' }, humans)).toEqual({
      trust_level: 'human_curated',
      verified: true,
      verified_mode: 'source',
    });
  });

  it('treats agent-generated notes without verifier as unverified_agent', () => {
    expect(computeTrustLevel({ source: 'agent-generated', verified_by: null }, humans)).toEqual({
      trust_level: 'unverified_agent',
      verified: false,
      verified_mode: 'none',
    });
  });

  it('distinguishes agent and human verifiers', () => {
    expect(computeTrustLevel({ source: 'agent-generated', verified_by: 'reno' }, humans)).toEqual({
      trust_level: 'agent_verified',
      verified: true,
      verified_mode: 'agent',
    });
    expect(computeTrustLevel({ source: 'agent-generated', verified_by: ['reno', 'Maria'] }, humans)).toEqual({
      trust_level: 'human_verified',
      verified: true,
      verified_mode: 'human',
    });
  });

  it('treats imported notes without verifier as imported_unknown', () => {
    expect(computeTrustLevel({ source: 'imported' }, humans)).toEqual({
      trust_level: 'imported_unknown',
      verified: false,
      verified_mode: 'none',
    });
  });

  it('ignores malformed non-string verified_by values', () => {
    for (const verified_by of [true, 123, { name: 'reno' }]) {
      expect(computeTrustLevel({ source: 'agent-generated', verified_by }, humans)).toEqual({
        trust_level: 'unverified_agent',
        verified: false,
        verified_mode: 'none',
      });
    }
  });

  it('ignores empty verifier arrays but accepts non-empty strings inside arrays', () => {
    expect(computeTrustLevel({ source: 'agent-generated', verified_by: [''] }, humans)).toEqual({
      trust_level: 'unverified_agent',
      verified: false,
      verified_mode: 'none',
    });
    expect(computeTrustLevel({ source: 'agent-generated', verified_by: [' ', 'reno'] }, humans)).toEqual({
      trust_level: 'agent_verified',
      verified: true,
      verified_mode: 'agent',
    });
  });
});

describe('passesMinTrust', () => {
  it('allows any trust level for min_trust=any', () => {
    const info = computeTrustLevel({ source: 'agent-generated' }, humans);
    expect(passesMinTrust(info, 'any')).toBe(true);
  });

  it('allows verified but not unverified notes for min_trust=verified', () => {
    expect(passesMinTrust(computeTrustLevel({ verified_by: 'reno' }, humans), 'verified')).toBe(true);
    expect(passesMinTrust(computeTrustLevel({ source: 'agent-generated' }, humans), 'verified')).toBe(false);
  });

  it('allows only human-curated or human-verified notes for min_trust=human', () => {
    expect(passesMinTrust(computeTrustLevel({ source: 'human-curated' }, humans), 'human')).toBe(true);
    expect(passesMinTrust(computeTrustLevel({ verified_by: 'Renato Faria' }, humans), 'human')).toBe(true);
    expect(passesMinTrust(computeTrustLevel({ verified_by: 'reno' }, humans), 'human')).toBe(false);
  });
});
