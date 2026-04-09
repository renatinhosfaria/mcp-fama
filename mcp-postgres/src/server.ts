import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGenericTools } from './tools/generic.js';
import { registerAdminTools } from './tools/admin.js';
import { registerClientesTools } from './tools/domain/clientes.js';
import { registerLeadsTools } from './tools/domain/leads.js';
import { registerImoveisTools } from './tools/domain/imoveis.js';
import { registerTasksTools } from './tools/domain/tasks.js';
import { registerSistemaTools } from './tools/domain/sistema.js';
import { registerResources } from './resources/schema.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'postgres-neondb',
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
  registerClientesTools(server);
  registerLeadsTools(server);
  registerImoveisTools(server);
  registerTasksTools(server);
  registerSistemaTools(server);
  registerResources(server);

  console.log('[MCP] Server created with 40 tools + 2 resources');
  return server;
}
