/**
 * Convierte todos los valores undefined en un objeto a null
 * MySQL requiere null explícito, no undefined
 * @param {Object} obj - Objeto con posibles valores undefined
 * @returns {Object} - Objeto con undefined convertidos a null
 */
function convertUndefinedToNull(obj) {
  const result = {};

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      result[key] = obj[key] === undefined ? null : obj[key];
    }
  }

  return result;
}

/**
 * Valida que un objeto no contenga valores undefined
 * Útil para debugging
 * @param {Object} obj - Objeto a validar
 * @param {string} context - Contexto para el mensaje de error
 * @returns {Array} - Array de campos con undefined
 */
function findUndefinedFields(obj, context = '') {
  const undefinedFields = [];

  for (const key in obj) {
    if (obj.hasOwnProperty(key) && obj[key] === undefined) {
      undefinedFields.push(key);
    }
  }

  if (undefinedFields.length > 0) {
    console.warn(
      `⚠ Warning: Found undefined fields in ${context}:`,
      undefinedFields
    );
  }

  return undefinedFields;
}

/**
 * Valida y sanitiza un array de registros antes de insertar en BD
 * Convierte undefined a null y opcionalmente valida campos requeridos
 * @param {Array} records - Array de registros
 * @param {Array} requiredFields - Array de campos requeridos (opcional)
 * @returns {Array} - Array de registros sanitizados
 */
function sanitizeRecords(records, requiredFields = []) {
  return records.map((record, index) => {
    // Buscar campos undefined
    const undefinedFields = findUndefinedFields(record, `record ${index}`);

    // Convertir undefined a null
    const sanitized = convertUndefinedToNull(record);

    // Validar campos requeridos si se especifican
    if (requiredFields.length > 0) {
      const missingFields = requiredFields.filter(
        field => sanitized[field] === null || sanitized[field] === ''
      );

      if (missingFields.length > 0) {
        console.warn(
          `⚠ Warning: Record ${index} missing required fields:`,
          missingFields
        );
      }
    }

    return sanitized;
  });
}

module.exports = {
  convertUndefinedToNull,
  findUndefinedFields,
  sanitizeRecords
};
