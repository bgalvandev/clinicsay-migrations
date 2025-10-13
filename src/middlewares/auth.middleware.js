/**
 * Middleware para validar Bearer Token en headers
 * @param {Object} req - Request
 * @param {Object} res - Response
 * @param {Function} next - Next middleware
 */
function validateBearerToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'MISSING_AUTHORIZATION',
        message: 'Authorization header is required'
      });
    }

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_AUTHORIZATION_FORMAT',
        message: 'Authorization must be Bearer token'
      });
    }

    const token = authHeader.substring(7);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'MISSING_TOKEN',
        message: 'Bearer token is empty'
      });
    }

    // Guardar el token en el request para uso posterior
    req.bearerToken = token;

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'AUTH_ERROR',
      message: error.message
    });
  }
}

/**
 * Middleware para validar datos de clínica en el body
 * @param {Object} req - Request
 * @param {Object} res - Response
 * @param {Function} next - Next middleware
 */
function validateClinicData(req, res, next) {
  try {
    const { clinic } = req.body;

    if (!clinic) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_CLINIC_DATA',
        message: 'clinic object is required in request body'
      });
    }

    if (!clinic.id_clinica || !clinic.id_super_clinica) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_CLINIC_DATA',
        message: 'clinic.id_clinica and clinic.id_super_clinica are required'
      });
    }

    // Validar que sean números
    if (typeof clinic.id_clinica !== 'number' || typeof clinic.id_super_clinica !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_CLINIC_DATA_TYPE',
        message: 'clinic IDs must be numbers'
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: error.message
    });
  }
}

module.exports = {
  validateBearerToken,
  validateClinicData
};
