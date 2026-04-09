import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerFinancasTools(server: McpServer) {
  // 1. list_categories - List categories with filters
  server.registerTool(
    'list_categories',
    {
      title: 'List Categories',
      description: 'List financial categories. Filter by type (receita/despesa/ambos), scope (pessoal/empresa), or is_default.',
      inputSchema: {
        type: z.enum(['receita', 'despesa', 'ambos']).optional().describe('Filter by category type'),
        scope: z.enum(['pessoal', 'empresa']).optional().describe('Filter by scope'),
        is_default: z.boolean().optional().describe('Filter default categories only'),
      },
    },
    async ({ type, scope, is_default }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (type) {
          conditions.push(`type = $${idx}`);
          params.push(type);
          idx++;
        }
        if (scope) {
          conditions.push(`scope = $${idx}`);
          params.push(scope);
          idx++;
        }
        if (is_default !== undefined) {
          conditions.push(`is_default = $${idx}`);
          params.push(is_default);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await query(`
          SELECT id, name, color, type, scope, is_default, created_at, updated_at
          FROM categories
          ${where}
          ORDER BY type, name
        `, params);

        return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 2. create_category - Create a new category
  server.registerTool(
    'create_category',
    {
      title: 'Create Category',
      description: 'Create a new financial category.',
      inputSchema: {
        name: z.string().describe('Category name'),
        type: z.enum(['receita', 'despesa', 'ambos']).describe('Category type'),
        scope: z.enum(['pessoal', 'empresa']).describe('Scope'),
        color: z.string().optional().default('#818cf8').describe('Hex color (default: #818cf8)'),
        is_default: z.boolean().optional().default(false).describe('Mark as default category'),
      },
    },
    async ({ name, type, scope, color, is_default }) => {
      try {
        const result = await query(
          `INSERT INTO categories (name, type, scope, color, is_default)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [name, type, scope, color, is_default]
        );
        return { content: [{ type: 'text', text: JSON.stringify(result.rows[0], null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 3. update_category - Update an existing category
  server.registerTool(
    'update_category',
    {
      title: 'Update Category',
      description: 'Update an existing financial category by ID.',
      inputSchema: {
        id: z.string().uuid().describe('Category UUID'),
        name: z.string().optional().describe('New name'),
        type: z.enum(['receita', 'despesa', 'ambos']).optional().describe('New type'),
        scope: z.enum(['pessoal', 'empresa']).optional().describe('New scope'),
        color: z.string().optional().describe('New hex color'),
        is_default: z.boolean().optional().describe('Set as default'),
      },
    },
    async ({ id, name, type, scope, color, is_default }) => {
      try {
        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (name !== undefined) { sets.push(`name = $${idx}`); params.push(name); idx++; }
        if (type !== undefined) { sets.push(`type = $${idx}`); params.push(type); idx++; }
        if (scope !== undefined) { sets.push(`scope = $${idx}`); params.push(scope); idx++; }
        if (color !== undefined) { sets.push(`color = $${idx}`); params.push(color); idx++; }
        if (is_default !== undefined) { sets.push(`is_default = $${idx}`); params.push(is_default); idx++; }

        if (sets.length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update.' }] };
        }

        sets.push(`updated_at = now()`);
        params.push(id);
        const result = await query(
          `UPDATE categories SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
          params
        );

        if (result.rowCount === 0) {
          return { content: [{ type: 'text', text: `Category ${id} not found.` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.rows[0], null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 4. delete_category - Delete a category (only if no transactions reference it)
  server.registerTool(
    'delete_category',
    {
      title: 'Delete Category',
      description: 'Delete a financial category by ID. Fails if transactions still reference it.',
      inputSchema: {
        id: z.string().uuid().describe('Category UUID to delete'),
      },
    },
    async ({ id }) => {
      try {
        const usage = await query(`SELECT COUNT(*) AS count FROM transactions WHERE category_id = $1`, [id]);
        const count = parseInt(usage.rows[0].count, 10);
        if (count > 0) {
          return {
            content: [{ type: 'text', text: `Cannot delete: ${count} transaction(s) still reference this category.` }],
            isError: true,
          };
        }

        const result = await query(`DELETE FROM categories WHERE id = $1 RETURNING name`, [id]);
        if (result.rowCount === 0) {
          return { content: [{ type: 'text', text: `Category ${id} not found.` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Category "${result.rows[0].name}" deleted.` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 5. search_transactions - Search transactions with filters
  server.registerTool(
    'search_transactions',
    {
      title: 'Search Transactions',
      description: 'Search transactions with filters: type, scope, category, date range, payment status, kind, description search.',
      inputSchema: {
        search: z.string().optional().describe('Search in description (ILIKE)'),
        type: z.enum(['receita', 'despesa']).optional().describe('Filter by transaction type'),
        scope: z.enum(['pessoal', 'empresa']).optional().describe('Filter by scope'),
        category_id: z.string().uuid().optional().describe('Filter by category UUID'),
        date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
        is_paid: z.boolean().optional().describe('Filter by payment status'),
        transaction_kind: z.enum(['unica', 'parcelamento', 'recorrente']).optional().describe('Filter by kind'),
        limit: z.number().optional().default(50).describe('Max results (default 50)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ search, type, scope, category_id, date_from, date_to, is_paid, transaction_kind, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (search) {
          conditions.push(`t.description ILIKE $${idx}`);
          params.push(`%${search}%`);
          idx++;
        }
        if (type) {
          conditions.push(`t.type = $${idx}`);
          params.push(type);
          idx++;
        }
        if (scope) {
          conditions.push(`t.scope = $${idx}`);
          params.push(scope);
          idx++;
        }
        if (category_id) {
          conditions.push(`t.category_id = $${idx}`);
          params.push(category_id);
          idx++;
        }
        if (date_from) {
          conditions.push(`t.date >= $${idx}`);
          params.push(date_from);
          idx++;
        }
        if (date_to) {
          conditions.push(`t.date <= $${idx}`);
          params.push(date_to);
          idx++;
        }
        if (is_paid !== undefined) {
          conditions.push(`t.is_paid = $${idx}`);
          params.push(is_paid);
          idx++;
        }
        if (transaction_kind) {
          conditions.push(`t.transaction_kind = $${idx}`);
          params.push(transaction_kind);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx++;
        params.push(offset);
        const offsetIdx = idx++;

        const result = await query(`
          SELECT
            t.id, t.type, t.scope, t.amount, t.description,
            t.date, t.is_paid, t.transaction_kind,
            t.group_id, t.installment_index, t.installment_total, t.frequency,
            t.created_at, t.updated_at,
            c.name AS category_name, c.color AS category_color
          FROM transactions t
          LEFT JOIN categories c ON t.category_id = c.id
          ${where}
          ORDER BY t.date DESC, t.created_at DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `, params);

        const countResult = await query(`
          SELECT COUNT(*) AS total FROM transactions t ${where}
        `, params.slice(0, -2));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total: parseInt(countResult.rows[0].total, 10),
              rows: result.rows,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 6. create_transaction - Create a new transaction
  server.registerTool(
    'create_transaction',
    {
      title: 'Create Transaction',
      description: 'Create a financial transaction. For installments (parcelamento), provide installment_total to auto-generate all installments with a shared group_id.',
      inputSchema: {
        type: z.enum(['receita', 'despesa']).describe('Transaction type'),
        scope: z.enum(['pessoal', 'empresa']).describe('Scope'),
        amount: z.number().describe('Amount in cents (integer)'),
        description: z.string().describe('Transaction description'),
        category_id: z.string().uuid().describe('Category UUID'),
        date: z.string().describe('Transaction date (YYYY-MM-DD)'),
        is_paid: z.boolean().optional().default(true).describe('Payment status (default: true)'),
        transaction_kind: z.enum(['unica', 'parcelamento', 'recorrente']).optional().default('unica').describe('Transaction kind'),
        installment_total: z.number().optional().describe('Number of installments (for parcelamento)'),
        frequency: z.enum(['mensal', 'semanal', 'anual']).optional().describe('Frequency (for recorrente or parcelamento)'),
      },
    },
    async ({ type, scope, amount, description, category_id, date, is_paid, transaction_kind, installment_total, frequency }) => {
      try {
        if (transaction_kind === 'parcelamento' && installment_total && installment_total > 1) {
          // Generate all installments with a shared group_id
          const groupResult = await query(`SELECT gen_random_uuid() AS group_id`);
          const groupId = groupResult.rows[0].group_id;
          const freq = frequency || 'mensal';

          const values: string[] = [];
          const params: unknown[] = [];
          let idx = 1;

          for (let i = 0; i < installment_total; i++) {
            const intervalExpr = freq === 'mensal' ? `${i} months` : freq === 'semanal' ? `${i * 7} days` : `${i} years`;
            values.push(
              `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}::date + interval '${intervalExpr}', $${idx + 6}, 'parcelamento', $${idx + 7}, ${i + 1}, $${idx + 8}, $${idx + 9})`
            );
            params.push(type, scope, amount, description, category_id, date, is_paid, groupId, installment_total, freq);
            idx += 10;
          }

          const result = await query(
            `INSERT INTO transactions (type, scope, amount, description, category_id, date, is_paid, transaction_kind, group_id, installment_index, installment_total, frequency)
             VALUES ${values.join(', ')}
             RETURNING *`,
            params
          );

          return { content: [{ type: 'text', text: JSON.stringify({ installments_created: result.rowCount, rows: result.rows }, null, 2) }] };
        }

        // Single or recurring transaction
        const result = await query(
          `INSERT INTO transactions (type, scope, amount, description, category_id, date, is_paid, transaction_kind, frequency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [type, scope, amount, description, category_id, date, is_paid, transaction_kind, frequency || null]
        );

        return { content: [{ type: 'text', text: JSON.stringify(result.rows[0], null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 7. update_transaction - Update a transaction
  server.registerTool(
    'update_transaction',
    {
      title: 'Update Transaction',
      description: 'Update an existing transaction by ID.',
      inputSchema: {
        id: z.string().uuid().describe('Transaction UUID'),
        type: z.enum(['receita', 'despesa']).optional().describe('New type'),
        scope: z.enum(['pessoal', 'empresa']).optional().describe('New scope'),
        amount: z.number().optional().describe('New amount in cents'),
        description: z.string().optional().describe('New description'),
        category_id: z.string().uuid().optional().describe('New category UUID'),
        date: z.string().optional().describe('New date (YYYY-MM-DD)'),
        is_paid: z.boolean().optional().describe('Payment status'),
      },
    },
    async ({ id, type, scope, amount, description, category_id, date, is_paid }) => {
      try {
        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (type !== undefined) { sets.push(`type = $${idx}`); params.push(type); idx++; }
        if (scope !== undefined) { sets.push(`scope = $${idx}`); params.push(scope); idx++; }
        if (amount !== undefined) { sets.push(`amount = $${idx}`); params.push(amount); idx++; }
        if (description !== undefined) { sets.push(`description = $${idx}`); params.push(description); idx++; }
        if (category_id !== undefined) { sets.push(`category_id = $${idx}`); params.push(category_id); idx++; }
        if (date !== undefined) { sets.push(`date = $${idx}`); params.push(date); idx++; }
        if (is_paid !== undefined) { sets.push(`is_paid = $${idx}`); params.push(is_paid); idx++; }

        if (sets.length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update.' }] };
        }

        sets.push(`updated_at = now()`);
        params.push(id);
        const result = await query(
          `UPDATE transactions SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
          params
        );

        if (result.rowCount === 0) {
          return { content: [{ type: 'text', text: `Transaction ${id} not found.` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.rows[0], null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 8. delete_transaction - Delete transaction(s)
  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete Transaction',
      description: 'Delete a transaction by ID. Optionally delete all installments in the same group.',
      inputSchema: {
        id: z.string().uuid().describe('Transaction UUID to delete'),
        delete_group: z.boolean().optional().default(false).describe('Delete all installments in the same group'),
      },
    },
    async ({ id, delete_group }) => {
      try {
        if (delete_group) {
          const tx = await query(`SELECT group_id FROM transactions WHERE id = $1`, [id]);
          if (tx.rowCount === 0) {
            return { content: [{ type: 'text', text: `Transaction ${id} not found.` }], isError: true };
          }
          const groupId = tx.rows[0].group_id;
          if (groupId) {
            const result = await query(`DELETE FROM transactions WHERE group_id = $1 RETURNING id`, [groupId]);
            return { content: [{ type: 'text', text: `Deleted ${result.rowCount} installment(s) from group ${groupId}.` }] };
          }
        }

        const result = await query(`DELETE FROM transactions WHERE id = $1 RETURNING description`, [id]);
        if (result.rowCount === 0) {
          return { content: [{ type: 'text', text: `Transaction ${id} not found.` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Transaction "${result.rows[0].description}" deleted.` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 9. financial_summary - Summary of income vs expenses
  server.registerTool(
    'financial_summary',
    {
      title: 'Financial Summary',
      description: 'Get financial summary: total income vs expenses, balance, grouped by category. Filter by date range and scope.',
      inputSchema: {
        date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
        scope: z.enum(['pessoal', 'empresa']).optional().describe('Filter by scope'),
        is_paid: z.boolean().optional().describe('Only paid/unpaid transactions'),
      },
    },
    async ({ date_from, date_to, scope, is_paid }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (date_from) { conditions.push(`t.date >= $${idx}`); params.push(date_from); idx++; }
        if (date_to) { conditions.push(`t.date <= $${idx}`); params.push(date_to); idx++; }
        if (scope) { conditions.push(`t.scope = $${idx}`); params.push(scope); idx++; }
        if (is_paid !== undefined) { conditions.push(`t.is_paid = $${idx}`); params.push(is_paid); idx++; }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [totals, byCategory] = await Promise.all([
          query(`
            SELECT
              COALESCE(SUM(CASE WHEN t.type = 'receita' THEN t.amount ELSE 0 END), 0) AS total_receitas,
              COALESCE(SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE 0 END), 0) AS total_despesas,
              COALESCE(SUM(CASE WHEN t.type = 'receita' THEN t.amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE 0 END), 0) AS saldo,
              COUNT(*) AS total_transactions
            FROM transactions t
            ${where}
          `, params),
          query(`
            SELECT
              c.name AS category, c.color, t.type,
              SUM(t.amount) AS total,
              COUNT(*) AS count
            FROM transactions t
            LEFT JOIN categories c ON t.category_id = c.id
            ${where}
            GROUP BY c.name, c.color, t.type
            ORDER BY total DESC
          `, params),
        ]);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: totals.rows[0],
              by_category: byCategory.rows,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 10. cashflow_report - Monthly cashflow
  server.registerTool(
    'cashflow_report',
    {
      title: 'Cashflow Report',
      description: 'Monthly cashflow report: income, expenses, and balance per month. Filter by scope and year.',
      inputSchema: {
        year: z.number().optional().describe('Filter by year (e.g., 2025). Defaults to current year.'),
        scope: z.enum(['pessoal', 'empresa']).optional().describe('Filter by scope'),
        is_paid: z.boolean().optional().describe('Only paid/unpaid transactions'),
      },
    },
    async ({ year, scope, is_paid }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (year) {
          conditions.push(`EXTRACT(YEAR FROM t.date) = $${idx}`);
          params.push(year);
          idx++;
        } else {
          conditions.push(`EXTRACT(YEAR FROM t.date) = EXTRACT(YEAR FROM CURRENT_DATE)`);
        }
        if (scope) { conditions.push(`t.scope = $${idx}`); params.push(scope); idx++; }
        if (is_paid !== undefined) { conditions.push(`t.is_paid = $${idx}`); params.push(is_paid); idx++; }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await query(`
          SELECT
            TO_CHAR(t.date, 'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN t.type = 'receita' THEN t.amount ELSE 0 END), 0) AS receitas,
            COALESCE(SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE 0 END), 0) AS despesas,
            COALESCE(SUM(CASE WHEN t.type = 'receita' THEN t.amount ELSE 0 END), 0) -
            COALESCE(SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE 0 END), 0) AS saldo,
            COUNT(*) AS transactions
          FROM transactions t
          ${where}
          GROUP BY TO_CHAR(t.date, 'YYYY-MM')
          ORDER BY month
        `, params);

        return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // 11. category_breakdown - Spending/income breakdown by category
  server.registerTool(
    'category_breakdown',
    {
      title: 'Category Breakdown',
      description: 'Breakdown of transactions by category for a period. Shows total, percentage, and count per category.',
      inputSchema: {
        type: z.enum(['receita', 'despesa']).optional().describe('Filter by type (default: despesa)'),
        date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
        scope: z.enum(['pessoal', 'empresa']).optional().describe('Filter by scope'),
        is_paid: z.boolean().optional().describe('Only paid/unpaid transactions'),
      },
    },
    async ({ type, date_from, date_to, scope, is_paid }) => {
      try {
        const txType = type || 'despesa';
        const conditions: string[] = [`t.type = $1`];
        const params: unknown[] = [txType];
        let idx = 2;

        if (date_from) { conditions.push(`t.date >= $${idx}`); params.push(date_from); idx++; }
        if (date_to) { conditions.push(`t.date <= $${idx}`); params.push(date_to); idx++; }
        if (scope) { conditions.push(`t.scope = $${idx}`); params.push(scope); idx++; }
        if (is_paid !== undefined) { conditions.push(`t.is_paid = $${idx}`); params.push(is_paid); idx++; }

        const where = `WHERE ${conditions.join(' AND ')}`;

        const result = await query(`
          SELECT
            c.name AS category, c.color,
            SUM(t.amount) AS total,
            COUNT(*) AS count,
            ROUND(SUM(t.amount)::numeric * 100.0 / NULLIF(SUM(SUM(t.amount)) OVER (), 0), 2) AS percentage
          FROM transactions t
          LEFT JOIN categories c ON t.category_id = c.id
          ${where}
          GROUP BY c.name, c.color
          ORDER BY total DESC
        `, params);

        const grandTotal = result.rows.reduce((sum: number, r: Record<string, unknown>) => sum + Number(r.total), 0);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              type: txType,
              grand_total: grandTotal,
              categories: result.rows,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
