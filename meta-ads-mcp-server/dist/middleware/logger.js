import { randomUUID } from 'node:crypto';
function resolveRequestId(req) {
    const candidate = req.get('x-request-id')?.trim();
    return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
        ? candidate
        : randomUUID();
}
export function loggerMiddleware(req, res, next) {
    const start = Date.now();
    const { method, path, ip } = req;
    const requestId = resolveRequestId(req);
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        console.log(`[${new Date().toISOString()}] request_id=${requestId} ${method} ${path} ${status} ${duration}ms - ${ip}`);
    });
    next();
}
