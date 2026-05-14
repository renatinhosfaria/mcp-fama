import { config } from '../../config.js';

export type FamachatAppointmentInput = {
  cliente_id: number;
  type: string;
  status: string;
  scheduled_at: string;
  title?: string;
  end_at?: string;
  broker_id?: number;
  user_id?: number;
  location?: string;
  address?: string;
  notes?: string;
};

function requireFamachatInternalConfig() {
  if (!config.famachatApiBaseUrl) {
    throw new Error('FAMACHAT_API_BASE_URL is required to call FamaChat internal endpoints.');
  }
  if (!config.famachatInternalApiToken) {
    throw new Error('FAMACHAT_INTERNAL_API_TOKEN is required to call FamaChat internal endpoints.');
  }
}

function buildInternalUrl(path: string): string {
  const baseUrl = config.famachatApiBaseUrl.endsWith('/')
    ? config.famachatApiBaseUrl
    : `${config.famachatApiBaseUrl}/`;
  return new URL(path.replace(/^\//, ''), baseUrl).toString();
}

async function postFamachatInternal(path: string, body: Record<string, unknown>) {
  requireFamachatInternalConfig();

  const response = await fetch(buildInternalUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.famachatInternalApiToken}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: unknown = text;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : text || response.statusText;
    throw new Error(`FamaChat internal API error ${response.status}: ${message}`);
  }

  return payload;
}

export async function createFamachatAppointment(input: FamachatAppointmentInput) {
  const body: Record<string, unknown> = {
    clienteId: input.cliente_id,
    brokerId: input.broker_id,
    userId: input.user_id,
    type: input.type,
    status: input.status,
    scheduledAt: input.scheduled_at,
    title: input.title,
    endAt: input.end_at,
    location: input.location,
    address: input.address,
    notes: input.notes,
  };

  for (const key of Object.keys(body)) {
    if (body[key] === undefined) {
      delete body[key];
    }
  }

  return await postFamachatInternal('/api/internal/appointments', body);
}

export async function regularizeFamachatAppointment(appointmentId: number) {
  return await postFamachatInternal(`/api/internal/appointments/${appointmentId}/regularize`, {});
}
