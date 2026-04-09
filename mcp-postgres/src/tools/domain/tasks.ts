import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerTasksTools(server: McpServer) {
  // 1. get_board - Board with lists and card counts/stats
  server.registerTool(
    'get_board',
    {
      title: 'Get Board',
      description:
        'Get a task board with its lists and card counts. If no board_id is provided, ' +
        'returns the first active board. Includes stats: total cards, completed, overdue.',
      inputSchema: {
        board_id: z.number().optional().describe('Board ID (defaults to first active board)'),
      },
    },
    async ({ board_id }) => {
      try {
        let boardSql: string;
        let boardParams: unknown[];

        if (board_id !== undefined) {
          boardSql = `SELECT * FROM famatasks_boards WHERE id = $1`;
          boardParams = [board_id];
        } else {
          boardSql = `SELECT * FROM famatasks_boards WHERE is_active = true ORDER BY position ASC, id ASC LIMIT 1`;
          boardParams = [];
        }

        const boardRes = await query(boardSql, boardParams);

        if (boardRes.rows.length === 0) {
          return {
            content: [{ type: 'text', text: 'No board found.' }],
            isError: true,
          };
        }

        const board = boardRes.rows[0];
        const resolvedBoardId = board.id;

        const [listsRes, statsRes] = await Promise.all([
          query(
            `SELECT
               l.id,
               l.name,
               l.position,
               l.color,
               l.is_archived,
               l.is_fixed,
               COUNT(c.id) AS card_count
             FROM famatasks_lists l
             LEFT JOIN famatasks_cards c ON c.list_id = l.id AND c.is_archived = false
             WHERE l.board_id = $1
             GROUP BY l.id
             ORDER BY l.position ASC`,
            [resolvedBoardId]
          ),
          query(
            `SELECT
               COUNT(c.id) AS total_cards,
               COUNT(c.id) FILTER (WHERE c.completed_at IS NOT NULL) AS completed,
               COUNT(c.id) FILTER (WHERE c.due_date < NOW() AND c.completed_at IS NULL) AS overdue
             FROM famatasks_cards c
             JOIN famatasks_lists l ON c.list_id = l.id
             WHERE l.board_id = $1 AND c.is_archived = false`,
            [resolvedBoardId]
          ),
        ]);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              board,
              lists: listsRes.rows,
              stats: statsRes.rows[0],
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching board: ${msg}` }], isError: true };
      }
    }
  );

  // 2. list_tasks - Cards with filters and joins
  server.registerTool(
    'list_tasks',
    {
      title: 'List Tasks',
      description:
        'List task cards with filters for board, list, assignee, priority, and archived status. ' +
        'Includes list name and assigned user name. Ordered by position.',
      inputSchema: {
        board_id: z.number().optional().describe('Filter by board ID'),
        list_id: z.number().optional().describe('Filter by list ID'),
        assigned_to: z.number().optional().describe('Filter by assigned user ID'),
        priority: z.string().optional().describe('Filter by priority (low, medium, high, urgent)'),
        is_archived: z.boolean().optional().default(false).describe('Include archived cards (default false)'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ board_id, list_id, assigned_to, priority, is_archived, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (board_id !== undefined) {
          conditions.push(`l.board_id = $${idx}`);
          params.push(board_id);
          idx++;
        }

        if (list_id !== undefined) {
          conditions.push(`c.list_id = $${idx}`);
          params.push(list_id);
          idx++;
        }

        if (assigned_to !== undefined) {
          conditions.push(`c.assigned_to = $${idx}`);
          params.push(assigned_to);
          idx++;
        }

        if (priority) {
          conditions.push(`c.priority = $${idx}`);
          params.push(priority);
          idx++;
        }

        conditions.push(`c.is_archived = $${idx}`);
        params.push(is_archived);
        idx++;

        const where = `WHERE ${conditions.join(' AND ')}`;

        params.push(limit);
        const limitIdx = idx;
        idx++;
        params.push(offset);
        const offsetIdx = idx;

        const sql = `
          SELECT
            c.id,
            c.title,
            c.description,
            c.due_date,
            c.position,
            c.priority,
            c.tags,
            c.tag_ids,
            c.is_archived,
            c.completed_at,
            c.estimated_hours,
            c.actual_hours,
            c.post_date,
            c.created_at,
            c.updated_at,
            l.id AS list_id,
            l.name AS list_name,
            u.id AS assigned_to_id,
            u.full_name AS assigned_to_name
          FROM famatasks_cards c
          JOIN famatasks_lists l ON c.list_id = l.id
          LEFT JOIN sistema_users u ON c.assigned_to = u.id
          ${where}
          ORDER BY c.position ASC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rows.length, tasks: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing tasks: ${msg}` }], isError: true };
      }
    }
  );

  // 3. create_task - Insert a new card
  server.registerTool(
    'create_task',
    {
      title: 'Create Task',
      description:
        'Create a new task card in a list. Returns the created card.',
      inputSchema: {
        list_id: z.number().describe('List ID to add the card to (required)'),
        title: z.string().describe('Card title (required)'),
        description: z.string().optional().describe('Card description'),
        priority: z
          .enum(['low', 'medium', 'high', 'urgent'])
          .optional()
          .default('medium')
          .describe('Priority level (default: medium)'),
        assigned_to: z.number().optional().describe('User ID to assign the card to'),
        due_date: z.string().optional().describe('Due date (ISO 8601 format)'),
        tags: z.array(z.string()).optional().describe('Array of tag strings'),
        estimated_hours: z.number().optional().describe('Estimated hours for the task'),
      },
    },
    async ({ list_id, title, description, priority, assigned_to, due_date, tags, estimated_hours }) => {
      try {
        // Get next position in the list
        const posRes = await query(
          `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM famatasks_cards WHERE list_id = $1`,
          [list_id]
        );
        const nextPos = posRes.rows[0].next_pos;

        const sql = `
          INSERT INTO famatasks_cards
            (list_id, title, description, priority, assigned_to, due_date, tags, estimated_hours, position, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          RETURNING *
        `;

        const params = [
          list_id,
          title,
          description || null,
          priority,
          assigned_to || null,
          due_date || null,
          tags || null,
          estimated_hours || null,
          nextPos,
        ];

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ created: result.rows[0] }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error creating task: ${msg}` }], isError: true };
      }
    }
  );

  // 4. update_task - Update a card with dynamic SET clause
  server.registerTool(
    'update_task',
    {
      title: 'Update Task',
      description:
        'Update a task card. Only provided fields are updated (dynamic SET clause). ' +
        'Returns the updated card.',
      inputSchema: {
        card_id: z.number().describe('Card ID to update (required)'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('New priority'),
        list_id: z.number().optional().describe('Move card to a different list'),
        assigned_to: z.number().optional().describe('Reassign to a different user'),
        due_date: z.string().optional().describe('New due date (ISO 8601)'),
        is_archived: z.boolean().optional().describe('Archive or unarchive the card'),
        completed_at: z.string().optional().describe('Completion timestamp (ISO 8601), or empty string to clear'),
        tags: z.array(z.string()).optional().describe('Replace tags array'),
        estimated_hours: z.number().optional().describe('Update estimated hours'),
        actual_hours: z.number().optional().describe('Update actual hours'),
      },
    },
    async ({ card_id, title, description, priority, list_id, assigned_to, due_date, is_archived, completed_at, tags, estimated_hours, actual_hours }) => {
      try {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        const fields: Array<{ key: string; value: unknown }> = [
          { key: 'title', value: title },
          { key: 'description', value: description },
          { key: 'priority', value: priority },
          { key: 'list_id', value: list_id },
          { key: 'assigned_to', value: assigned_to },
          { key: 'due_date', value: due_date },
          { key: 'is_archived', value: is_archived },
          { key: 'tags', value: tags },
          { key: 'estimated_hours', value: estimated_hours },
          { key: 'actual_hours', value: actual_hours },
        ];

        for (const { key, value } of fields) {
          if (value !== undefined) {
            setClauses.push(`${key} = $${idx}`);
            params.push(value);
            idx++;
          }
        }

        // Handle completed_at specially: empty string clears, otherwise sets
        if (completed_at !== undefined) {
          if (completed_at === '') {
            setClauses.push(`completed_at = NULL`);
          } else {
            setClauses.push(`completed_at = $${idx}`);
            params.push(completed_at);
            idx++;
          }
        }

        if (setClauses.length === 0) {
          return {
            content: [{ type: 'text', text: 'No fields to update.' }],
            isError: true,
          };
        }

        setClauses.push(`updated_at = NOW()`);

        params.push(card_id);
        const cardIdIdx = idx;

        const sql = `
          UPDATE famatasks_cards
          SET ${setClauses.join(', ')}
          WHERE id = $${cardIdIdx}
          RETURNING *
        `;

        const result = await query(sql, params);

        if (result.rows.length === 0) {
          return {
            content: [{ type: 'text', text: `Card with id ${card_id} not found.` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ updated: result.rows[0] }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error updating task: ${msg}` }], isError: true };
      }
    }
  );
}
