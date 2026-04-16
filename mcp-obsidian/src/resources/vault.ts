// src/resources/vault.ts
import { ToolCtx } from '../tools/_shared.js';

export interface ResourceContent { uri: string; mimeType: string; text: string; }

export async function vaultStatsResource(ctx: ToolCtx): Promise<ResourceContent> {
  const stats = {
    total_notes: ctx.index.size(),
    by_type: ctx.index.countsByType(),
    by_agent: ctx.index.countsByAgent(),
    index_age_ms: ctx.index.ageMs(),
  };
  return { uri: 'obsidian://vault', mimeType: 'application/json', text: JSON.stringify(stats, null, 2) };
}

export async function agentsMapResource(ctx: ToolCtx): Promise<ResourceContent> {
  const map = await ctx.index.getOwnershipResolver().getMap();
  return { uri: 'obsidian://agents', mimeType: 'application/json', text: JSON.stringify({ patterns: map }, null, 2) };
}
