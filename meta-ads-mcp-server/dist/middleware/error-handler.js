export function errorHandler(err, req, res, _next) {
    const status = err.statusCode ?? err.status ?? 500;
    const requestId = req.requestId ?? 'unknown';
    console.error(`[ERROR] request_id=${requestId} ${err.message}`, err.stack);
    res.status(status).json({
        error: status === 413
            ? 'Payload excede o limite permitido.'
            : 'Internal server error',
    });
}
