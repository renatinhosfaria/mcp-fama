---
name: mcp-fama
description: Use when working with Fama Chat MCP servers for Meta Ads, CRM Imobiliário, MinIO, or Obsidian.
---

# MCP-FAMA

Use this skill when the user asks Codex to work with Fama Chat operational data through the MCP-FAMA plugin.

## Available MCP Servers

- `meta-ads`: Meta Ads campaigns, ad sets, ads, creatives, audiences, insights, conversions, and account tools.
- `crm-postgres`: Fama Chat CRM Imobiliário data, including clients, leads, tasks, reminders, webhooks, and domain workflows.
- `minio`: MinIO/S3-compatible storage operations for buckets, objects, transfers, and storage administration.
- `obsidian`: Fama Chat Obsidian vault workflows, knowledge records, sync, and vault administration.

## Required Environment Variables

Codex reads bearer tokens from environment variables configured in `.mcp.json`:

- `META_ADS_API_KEY`
- `CRM_API_KEY`
- `MINIO_API_KEY`
- `OBSIDIAN_API_KEY`

If a server is unavailable, first check whether the matching environment variable is set in the Codex runtime.

## Safety Rules

- Prefer read-only tools for discovery, summaries, diagnostics, and reporting.
- Before using any tool that creates, updates, deletes, pauses, activates, uploads, writes, syncs, or mutates external state, explain the exact target and intended change, then wait for explicit user confirmation.
- Never reveal API keys, bearer tokens, database URLs, access tokens, or secrets in responses, logs, examples, commits, or generated files.
- Treat Meta Ads operations as high-impact: verify account, campaign, date range, amount, and currency before invoking write tools.
- For Obsidian writes, preserve existing frontmatter, links, and ownership conventions unless the user explicitly asks to change them.

## Operating Defaults

- Use the narrowest MCP server and tool that satisfies the request.
- Summarize destructive or high-impact results with IDs, names, and timestamps when available.
- If multiple Fama entities could match a user request, ask for clarification before mutating data.
