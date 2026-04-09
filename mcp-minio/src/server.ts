import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBucketTools } from './tools/buckets.js';
import { registerObjectTools } from './tools/objects.js';
import { registerTransferTools } from './tools/transfers.js';
import { registerAdminTools } from './tools/admin.js';
import { registerResources } from './resources/info.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'mcp-minio',
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

  registerBucketTools(server);   // 10 tools: buckets CRUD + policy + versioning + tags
  registerObjectTools(server);   // 10 tools: list, stat, delete, copy, move, tags, presigned URL
  registerTransferTools(server); // 4 tools:  get/put text + get/put JSON
  registerAdminTools(server);    // 6 tools:  server info, bucket summary, search, public URL, uploads
  registerResources(server);     // 2 resources: minio://server, minio://buckets

  console.log('[MCP] MinIO server created: 30 tools + 2 resources');
  return server;
}
