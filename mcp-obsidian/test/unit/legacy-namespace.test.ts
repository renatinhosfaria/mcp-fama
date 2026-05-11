import { describe, expect, it } from 'vitest';
import { assertNoLegacyNamespaceWrite } from '../../src/tools/_shared.js';

describe('assertNoLegacyNamespaceWrite', () => {
  it('rejects writes under the removed _agents namespace', () => {
    expect(() => assertNoLegacyNamespaceWrite('_agents/reno/foo.md')).toThrow(/LEGACY_NAMESPACE_REMOVED/);
  });

  it('allows writes under the v1 journal namespace', () => {
    expect(() => assertNoLegacyNamespaceWrite('_journal/reno/foo.md')).not.toThrow();
  });
});
