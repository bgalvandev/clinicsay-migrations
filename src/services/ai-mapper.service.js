const { openai } = require("../config/openai");

// Cache de mapeos en memoria (se mantiene durante la sesión)
const mapperCache = new Map();

/**
 * Genera una clave única para el cache
 * @param {string} entityType - Tipo de entidad (ej: 'tax', 'category')
 * @param {Object} apiResult - Resultado de la API
 * @param {Object} dbResult - Resultado de la BD
 * @returns {string} - Clave única para el cache
 */
function generateCacheKey(entityType, apiResult, dbResult) {
  const apiHash = JSON.stringify(apiResult.map((item) => item.id).sort());
  const dbHash = JSON.stringify(
    dbResult.map((item) => Object.values(item)[0]).sort()
  );
  return `${entityType}_${apiHash}_${dbHash}`;
}

/**
 * Mapea datos de API externa con datos de BD local usando IA
 * @param {string} entityType - Tipo de entidad para el mapeo
 * @param {Array} apiResult - Array de objetos de la API externa
 * @param {Array} dbResult - Array de objetos de la BD local
 * @param {Object} options - Opciones adicionales para el mapeo
 * @param {boolean} options.allowManyToOne - Permite mapeo many-to-one (varios API IDs a un BD ID)
 * @param {boolean} options.requireCompleteMapping - No permite elementos missing (default: false)
 * @param {Object} options.relatedMappings - Mapeos relacionados para construir elementos missing correctamente
 * @returns {Promise<Object>} - Objeto con mapper y missing
 */
