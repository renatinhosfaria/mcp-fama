import assert from 'node:assert/strict';
import test from 'node:test';

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/db';
  process.env.API_KEY = process.env.API_KEY ?? 'mcp-api-key';
}

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = originalFetch;
});

test('createFamachatAppointment posts to the FamaChat internal appointment endpoint', async () => {
  resetEnv();
  process.env.FAMACHAT_API_BASE_URL = 'https://famachat.example';
  process.env.FAMACHAT_INTERNAL_API_TOKEN = 'internal-token';

  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        success: true,
        appointment: { id: 235, clienteId: 11084 },
        postProcessing: { postProcessed: true },
      }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const { createFamachatAppointment } = await import(
    `../src/tools/domain/famachat-api.js?create=${Date.now()}`
  );

  const result = await createFamachatAppointment({
    cliente_id: 11084,
    broker_id: 35,
    user_id: 35,
    type: 'Visita',
    status: 'Agendado',
    scheduled_at: '2026-04-29T21:00:00.000Z',
    title: 'Visita presencial na Fama',
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://famachat.example/api/internal/appointments');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    'Bearer internal-token'
  );
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    clienteId: 11084,
    brokerId: 35,
    userId: 35,
    type: 'Visita',
    status: 'Agendado',
    scheduledAt: '2026-04-29T21:00:00.000Z',
    title: 'Visita presencial na Fama',
  });
});

test('regularizeFamachatAppointment posts to the regularize endpoint', async () => {
  resetEnv();
  process.env.FAMACHAT_API_BASE_URL = 'https://famachat.example/';
  process.env.FAMACHAT_INTERNAL_API_TOKEN = 'internal-token';

  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const { regularizeFamachatAppointment } = await import(
    `../src/tools/domain/famachat-api.js?regularize=${Date.now()}`
  );

  const result = await regularizeFamachatAppointment(235);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://famachat.example/api/internal/appointments/235/regularize');
  assert.equal(calls[0].init.method, 'POST');
});
