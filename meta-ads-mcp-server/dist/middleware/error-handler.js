export function errorHandler(err, _req, res, _next) {
    console.error(`[ERROR] ${err.message}`, err.stack);
    res.status(500).json({ error: 'Internal server error' });
}