async function mapData(entityType, apiResult, dbResult, options = {}) {
  const {
    allowManyToOne = false,
    requireCompleteMapping = false,
    relatedMappings = null,
  } = options;
  try {
    // Verificar cache
    const cacheKey = generateCacheKey(entityType, apiResult, dbResult);
    if (mapperCache.has(cacheKey)) {
      console.log(`✓ Using cached mapping for ${entityType}`);
      return mapperCache.get(cacheKey);
    }

    console.log(`→ Requesting AI mapping for ${entityType}...`);

    // Construir el prompt para OpenAI
    const systemPrompt = `Eres un experto en mapeo de datos. Tu tarea es establecer correspondencias entre datos de una API externa y una base de datos local.

REGLAS IMPORTANTES:
1. Analiza ambos conjuntos de datos y crea un mapeo que relacione los elementos de la API con los elementos de la BD
2. Busca similitudes en nombres, valores numéricos, códigos, descripciones o cualquier otro campo disponible, primero intenta encontrar la coincidencia exacta, si no hay entonces busca similitudes lógicas.
3. Para valores numéricos, considera posibles conversiones (ej: porcentajes como 21.0 pueden ser 0.21 en BD, o viceversa)
4. Devuelve SOLO un objeto JSON válido sin texto adicional, sin markdown, sin explicaciones
5. El formato debe ser exactamente: {"mapper": {...}, "missing": [...]}
6. En "mapper": las claves son los IDs principales de la API (como string) y los valores son los IDs principales de la BD (como number)
8. En "mapper": deben estar obligatoriamente TODOS los elementos de la API con su respectivo ID de la BD.
9. En "missing": incluye elementos de la API que NO tienen correspondencia en la BD. IMPORTANTE: usa la ESTRUCTURA EXACTA de dbResult
10. En "missing": solo si contiene los campos id_clinica y id_super_clinica que usen los mismos valores que se repiten en dbResult (ojo solo para estos dos campos, para los demás según criterio).
11. Si hay error en el análisis, devuelve: {"error": "ERROR_CODE", "message": "descripción"}

EJEMPLOS DE MAPEO:

Ejemplo 1 - Impuestos/IVA:
API: {"value": 1, "text": 21.0} → BD: {"id_tipo_iva": 1, "valor": "0.21"} → Mapper: "1": 1
API: {"value": 10, "text": 3.0} sin match → Missing: {"descripcion": "Iva 3%", "valor": "0.03"}

Ejemplo 2 - Categorías:
API: {"id": 5, "name": "Electronics"} → BD: {"id_categoria": 12, "nombre": "Electrónica"} → Mapper: "5": 12
API: {"id": 8, "name": "Toys"} sin match → Missing: {"nombre": "Juguetes"}

Ejemplo 3 - Productos:
API: {"product_id": 100, "sku": "ABC123"} → BD: {"id_producto": 50, "codigo": "ABC123"} → Mapper: "100": 50`;

    // Construir instrucciones específicas basadas en opciones
    let specialInstructions = "";

    if (allowManyToOne) {
      specialInstructions += `\n\n⚠️ MAPEO MANY-TO-ONE PERMITIDO:
- PUEDES mapear múltiples IDs de la API al MISMO ID de la BD si tienen entidad semántica similar
- Ejemplo: {"1": 2, "5": 2, "7": 2} - Tres estados API pueden mapear al estado BD "2"
- El objetivo es que TODOS los elementos de la API tengan correspondencia`;
    }

    if (requireCompleteMapping) {
      specialInstructions += `\n\n⚠️ MAPEO COMPLETO REQUERIDO:
- NO debe haber elementos en "missing"
- TODOS los elementos de la API deben tener correspondencia en la BD
- Si es necesario, mapea múltiples elementos API a un mismo elemento BD basándote en similitud semántica`;
    }

    if (relatedMappings) {
      specialInstructions += `\n\n⚠️ MAPEOS RELACIONADOS DISPONIBLES:
Para construir correctamente los elementos en "missing", usa estos mapeos relacionados:
${JSON.stringify(relatedMappings, null, 2)}

Cuando necesites un campo que hace referencia a otra entidad (ej: id_tipo_iva, id_categoria, etc.):
1. Busca el ID correspondiente en el objeto de la API
2. Usa el mapper relacionado para obtener el ID de la BD
3. Incluye ese ID de BD en el objeto "missing"

Ejemplo: Si apiItem tiene {impuesto: 1} y relatedMappings.taxMapper = {"1": 5}, entonces missing debe tener {id_tipo_iva: 5}`;
    }

    const userPrompt = `Necesito mapear ${entityType} entre estos dos conjuntos de datos:

**Datos de la API externa:**
${JSON.stringify(apiResult, null, 2)}

**Datos de la Base de Datos local:**
${JSON.stringify(dbResult, null, 2)}

INSTRUCCIONES:
1. Identifica el campo ID principal en cada conjunto de datos (generalmente el primer campo o campos como "id", "value", "id_*")
2. Busca correspondencias basándote en TODOS los campos disponibles (nombres, valores, códigos, etc.)
3. Si encuentras valores numéricos similares pero en diferentes escalas, considera conversiones (ej: 21.0 ↔ 0.21)
4. Para "missing": usa EXACTAMENTE la estructura de dbResult (copia los nombres de campos del segundo conjunto)
5. No incluyas campos de ID en "missing", solo los datos descriptivos necesarios para crear el registro${specialInstructions}

Responde ÚNICAMENTE con el objeto JSON (sin \`\`\`json, sin markdown, sin explicaciones):
{
  "mapper": {
    "id_api_string": id_bd_number
  },
  "missing": [
    // objetos con estructura EXACTA de dbResult
  ]
}`;

    // Llamar a OpenAI API
    const response = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parsear respuesta
    const content = response.choices[0].message.content.trim();
    console.log("  - AI raw response:", content);

    // Extraer JSON del contenido (por si viene con markdown)
    let jsonContent = content;
    if (content.includes("```json")) {
      jsonContent = content.match(/```json\s*([\s\S]*?)\s*```/)[1];
    } else if (content.includes("```")) {
      jsonContent = content.match(/```\s*([\s\S]*?)\s*```/)[1];
    }

    const result = JSON.parse(jsonContent);
    console.log("  - AI parsed result:", JSON.stringify(result, null, 2));

    // Validar estructura de respuesta
    if (result.error) {
      console.error(`✗ AI mapping error for ${entityType}:`, result.message);
      return result;
    }

    if (!result.mapper || typeof result.mapper !== "object") {
      throw new Error("Invalid mapper structure in AI response");
    }

    if (!Array.isArray(result.missing)) {
      throw new Error("Invalid missing structure in AI response");
    }

    // Guardar en cache
    mapperCache.set(cacheKey, result);
    console.log(`✓ AI mapping successful for ${entityType}`);
    console.log(`  - Mapped: ${Object.keys(result.mapper).length} items`);
    console.log(`  - Missing: ${result.missing.length} items`);

    return result;
  } catch (error) {
    console.error(`✗ AI mapping failed for ${entityType}:`, error.message);

    // Retornar error estructurado
    return {
      error: "AI_MAPPING_ERROR",
      message: error.message,
      details: error.response?.data || error,
    };
  }
}

/**
 * Limpia el cache de mapeos (útil para testing o cuando se actualizan datos)
 * @param {string} entityType - Tipo de entidad específica, o null para limpiar todo
 */
function clearCache(entityType = null) {
  if (entityType) {
    // Limpiar solo mapeos de un tipo específico
    for (const [key, value] of mapperCache.entries()) {
      if (key.startsWith(entityType + "_")) {
        mapperCache.delete(key);
      }
    }
    console.log(`✓ Cache cleared for ${entityType}`);
  } else {
    // Limpiar todo el cache
    mapperCache.clear();
    console.log("✓ All cache cleared");
  }
}

/**
 * Obtiene estadísticas del cache
 * @returns {Object} - Estadísticas del cache
 */
function getCacheStats() {
  return {
    size: mapperCache.size,
    keys: Array.from(mapperCache.keys()),
  };
}

module.exports = {
  mapData,
  clearCache,
  getCacheStats,
};
