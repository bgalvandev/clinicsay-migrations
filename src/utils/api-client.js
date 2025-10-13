const axios = require('axios');

/**
 * Crea un cliente HTTP configurado para una API específica
 * @param {string} baseURL - URL base de la API
 * @param {Object} defaultHeaders - Headers por defecto
 * @param {number} timeout - Timeout en milisegundos
 * @returns {Object} - Cliente axios configurado
 */
function createApiClient(baseURL, defaultHeaders = {}, timeout = 30000) {
  const client = axios.create({
    baseURL,
    timeout,
    headers: {
      'Content-Type': 'application/json',
      ...defaultHeaders
    }
  });

  // Interceptor para logging de requests
  client.interceptors.request.use(
    (config) => {
      console.log(`→ ${config.method.toUpperCase()} ${config.baseURL}${config.url}`);
      return config;
    },
    (error) => {
      console.error('✗ Request error:', error.message);
      return Promise.reject(error);
    }
  );

  // Interceptor para logging de responses
  client.interceptors.response.use(
    (response) => {
      console.log(`✓ ${response.status} ${response.config.url}`);
      return response;
    },
    (error) => {
      if (error.response) {
        console.error(`✗ ${error.response.status} ${error.config.url}:`, error.response.data);
      } else {
        console.error('✗ Response error:', error.message);
      }
      return Promise.reject(error);
    }
  );

  return client;
}

/**
 * Realiza una petición GET con manejo de errores
 * @param {Object} client - Cliente axios
 * @param {string} endpoint - Endpoint a consultar
 * @param {Object} params - Parámetros de query
 * @returns {Promise<Object>} - Datos de la respuesta
 */
async function get(client, endpoint, params = {}) {
  try {
    const response = await client.get(endpoint, { params });
    return {
      success: true,
      data: response.data,
      status: response.status
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    };
  }
}

/**
 * Realiza una petición POST con manejo de errores
 * @param {Object} client - Cliente axios
 * @param {string} endpoint - Endpoint a consultar
 * @param {Object} data - Datos a enviar
 * @returns {Promise<Object>} - Datos de la respuesta
 */
async function post(client, endpoint, data = {}) {
  try {
    const response = await client.post(endpoint, data);
    return {
      success: true,
      data: response.data,
      status: response.status
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    };
  }
}

/**
 * Obtiene todos los datos paginados de un endpoint
 * @param {Object} client - Cliente axios
 * @param {string} endpoint - Endpoint a consultar
 * @param {number} limit - Límite por página
 * @param {string} offsetParam - Nombre del parámetro de offset (default: 'offset')
 * @returns {Promise<Object>} - Todos los datos paginados
 */
async function getAllPaginated(client, endpoint, limit = 100, offsetParam = 'offset') {
  try {
    const allResults = [];
    let offset = 0;
    let hasMore = true;

    // Primera petición para obtener el total
    const firstResponse = await get(client, endpoint, { [offsetParam]: 0 });

    if (!firstResponse.success) {
      return {
        success: false,
        error: firstResponse.error,
        data: []
      };
    }

    const totalCount = firstResponse.data.count;
    allResults.push(...firstResponse.data.results);

    console.log(`→ Total records: ${totalCount}, fetching in batches of ${limit}...`);

    // Calcular páginas restantes
    const totalPages = Math.ceil(totalCount / limit);

    // Obtener páginas restantes
    for (let page = 1; page < totalPages; page++) {
      offset = page * limit;

      const response = await get(client, endpoint, { [offsetParam]: offset });

      if (!response.success) {
        console.warn(`⚠ Failed to fetch page ${page + 1}/${totalPages}, skipping...`);
        continue;
      }

      allResults.push(...response.data.results);
      console.log(`  → Page ${page + 1}/${totalPages} fetched (${response.data.results.length} records)`);
    }

    console.log(`✓ All pages fetched: ${allResults.length}/${totalCount} records`);

    return {
      success: true,
      data: allResults,
      totalCount,
      fetchedCount: allResults.length
    };

  } catch (error) {
    console.error('✗ Error fetching paginated data:', error.message);
    return {
      success: false,
      error: error.message,
      data: []
    };
  }
}

/**
 * Procesa datos paginados en lotes (sin cargar todo en memoria)
 * @param {Object} client - Cliente axios
 * @param {string} endpoint - Endpoint a consultar
 * @param {Function} processFn - Función para procesar cada lote
 * @param {number} limit - Límite por página
 * @returns {Promise<Object>} - Resultado del procesamiento
 */
async function processPaginatedInBatches(client, endpoint, processFn, limit = 100) {
  try {
    // Primera petición para obtener el total
    const firstResponse = await get(client, endpoint, { offset: 0 });

    if (!firstResponse.success) {
      return {
        success: false,
        error: firstResponse.error
      };
    }

    const totalCount = firstResponse.data.count;
    const totalPages = Math.ceil(totalCount / limit);

    console.log(`→ Processing ${totalCount} records in ${totalPages} batches...`);

    // Procesar primera página
    await processFn(firstResponse.data.results, 0, totalPages);

    // Procesar páginas restantes
    for (let page = 1; page < totalPages; page++) {
      const offset = page * limit;
      const response = await get(client, endpoint, { offset });

      if (!response.success) {
        console.warn(`⚠ Failed to fetch page ${page + 1}/${totalPages}, skipping...`);
        continue;
      }

      await processFn(response.data.results, page, totalPages);
    }

    console.log(`✓ All batches processed`);

    return {
      success: true,
      totalPages,
      totalRecords: totalCount
    };

  } catch (error) {
    console.error('✗ Error processing paginated data:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  createApiClient,
  get,
  post,
  getAllPaginated,
  processPaginatedInBatches
};
