const { transaction } = require('../config/database');
const { sanitizeRecords } = require('../utils/validators');

/**
 * Inserta un lote de registros en una tabla usando transacciones
 * @param {string} tableName - Nombre de la tabla
 * @param {Array} records - Array de objetos con los registros a insertar
 * @param {number} batchNumber - Número del lote (para logging)
 * @returns {Promise<Object>} - Resultado de la inserción
 */
async function insertBatch(tableName, records, batchNumber = 1) {
  if (!records || records.length === 0) {
    return {
      success: true,
      inserted: 0,
      message: 'No records to insert'
    };
  }

  try {
    // Sanitizar registros: convertir undefined a null
    const sanitizedRecords = sanitizeRecords(records);

    // Obtener las columnas del primer registro
    const columns = Object.keys(sanitizedRecords[0]);

    // Crear placeholders para los valores
    const placeholders = sanitizedRecords.map(() =>
      `(${columns.map(() => '?').join(', ')})`
    ).join(', ');

    // Crear array de valores aplanado
    const values = sanitizedRecords.flatMap(record =>
      columns.map(col => record[col])
    );

    // Construir query
    const query = `
      INSERT INTO ${tableName}
      (${columns.join(', ')})
      VALUES ${placeholders}
    `;

    // Ejecutar transacción
    await transaction(async (connection) => {
      await connection.execute(query, values);
    });

    console.log(`✓ Batch ${batchNumber} completed: ${sanitizedRecords.length} records inserted into ${tableName}`);

    return {
      success: true,
      inserted: sanitizedRecords.length,
      batch: batchNumber
    };

  } catch (error) {
    console.error(`✗ Batch ${batchNumber} failed:`, error.message);

    return {
      success: false,
      inserted: 0,
      batch: batchNumber,
      error: error.message,
      code: error.code
    };
  }
}

/**
 * Procesa datos en lotes con control de errores
 * @param {string} tableName - Nombre de la tabla
 * @param {Array} allRecords - Array completo de registros a insertar
 * @param {number} batchSize - Tamaño de cada lote (default: 100)
 * @param {Function} onBatchComplete - Callback después de cada lote
 * @returns {Promise<Object>} - Estadísticas del procesamiento
 */
async function processBatches(tableName, allRecords, batchSize = 100, onBatchComplete = null) {
  const totalRecords = allRecords.length;
  const totalBatches = Math.ceil(totalRecords / batchSize);

  const stats = {
    totalRecords,
    totalBatches,
    successfulBatches: 0,
    failedBatches: 0,
    insertedRecords: 0,
    errors: []
  };

  console.log(`→ Starting batch processing: ${totalRecords} records in ${totalBatches} batches`);

  for (let i = 0; i < totalBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, totalRecords);
    const batch = allRecords.slice(start, end);

    const result = await insertBatch(tableName, batch, i + 1);

    if (result.success) {
      stats.successfulBatches++;
      stats.insertedRecords += result.inserted;
    } else {
      stats.failedBatches++;
      stats.errors.push({
        batch: i + 1,
        offset: start,
        error: result.error,
        code: result.code
      });
    }

    // Callback después de cada lote
    if (onBatchComplete && typeof onBatchComplete === 'function') {
      await onBatchComplete(result, i + 1, totalBatches);
    }
  }

  console.log(`✓ Batch processing completed: ${stats.insertedRecords}/${totalRecords} records inserted`);

  if (stats.failedBatches > 0) {
    console.warn(`⚠ ${stats.failedBatches} batches failed`);
  }

  return stats;
}

/**
 * Divide un array en chunks de tamaño específico
 * @param {Array} array - Array a dividir
 * @param {number} size - Tamaño de cada chunk
 * @returns {Array} - Array de chunks
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  insertBatch,
  processBatches,
  chunkArray
};
