const OpenAI = require('openai');
require('dotenv').config();

// Configuración del cliente OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Verifica la conexión con OpenAI API
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    await openai.models.list();
    console.log('✓ OpenAI API connection successful');
    return true;
  } catch (error) {
    console.error('✗ OpenAI API connection failed:', error.message);
    return false;
  }
}

module.exports = {
  openai,
  testConnection
};
