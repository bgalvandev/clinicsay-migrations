/**
 * Middleware para manejo de errores globales
 * @param {Error} err - Error
 * @param {Object} req - Request
 * @param {Object} res - Response
 * @param {Function} next - Next middleware
 */
function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // Error de sintaxis JSON
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_JSON',
      message: 'Invalid JSON in request body'
    });
  }

  // Error de base de datos
  if (err.code && err.code.startsWith('ER_')) {
    return res.status(500).json({
      success: false,
      error: 'DATABASE_ERROR',
      message: 'Database error occurred',
      code: err.code,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }

  // Error de axios (API externa)
  if (err.isAxiosError) {
    return res.status(err.response?.status || 500).json({
      success: false,
      error: 'EXTERNAL_API_ERROR',
      message: 'Error calling external API',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }

  // Error genérico
  return res.status(err.status || 500).json({
    success: false,
    error: err.name || 'INTERNAL_SERVER_ERROR',
    message: err.message || 'An unexpected error occurred',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
}

/**
 * Middleware para rutas no encontradas
 * @param {Object} req - Request
 * @param {Object} res - Response
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} not found`
  });
}

module.exports = {
  errorHandler,
  notFoundHandler
};
