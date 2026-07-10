export function errorHandler(err, _req, res, _next) {
    const status = err.statusCode ?? err.status ?? 500;
    console.error(`[ERROR] ${err.message}`, err.stack);
    res.status(status).json({
        error: status === 413
            ? 'Payload excede o limite permitido.'
            : 'Internal server error',
    });
}
