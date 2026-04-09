import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGenericTools } from './tools/generic.js';
import { registerAdminTools } from './tools/admin.js';
import { registerFinancasTools } from './tools/domain/financas.js';
import { registerResources } from './resources/schema.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'postgres-financas',
      version: '1.0.0',
    },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
      },
    }
  );

  registerGenericTools(server);
  registerAdminTools(server);
  registerFinancasTools(server);
  registerResources(server);

  console.log('[MCP] Server created with 23 tools + 2 resources');
  return server;
}
