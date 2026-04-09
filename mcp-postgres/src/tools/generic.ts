import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../db.js';

export function registerGenericTools(server: McpServer) {
  // 1. query - Execute arbitrary SQL
  server.registerTool(
    'query',
    {
      title: 'Execute SQL',
      description: 'Execute arbitrary SQL against the neondb database. Supports SELECT, INSERT, UPDATE, DELETE, DDL statements.',
      inputSchema: {
        sql: z.string().describe('SQL statement to execute'),
        params: z.array(z.unknown()).optional().describe('Query parameters for parameterized queries ($1, $2, ...)'),
        timeout_ms: z.number().optional().describe('Query timeout in milliseconds (default: 30000)'),
      },
    },
    async ({ sql: sqlStr, params, timeout_ms }) => {
      try {
        const result = await query(sqlStr, params as unknown[] | undefined, timeout_ms);
        const response: Record<string, unknown> = {
          rowCount: result.rowCount,
          rows: result.rows,
        };
        if (result.fields) {
          response.fields = result.fields.map((f) => ({ name: f.name, dataType: f.dataTypeID }));
        }
        return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `SQL Error: ${msg}` }], isError: true };
      }
    }
  );

  // 2. list_tables - List all tables with stats
  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description: 'List all tables in the database with row counts, sizes, and index sizes.',
      inputSchema: {
        schema: z.string().optional().default('public').describe('Schema name (default: public)'),
      },
    },
    async ({ schema }) => {
      const result = await query(`
        SELECT
          t.tablename AS table_name,
          COALESCE(s.n_live_tup, 0) AS row_count,
          pg_size_pretty(pg_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))) AS table_size,
          pg_size_pretty(pg_indexes_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))) AS index_size,
          pg_size_pretty(pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))) AS total_size
        FROM pg_tables t
        LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname AND t.schemaname = s.schemaname
        WHERE t.schemaname = $1
        ORDER BY pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)) DESC
      `, [schema]);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    }
  );

  // 3. describe_table - Full schema of a table
  server.registerTool(
    'describe_table',
    {
      title: 'Describe Table',
      description: 'Show complete schema of a table: columns, types, constraints, indexes, and foreign keys.',
      inputSchema: {
        table: z.string().describe('Table name'),
        schema: z.string().optional().default('public').describe('Schema name (default: public)'),
      },
    },
    async ({ table, schema }) => {
      const [columns, indexes, fks, constraints] = await Promise.all([
        query(`
          SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, table]),
        query(`
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2
          ORDER BY indexname
        `, [schema, table]),
        query(`
          SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
          JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
        `, [schema, table]),
        query(`
          SELECT constraint_name, constraint_type
          FROM information_schema.table_constraints
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY constraint_type, constraint_name
        `, [schema, table]),
      ]);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            table: `${schema}.${table}`,
            columns: columns.rows,
            indexes: indexes.rows,
            foreign_keys: fks.rows,
            constraints: constraints.rows,
          }, null, 2),
        }],
      };
    }
  );

  // 4. list_relationships - FK map
  server.registerTool(
    'list_relationships',
    {
      title: 'List Relationships',
      description: 'Show all foreign key relationships between tables.',
      inputSchema: {
        table: z.string().optional().describe('Filter by table name (optional)'),
      },
    },
    async ({ table }) => {
      let sql = `
        SELECT tc.table_name AS source_table, kcu.column_name AS source_column,
               ccu.table_name AS target_table, ccu.column_name AS target_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name
        WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
      `;
      const params: string[] = [];
      if (table) {
        sql += ` AND (tc.table_name = $1 OR ccu.table_name = $1)`;
        params.push(table);
      }
      sql += ` ORDER BY tc.table_name, kcu.column_name`;
      const result = await query(sql, params);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    }
  );

  // 5. explain_query - EXPLAIN ANALYZE
  server.registerTool(
    'explain_query',
    {
      title: 'Explain Query',
      description: 'Run EXPLAIN ANALYZE on a SQL query to see the execution plan.',
      inputSchema: {
        sql: z.string().describe('SQL query to explain'),
      },
    },
    async ({ sql: sqlStr }) => {
      try {
        const result = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sqlStr}`);
        const plan = result.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
        return { content: [{ type: 'text', text: plan }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Explain Error: ${msg}` }], isError: true };
      }
    }
  );

  // 6. list_enums - List enum types
  server.registerTool(
    'list_enums',
    {
      title: 'List Enums',
      description: 'List all custom enum types and their values.',
      inputSchema: {},
    },
    async () => {
      const result = await query(`
        SELECT t.typname AS enum_name,
               json_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        GROUP BY t.typname
        ORDER BY t.typname
      `);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    }
  );
}
