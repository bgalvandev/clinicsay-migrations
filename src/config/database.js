const mysql = require('mysql2/promise');
require('dotenv').config();

// Pool de conexiones MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

/**
 * Ejecuta una query con manejo de errores
 * @param {string} sql - Query SQL
 * @param {Array} params - Parámetros de la query
 * @returns {Promise} - Resultado de la query
 */
async function query(sql, params = []) {
  try {
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

/**
 * Obtiene una conexión del pool para transacciones
 * @returns {Promise} - Conexión de base de datos
 */
async function getConnection() {
  try {
    return await pool.getConnection();
  } catch (error) {
    console.error('Database connection error:', error);
    throw error;
  }
}

/**
 * Ejecuta una transacción
 * @param {Function} callback - Función con las operaciones de la transacción
 * @returns {Promise} - Resultado de la transacción
 */
async function transaction(callback) {
  const connection = await getConnection();

  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    console.error('Transaction error:', error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Verifica la conexión a la base de datos
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✓ Database connection successful');
    connection.release();
    return true;
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    return false;
  }
}

module.exports = {
  pool,
  query,
  getConnection,
  transaction,
  testConnection
};
