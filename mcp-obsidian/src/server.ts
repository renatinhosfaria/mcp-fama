// src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from './config.js';
import { VaultIndex } from './vault/index.js';
import { GitOps } from './vault/git.js';
import { ToolCtx } from './tools/_shared.js';
import * as crud from './tools/crud.js';
import * as wf from './tools/workflows.js';
import * as sync from './tools/sync.js';
import { vaultStatsResource, agentsMapResource } from './resources/vault.js';

let sharedCtx: ToolCtx | null = null;

async function getCtx(): Promise<ToolCtx> {
  if (!sharedCtx) {
    const index = new VaultIndex(config.vaultPath);
    await index.build();
    const git = new GitOps(config.vaultPath, config.gitLockfile, config.gitAuthorName, config.gitAuthorEmail);
    sharedCtx = { index, vaultRoot: config.vaultPath, git };
  }
  return sharedCtx;
}

export async function __getSharedCtxForHealth(): Promise<ToolCtx> { return await getCtx(); }

interface ToolDef {
  schema: any;
  handler: (args: unknown, ctx: ToolCtx) => Promise<any>;
  desc: string;
  annotations: Record<string, boolean>;
}

const TOOL_REGISTRY: Record<string, ToolDef> = {
  read_note:             { schema: crud.ReadNoteSchema,          handler: crud.readNote,          desc: 'Read a note by path',            annotations: { readOnlyHint: true, openWorldHint: false } },
  write_note:            { schema: crud.WriteNoteSchema,         handler: crud.writeNote,         desc: 'Create or overwrite a note',     annotations: { openWorldHint: false } },
  append_to_note:        { schema: crud.AppendToNoteSchema,      handler: crud.appendToNote,      desc: 'Append content to a note',       annotations: { openWorldHint: false } },
  delete_note:           { schema: crud.DeleteNoteSchema,        handler: crud.deleteNote,        desc: 'Delete a note (reason required)',annotations: { destructiveHint: true, openWorldHint: false } },
  list_folder:           { schema: crud.ListFolderSchema,        handler: crud.listFolder,        desc: 'List folder items',              annotations: { readOnlyHint: true, openWorldHint: false } },
  search_content:        { schema: crud.SearchContentSchema,     handler: crud.searchContent,     desc: 'Full-text search (ripgrep)',     annotations: { readOnlyHint: true, openWorldHint: false } },
  get_note_metadata:     { schema: crud.GetNoteMetadataSchema,   handler: crud.getNoteMetadata,   desc: 'Get note metadata',              annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  stat_vault:            { schema: crud.StatVaultSchema,         handler: crud.statVault,         desc: 'Vault statistics',               annotations: { readOnlyHint: true, openWorldHint: false } },
  create_journal_entry:  { schema: wf.CreateJournalEntrySchema,  handler: wf.createJournalEntry,  desc: 'Create a journal entry',         annotations: { openWorldHint: false } },
  append_decision:       { schema: wf.AppendDecisionSchema,      handler: wf.appendDecision,      desc: 'Prepend a decision block',       annotations: { openWorldHint: false } },
  update_agent_profile:  { schema: wf.UpdateAgentProfileSchema,  handler: wf.updateAgentProfile,  desc: 'Update agent profile body',      annotations: { idempotentHint: true, openWorldHint: false } },
  upsert_goal:           { schema: wf.UpsertGoalSchema,          handler: wf.upsertGoal,          desc: 'Upsert a monthly goal',          annotations: { idempotentHint: true, openWorldHint: false } },
  upsert_result:         { schema: wf.UpsertGoalSchema,          handler: wf.upsertResult,        desc: 'Upsert a monthly result',        annotations: { idempotentHint: true, openWorldHint: false } },
  read_agent_context:    { schema: wf.ReadAgentContextSchema,    handler: wf.readAgentContext,    desc: 'Read agent context bundle',      annotations: { readOnlyHint: true, openWorldHint: false } },
  get_agent_delta:       { schema: wf.GetAgentDeltaSchema,       handler: wf.getAgentDelta,       desc: 'What agent changed since',       annotations: { readOnlyHint: true, openWorldHint: false } },
  upsert_shared_context: { schema: wf.UpsertSharedContextSchema, handler: wf.upsertSharedContext, desc: 'Upsert curated shared context',  annotations: { idempotentHint: true, openWorldHint: false } },
  upsert_entity_profile: { schema: wf.UpsertEntityProfileSchema, handler: wf.upsertEntityProfile, desc: 'Upsert an entity profile',       annotations: { idempotentHint: true, openWorldHint: false } },
  search_by_tag:         { schema: wf.SearchByTagSchema,         handler: wf.searchByTag,         desc: 'Search notes by tag',            annotations: { readOnlyHint: true, openWorldHint: false } },
  search_by_type:        { schema: wf.SearchByTypeSchema,        handler: wf.searchByType,        desc: 'Search notes by type',           annotations: { readOnlyHint: true, openWorldHint: false } },
  get_backlinks:         { schema: wf.GetBacklinksSchema,        handler: wf.getBacklinks,        desc: 'Get backlinks for a note name',  annotations: { readOnlyHint: true, openWorldHint: false } },
  commit_and_push:       { schema: sync.CommitAndPushSchema,     handler: sync.commitAndPush,     desc: 'Commit + push vault',            annotations: { openWorldHint: false } },
  git_status:            { schema: sync.GitStatusSchema,         handler: sync.gitStatus,         desc: 'Git status of vault',            annotations: { readOnlyHint: true, openWorldHint: false } },
};

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'mcp-obsidian', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOL_REGISTRY).map(([name, { schema, desc, annotations }]) => ({
      name,
      description: desc,
      inputSchema: zodToJsonSchema(schema, name),
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const entry = TOOL_REGISTRY[req.params.name];
    if (!entry) throw new Error(`Unknown tool: ${req.params.name}`);
    const ctx = await getCtx();
    return await entry.handler(req.params.arguments, ctx);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'obsidian://vault',  name: 'Vault statistics', mimeType: 'application/json' },
      { uri: 'obsidian://agents', name: 'Ownership map',    mimeType: 'application/json' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const ctx = await getCtx();
    if (req.params.uri === 'obsidian://vault')  return { contents: [await vaultStatsResource(ctx)] };
    if (req.params.uri === 'obsidian://agents') return { contents: [await agentsMapResource(ctx)] };
    throw new Error(`Unknown resource: ${req.params.uri}`);
  });

  return server;
}
