import { describe, expect, it } from 'vitest';
import { computeIndexPolicy } from '../../src/vault/index-policy.js';

describe('computeIndexPolicy', () => {
  it('enables vector and graph indexes for canonical knowledge folders', () => {
    for (const folder of ['_entities', '_hubs', '_decisions', '_runbooks']) {
      expect(computeIndexPolicy(`${folder}/item.md`, {})).toEqual({ vector: true, graph: true });
    }
  });

  it('enables vector and graph indexes for journal notes', () => {
    expect(computeIndexPolicy('_journal/alfa/2026-05-11-note.md', {})).toEqual({ vector: true, graph: true });
  });

  it('enables vector and graph indexes for allowlisted canonical meta notes', () => {
    for (const rel of [
      '_meta/schema.md',
      '_meta/retrieval-policy.md',
      '_meta/pii-redaction-policy.md',
      '_meta/embedding-state.md',
      '_meta/golden-queries.md',
      '_meta/index.md',
      '_meta/README.md',
    ]) {
      expect(computeIndexPolicy(rel, {})).toEqual({ vector: true, graph: true });
    }
  });

  it('keeps non-allowlisted meta notes out of both vector and graph indexes', () => {
    expect(computeIndexPolicy('_meta/internal-audit.md', {})).toEqual({ vector: false, graph: false });
  });

  it('disables both indexes for drafts regardless of folder', () => {
    expect(computeIndexPolicy('_entities/clientes/acme.md', { status: 'draft' })).toEqual({ vector: false, graph: false });
  });

  it('keeps superseded and archived notes in graph only', () => {
    expect(computeIndexPolicy('_entities/clientes/old.md', { status: 'superseded' })).toEqual({ vector: false, graph: true });
    expect(computeIndexPolicy('_runbooks/old.md', { status: 'archived' })).toEqual({ vector: false, graph: true });
  });

  it('falls back to the folder rule for active or missing status', () => {
    expect(computeIndexPolicy('_entities/clientes/acme.md', { status: 'active' })).toEqual({ vector: true, graph: true });
    expect(computeIndexPolicy('misc/freeform.md', {})).toEqual({ vector: false, graph: false });
  });
});
