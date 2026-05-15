import assert from 'node:assert/strict';
import test from 'node:test';

import { getClientDetails } from '../src/tools/domain/clientes.js';

test('getClientDetails runs client detail queries sequentially and limits history rows', async () => {
  let activeQueries = 0;
  let maxActiveQueries = 0;
  const sqlStatements: string[] = [];

  const result = await getClientDetails(11378, async (sql, params) => {
    activeQueries += 1;
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
    sqlStatements.push(sql);

    await Promise.resolve();
    activeQueries -= 1;

    assert.equal(params?.[0], 11378);

    if (sql.includes('FROM clientes c')) {
      return {
        rows: [{ id: 11378, full_name: 'Kersleen Antunes', broker_id: 35 }],
        rowCount: 1,
      };
    }

    if (sql.includes('COUNT(*)::int AS leads_count')) {
      return { rows: [{ leads_count: 1 }], rowCount: 1 };
    }

    if (!sql.includes('FROM clientes_id_anotacoes')) {
      assert.equal(params?.[1], 20);
    }
    return { rows: [], rowCount: 0 };
  });

  assert.equal(maxActiveQueries, 1);
  assert.equal(result?.client.id, 11378);
  assert.equal(result?.leads_count, 1);
  assert.equal(sqlStatements.length, 6);
  assert.equal(sqlStatements.filter((sql) => /LIMIT \$2/.test(sql)).length, 3);
});
