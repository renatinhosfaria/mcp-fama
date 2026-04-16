import { describe, it, expect, vi, beforeAll } from 'vitest';
import { authMiddleware } from '../../src/auth.js';
import { config } from '../../src/config.js';

function mkReq(headers: Record<string, string> = {}) {
  return { path: '/mcp', headers } as any;
}
function mkRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('authMiddleware', () => {
  beforeAll(() => { (config as any).apiKey = 'secret-token'; });

  it('rejects request without Authorization header', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware(mkReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects wrong token', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware(mkReq({ authorization: 'Bearer wrong' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
  it('passes valid token', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware(mkReq({ authorization: 'Bearer secret-token' }), res, next);
    expect(next).toHaveBeenCalled();
  });
  it('skips /health', () => {
    const next = vi.fn(); const res = mkRes();
    authMiddleware({ ...mkReq(), path: '/health' } as any, res, next);
    expect(next).toHaveBeenCalled();
  });
});
