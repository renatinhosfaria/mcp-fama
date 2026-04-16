import { Server } from '@modelcontextprotocol/sdk/server/index.js';

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'mcp-obsidian', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  // Tools and resources registered in later phases.
  return server;
}
