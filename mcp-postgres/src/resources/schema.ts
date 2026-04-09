import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../db.js';

export function registerResources(server: McpServer) {
  // Resource: Full database schema
  server.registerResource(
    'postgres://schema',
    'postgres://schema',
    {
      description: 'Complete database schema: tables, columns, types, relationships',
      mimeType: 'application/json',
    },
    async () => {
      const [tables, fks, enums] = await Promise.all([
        query(`
          SELECT t.table_name, c.column_name, c.data_type, c.udt_name,
                 c.is_nullable, c.column_default
          FROM information_schema.tables t
          JOIN information_schema.columns c
            ON t.table_name = c.table_name AND t.table_schema = c.table_schema
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          ORDER BY t.table_name, c.ordinal_position
        `),
        query(`
          SELECT tc.table_name AS source_table, kcu.column_name AS source_column,
                 ccu.table_name AS target_table, ccu.column_name AS target_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
          JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name
          WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
          ORDER BY tc.table_name
        `),
        query(`
          SELECT t.typname AS enum_name,
                 json_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
          FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
          GROUP BY t.typname ORDER BY t.typname
        `),
      ]);

      // Group columns by table
      const schema: Record<string, unknown[]> = {};
      for (const row of tables.rows) {
        const t = row.table_name as string;
        if (!schema[t]) schema[t] = [];
        schema[t].push(row);
      }

      return {
        contents: [{
          uri: 'postgres://schema',
          mimeType: 'application/json',
          text: JSON.stringify({ tables: schema, foreign_keys: fks.rows, enums: enums.rows }, null, 2),
        }],
      };
    }
  );

  // Resource: Database health stats
  server.registerResource(
    'postgres://stats',
    'postgres://stats',
    {
      description: 'Database health dashboard: cache, connections, bloat, vacuum status',
      mimeType: 'application/json',
    },
    async () => {
      const [health, tableStats] = await Promise.all([
        query(`
          SELECT
            pg_size_pretty(pg_database_size('neondb')) AS db_size,
            ROUND(blks_hit::numeric / NULLIF(blks_hit + blks_read, 0) * 100, 2) AS cache_hit_pct,
            numbackends AS connections,
            xact_commit AS commits, xact_rollback AS rollbacks
          FROM pg_stat_database WHERE datname = 'neondb'
        `),
        query(`
          SELECT relname, n_live_tup, n_dead_tup,
                 ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct,
                 last_autovacuum::timestamp(0), last_autoanalyze::timestamp(0)
          FROM pg_stat_user_tables WHERE schemaname = 'public'
          ORDER BY dead_pct DESC NULLS LAST LIMIT 10
        `),
      ]);

      return {
        contents: [{
          uri: 'postgres://stats',
          mimeType: 'application/json',
          text: JSON.stringify({
            health: health.rows[0],
            top_bloat_tables: tableStats.rows,
          }, null, 2),
        }],
      };
    }
  );
}
