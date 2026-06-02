import type { IndexEntry } from './index.js';

export interface AgentTerritory {
  hub: string;
  profile_candidates: string[];
  decisions_glob: string;
  journal_prefix: string;
  runbook_prefix: string;
  project_prefix: string;
  shared_context_prefix: string;
  legacy_profile: string;
  legacy_decisions: string;
}

export function agentTerritory(agent: string): AgentTerritory {
  return {
    hub: `_hubs/${agent}-hub.md`,
    profile_candidates: [
      `_runbooks/${agent}-profile.md`,
      `_shared/context/${agent}/profile.md`,
      `_agents/${agent}/profile.md`,
    ],
    decisions_glob: `_decisions/*-${agent}-*.md`,
    journal_prefix: `_journal/${agent}/`,
    runbook_prefix: `_runbooks/${agent}-`,
    project_prefix: `_projects/${agent}/`,
    shared_context_prefix: `_shared/context/${agent}/`,
    legacy_profile: `_agents/${agent}/profile.md`,
    legacy_decisions: `_agents/${agent}/decisions.md`,
  };
}

export function summarizeEntry(e: IndexEntry): Record<string, unknown> {
  return {
    path: e.path,
    type: e.type,
    owner: e.owner,
    updated: e.updated,
    tags: e.tags,
    mtime: new Date(e.mtimeMs).toISOString(),
  };
}

export function sortNewest(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort((x, y) => y.mtimeMs - x.mtimeMs);
}

export function authoredBy(e: IndexEntry, agent: string): boolean {
  return e.frontmatter?.author_agent === agent || e.owner === agent;
}

export function isAgentHub(e: IndexEntry, agent: string): boolean {
  return e.path === agentTerritory(agent).hub;
}

export function isAgentProfile(e: IndexEntry, agent: string): boolean {
  return agentTerritory(agent).profile_candidates.includes(e.path);
}

export function isAgentDecision(e: IndexEntry, agent: string): boolean {
  return e.path.startsWith('_decisions/')
    && e.path.includes(`-${agent}-`)
    && e.path.endsWith('.md');
}

export function isAgentJournal(e: IndexEntry, agent: string): boolean {
  return e.path.startsWith(agentTerritory(agent).journal_prefix)
    && e.path.endsWith('.md')
    && (e.type === 'journal' || e.type === 'interaction');
}

export function isAgentRunbook(e: IndexEntry, agent: string): boolean {
  return e.path.startsWith(agentTerritory(agent).runbook_prefix)
    && e.path.endsWith('.md');
}

export function isAgentProject(e: IndexEntry, agent: string): boolean {
  return e.path.startsWith(agentTerritory(agent).project_prefix)
    && e.path.endsWith('.md');
}

export function isAgentSharedContext(e: IndexEntry, agent: string): boolean {
  return e.path.startsWith(agentTerritory(agent).shared_context_prefix)
    && e.path.endsWith('.md');
}

export function isAgentEntityContribution(e: IndexEntry, agent: string): boolean {
  return e.path.startsWith('_entities/')
    && e.path.endsWith('.md')
    && e.frontmatter?.author_agent === agent;
}
