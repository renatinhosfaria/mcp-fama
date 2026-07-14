import { createServer } from 'node:http';
export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 95_000;
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 100_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
export function createConfiguredHttpServer(app, options = {}) {
    const server = createServer(app);
    server.keepAliveTimeout = options.keepAliveTimeoutMs ?? DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = options.headersTimeoutMs ?? DEFAULT_HTTP_HEADERS_TIMEOUT_MS;
    return server;
}
export async function shutdownHttpServer(server, runtime, graceMs = DEFAULT_SHUTDOWN_GRACE_MS) {
    const closed = new Promise((resolve, reject) => {
        server.close((error) => {
            const code = error?.code;
            if (error && code !== 'ERR_SERVER_NOT_RUNNING') {
                reject(error);
                return;
            }
            resolve();
        });
    });
    let forceTimer;
    const graceElapsed = new Promise((resolve) => {
        forceTimer = setTimeout(() => {
            server.closeAllConnections();
            resolve();
        }, graceMs);
    });
    const cleanup = Promise.resolve().then(() => runtime.close());
    try {
        await Promise.race([
            Promise.all([cleanup, closed]).then(() => undefined),
            graceElapsed,
        ]);
    }
    finally {
        if (forceTimer)
            clearTimeout(forceTimer);
    }
}
