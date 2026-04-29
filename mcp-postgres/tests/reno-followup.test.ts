import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRenoFailedNoteText,
  buildRenoFollowupMessage,
  buildRenoSentNoteText,
  formatRenoTimestamp,
  getRenoFollowupStateFromMeta,
  setJsonBranch,
} from '../src/tools/domain/reno-followup.js';

test('setJsonBranch updates only the requested branch and preserves siblings', () => {
  const updated = setJsonBranch(
    {
      source: { lead_id: 'abc' },
      reno_followup: {
        resgate: { step: 2, enabled: true },
      },
    },
    ['reno_followup', 'repescagem'],
    { step: 1, enabled: true }
  );

  assert.deepEqual(updated, {
    source: { lead_id: 'abc' },
    reno_followup: {
      resgate: { step: 2, enabled: true },
      repescagem: { step: 1, enabled: true },
    },
  });
});

test('setJsonBranch rejects unsafe json paths', () => {
  assert.throws(
    () => setJsonBranch({}, ['reno_followup', ''], { enabled: true }),
    /Invalid meta_data path/
  );
  assert.throws(
    () => setJsonBranch({}, ['reno.followup'], { enabled: true }),
    /Invalid meta_data path/
  );
});

test('getRenoFollowupStateFromMeta returns nullable repescagem and resgate branches', () => {
  const state = getRenoFollowupStateFromMeta({
    reno_followup: {
      repescagem: { step: 1, enabled: true },
    },
  });

  assert.deepEqual(state, {
    repescagem: { step: 1, enabled: true },
    resgate: null,
  });
});

test('buildRenoFollowupMessage creates the repescagem step 1 text with first name', () => {
  assert.equal(
    buildRenoFollowupMessage({
      flow: 'repescagem',
      fullName: 'Lenira Cruz',
      step: 1,
    }),
    'Oi, Lenira. Ainda faz sentido eu te ajudar com a busca do imóvel?'
  );
});

test('buildRenoFollowupMessage creates bucket-specific resgate texts', () => {
  assert.equal(
    buildRenoFollowupMessage({
      flow: 'resgate',
      fullName: 'Eduarda',
      step: 1,
      lastContextBucket: 'financiamento_sumiu',
    }),
    'Eduarda, sobre financiamento, o mais importante é ver se a compra fica viável antes de escolher imóvel. Quer que eu te ajude por esse caminho?'
  );

  assert.equal(
    buildRenoFollowupMessage({
      flow: 'resgate',
      fullName: 'Claudia Rosangela',
      step: 1,
      lastContextBucket: 'visita_nao_marcada',
    }),
    'Acho que para você entender melhor, vale ver isso pessoalmente aqui na Fama. Quer que eu veja um horário simples para você passar aqui?'
  );
});

test('buildRenoSentNoteText records flow, step, bucket, message, and next run', () => {
  assert.equal(
    buildRenoSentNoteText({
      flow: 'resgate',
      step: 1,
      message: 'Mensagem enviada',
      nextRunAt: '2026-04-30T14:00:38-03:00',
      lastContextBucket: 'financiamento_sumiu',
    }),
    'Reno enviou follow-up de resgate step 1 via WhatsApp. Bucket: financiamento_sumiu. Mensagem: "Mensagem enviada". Próximo follow-up previsto para 2026-04-30T14:00:38-03:00.'
  );
});

test('buildRenoFailedNoteText records terminal whatsapp failure without changing status', () => {
  assert.equal(
    buildRenoFailedNoteText({
      flow: 'repescagem',
      errorSummary: 'WhatsApp não enviado após tentativa com e sem nono dígito',
      stoppedReason: 'whatsapp_failed',
    }),
    'Reno follow-up de repescagem parado. Motivo: whatsapp_failed. Erro: WhatsApp não enviado após tentativa com e sem nono dígito. Status preservado.'
  );
});

test('formatRenoTimestamp returns timestamps in America/Sao_Paulo offset', () => {
  assert.equal(
    formatRenoTimestamp(new Date('2026-04-30T16:42:43.198Z')),
    '2026-04-30T13:42:43-03:00'
  );
});
