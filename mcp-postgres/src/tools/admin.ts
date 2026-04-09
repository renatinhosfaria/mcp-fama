import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../db.js';

export function registerAdminTools(server: McpServer) {
  // 7. database_stats - Overall health
  server.registerTool(
    'database_stats',
    {
      title: 'Database Stats',
      description: 'Get overall database health: size, cache hit rate, connections, commits/rollbacks, uptime.',
      inputSchema: {},
    },
    async () => {
      const [dbStats, connStats, settings] = await Promise.all([
        query(`
          SELECT
            pg_size_pretty(pg_database_size('neondb')) AS db_size,
            blks_hit, blks_read,
            ROUND(blks_hit::numeric / NULLIF(blks_hit + blks_read, 0) * 100, 2) AS cache_hit_pct,
            xact_commit, xact_rollback,
            ROUND(xact_rollback::numeric / NULLIF(xact_commit + xact_rollback, 0) * 100, 2) AS rollback_pct,
            numbackends AS active_connections,
            stats_reset
          FROM pg_stat_database WHERE datname = 'neondb'
        `),
        query(`
          SELECT
            COUNT(*) AS total_connections,
            COUNT(*) FILTER (WHERE state = 'active') AS active,
            COUNT(*) FILTER (WHERE state = 'idle') AS idle,
            COUNT(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx
          FROM pg_stat_activity WHERE datname = 'neondb'
        `),
        query(`
          SELECT name, setting FROM pg_settings
          WHERE name IN ('max_connections', 'shared_buffers', 'work_mem', 'effective_cache_size')
        `),
      ]);

      const uptime = await query(`SELECT now() - pg_postmaster_start_time() AS uptime`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            database: dbStats.rows[0],
            connections: connStats.rows[0],
            settings: settings.rows,
            uptime: uptime.rows[0]?.uptime,
          }, null, 2),
        }],
      };
    }
  );

  // 8. table_stats - Maintenance stats
  server.registerTool(
    'table_stats',
    {
      title: 'Table Stats',
      description: 'Get maintenance stats: dead tuples, vacuum status, bloat, scan counts.',
      inputSchema: {
        table: z.string().optional().describe('Filter by table name (optional, shows all if omitted)'),
      },
    },
    async ({ table }) => {
      let sql = `
        SELECT
          relname AS table_name,
          n_live_tup AS live_rows, n_dead_tup AS dead_rows,
          ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct,
          last_vacuum::timestamp(0), last_autovacuum::timestamp(0),
          last_analyze::timestamp(0), last_autoanalyze::timestamp(0),
          seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
          n_mod_since_analyze AS rows_since_analyze
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
      `;
      const params: string[] = [];
      if (table) {
        sql += ` AND relname = $1`;
        params.push(table);
      }
      sql += ` ORDER BY dead_pct DESC NULLS LAST`;
      const result = await query(sql, params);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    }
  );

  // 9. vacuum_table - VACUUM ANALYZE
  server.registerTool(
    'vacuum_table',
    {
      title: 'Vacuum Table',
      description: 'Run VACUUM ANALYZE on a table to reclaim dead rows and update statistics.',
      inputSchema: {
        table: z.string().describe('Table name to vacuum'),
        full: z.boolean().optional().default(false).describe('Run VACUUM FULL (locks table, rewrites data)'),
      },
    },
    async ({ table, full }) => {
      const safeName = table.replace(/[^a-zA-Z0-9_]/g, '');
      const cmd = full ? `VACUUM FULL ANALYZE public.${safeName}` : `VACUUM ANALYZE public.${safeName}`;
      try {
        await query(cmd);
        return { content: [{ type: 'text', text: `Successfully executed: ${cmd}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Vacuum Error: ${msg}` }], isError: true };
      }
    }
  );

  // 10. running_queries - Active queries
  server.registerTool(
    'running_queries',
    {
      title: 'Running Queries',
      description: 'Show currently running queries, their duration, state, and wait events.',
      inputSchema: {},
    },
    async () => {
      const result = await query(`
        SELECT
          pid, usename, application_name, client_addr::text,
          state, wait_event_type, wait_event,
          now() - query_start AS duration,
          LEFT(query, 200) AS query_snippet
        FROM pg_stat_activity
        WHERE datname = 'neondb' AND pid <> pg_backend_pid()
        ORDER BY
          CASE state WHEN 'active' THEN 0 ELSE 1 END,
          query_start ASC NULLS LAST
      `);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    }
  );

  // 11. kill_query - Terminate query by PID
  server.registerTool(
    'kill_query',
    {
      title: 'Kill Query',
      description: 'Terminate a running query by its process ID (PID).',
      inputSchema: {
        pid: z.number().describe('Process ID of the query to terminate'),
      },
    },
    async ({ pid }) => {
      const result = await query(`SELECT pg_terminate_backend($1) AS terminated`, [pid]);
      const terminated = result.rows[0]?.terminated;
      return {
        content: [{
          type: 'text',
          text: terminated
            ? `Process ${pid} terminated successfully`
            : `Could not terminate process ${pid} (may have already ended)`,
        }],
      };
    }
  );

  // 12. index_usage - Index analysis
  server.registerTool(
    'index_usage',
    {
      title: 'Index Usage',
      description: 'Analyze index usage: most/least used indexes, unused indexes, and sizes.',
      inputSchema: {
        table: z.string().optional().describe('Filter by table name (optional)'),
      },
    },
    async ({ table }) => {
      let sql = `
        SELECT
          schemaname, relname AS table_name, indexrelname AS index_name,
          idx_scan AS scans, idx_tup_read AS tuples_read,
          pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
          CASE WHEN idx_scan = 0 THEN 'UNUSED' ELSE 'USED' END AS status,
          last_idx_scan::timestamp(0)
        FROM pg_stat_user_indexes
        WHERE schemaname = 'public'
      `;
      const params: string[] = [];
      if (table) {
        sql += ` AND relname = $1`;
        params.push(table);
      }
      sql += ` ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC`;
      const result = await query(sql, params);

      const unused = result.rows.filter((r: Record<string, unknown>) => r.status === 'UNUSED');
      const totalUnusedSize = await query(`
        SELECT pg_size_pretty(COALESCE(SUM(pg_relation_size(indexrelid)), 0)) AS wasted_space,
               COUNT(*) AS unused_count
        FROM pg_stat_user_indexes
        WHERE schemaname = 'public' AND idx_scan = 0
        ${table ? `AND relname = '${table.replace(/'/g, "''")}'` : ''}
      `);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            indexes: result.rows,
            summary: {
              total_indexes: result.rows.length,
              unused_indexes: unused.length,
              ...totalUnusedSize.rows[0],
            },
          }, null, 2),
        }],
      };
    }
  );
}
