const { openai } = require("../config/openai");

/**
 * Transforma una encuesta de Koibox al formato de anamnesis usando IA
 * La IA analizará la estructura completa y decidirá:
 * - Qué tipo de pregunta es cada una (1: texto, 2: selección única, 3: selección múltiple)
 * - Cómo estructurar las opciones
 * - Cómo agrupar las preguntas en categorías
 *
 * @param {Object} koiboxSurvey - Encuesta completa de Koibox
 * @param {number} id_clinica - ID de la clínica
 * @param {number} id_super_clinica - ID de la super clínica
 * @returns {Promise<Object>} - Estructura transformada para insertar en BD
 */
async function transformSurveyWithAI(
  koiboxSurvey,
  id_clinica,
  id_super_clinica
) {
  try {
    console.log(`  → Using AI to transform survey "${koiboxSurvey.nombre}"...`);

    const systemPrompt = `Eres un experto en migración de datos de encuestas médicas. Tu tarea es transformar encuestas del sistema Koibox al formato de anamnesis de ClinicSay.

INFORMACIÓN IMPORTANTE SOBRE TIPOS DE PREGUNTAS:

En ClinicSay existen 3 tipos de preguntas (tabla anamnesis_tipo_preguntas):
1. Campo de texto (id: 1, icon: "fa-solid fa-bars text-lg")
   - Para respuestas libres, textos, números, fechas
   - Ejemplos: "Edad", "Peso", "Altura", "Comentarios", "Diagnóstico"

2. Selección única (id: 2, icon: "fa-regular fa-circle text-lg")
   - Para elegir UNA opción entre varias (radio buttons)
   - Ejemplos: "¿Ejercicio? Sí/No", "Nivel de satisfacción: Muy bueno/Bueno/Regular/Malo"

3. Selección múltiple (id: 3, icon: "fa-regular fa-square text-lg")
   - Para elegir MÚLTIPLES opciones (checkboxes)
   - Ejemplos: "Alergias: Polen/Polvo/Medicamentos", "Síntomas: Dolor/Fiebre/Náuseas"

EN KOIBOX, los tipos son:
- tipo 1: Generalmente selección única con opciones predefinidas
- tipo 4: Campo de texto libre (textarea)
- Otros tipos pueden existir

ESTRUCTURA DE RESPUESTA REQUERIDA:

Debes devolver un objeto JSON con esta estructura EXACTA:

{
  "anamnesis_hoja": {
    "nombre": "Nombre de la encuesta",
    "publico_objetivo": null o string con el público objetivo
  },
  "categorias": [
    {
      "nombre": "Nombre de la categoría",
      "orden": 0,
      "preguntas": [
        {
          "texto": "Texto de la pregunta",
          "id_tipo_pregunta": 1 o 2 o 3,
          "opciones": {} o {"opcion1": "Sí", "opcion2": "No"},
          "koibox_question_id": id_original_koibox
        }
      ]
    }
  ]
}

REGLAS IMPORTANTES:

1. ANÁLISIS DE TIPO DE PREGUNTA:
   - Si la pregunta espera texto libre, edad, peso, medidas, fechas, comentarios → tipo 1 (Campo de texto)
   - Si la pregunta tiene opciones y se elige UNA (Sí/No, escalas de satisfacción, etc.) → tipo 2 (Selección única)
   - Si la pregunta tiene opciones y se pueden elegir VARIAS (alergias múltiples, síntomas, etc.) → tipo 3 (Selección múltiple)
   - NO te bases solo en el tipo de Koibox, ANALIZA el contenido y las respuestas disponibles

2. OPCIONES:
   - Para tipo 1 (texto): opciones debe ser {} (objeto vacío)
   - Para tipo 2 y 3: opciones debe tener formato {"opcion1": "valor1", "opcion2": "valor2", ...}
   - NO incluyas opciones tipo "[TEXTAREA]" en las opciones
   - Mantén los textos de las opciones limpios y claros

3. CATEGORÍAS:
   - Agrupa preguntas relacionadas en categorías lógicas
   - Ejemplos de categorías: "Datos personales", "Antecedentes médicos", "Diagnóstico", "Tratamiento propuesto"
   - Si no hay agrupación lógica, crea una categoría con el nombre de la encuesta
   - Las categorías deben tener un orden (0, 1, 2, ...)

4. CONTEXTO MÉDICO:
   - Esta es una aplicación para clínicas médicas/estéticas
   - Considera el contexto médico al analizar las preguntas
   - Mantén la terminología médica cuando sea apropiada

5. PRESERVAR INFORMACIÓN:
   - Guarda el ID original de Koibox en koibox_question_id
   - No pierdas información importante de las preguntas
   - Mantén los textos descriptivos claros

EJEMPLOS:

Ejemplo 1 - Campo de texto:
Koibox: {"id": 101, "tipo": 4, "descripcion": "Edad", "respuestas": [{"descripcion": "[TEXTAREA]"}]}
→ {"texto": "Edad", "id_tipo_pregunta": 1, "opciones": {}, "koibox_question_id": 101}

Ejemplo 2 - Selección única:
Koibox: {"id": 99, "tipo": 1, "descripcion": "Ejercicio", "respuestas": [{"descripcion": "Sí"}, {"descripcion": "No"}]}
→ {"texto": "Ejercicio", "id_tipo_pregunta": 2, "opciones": {"opcion1": "Sí", "opcion2": "No"}, "koibox_question_id": 99}

Ejemplo 3 - Selección múltiple:
Koibox: {"id": 260, "tipo": 1, "descripcion": "Alergias", "respuestas": [{"descripcion": "Polen"}, {"descripcion": "Medicamentos"}, {"descripcion": "Alimentos"}]}
→ {"texto": "Alergias", "id_tipo_pregunta": 3, "opciones": {"opcion1": "Polen", "opcion2": "Medicamentos", "opcion3": "Alimentos"}, "koibox_question_id": 260}

Devuelve ÚNICAMENTE el objeto JSON (sin \`\`\`json, sin markdown, sin explicaciones).`;

    const userPrompt = `Necesito transformar esta encuesta de Koibox al formato de anamnesis de ClinicSay:

**Encuesta de Koibox:**
${JSON.stringify(koiboxSurvey, null, 2)}

**Datos adicionales:**
- id_clinica: ${id_clinica}
- id_super_clinica: ${id_super_clinica}

Analiza cuidadosamente cada pregunta y determina:
1. El tipo correcto de pregunta basándote en el CONTENIDO y las RESPUESTAS (no solo en el tipo de Koibox)
2. Si tiene opciones, identifica si es selección única o múltiple basándote en el contexto
3. Agrupa las preguntas en categorías lógicas si es posible

Responde ÚNICAMENTE con el objeto JSON en el formato especificado.`;

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
    console.log("    - AI raw response length:", content.length);

    // Extraer JSON del contenido (por si viene con markdown)
    let jsonContent = content;
    if (content.includes("```json")) {
      jsonContent = content.match(/```json\s*([\s\S]*?)\s*```/)[1];
    } else if (content.includes("```")) {
      jsonContent = content.match(/```\s*([\s\S]*?)\s*```/)[1];
    }

    const result = JSON.parse(jsonContent);

    // Validar estructura básica
    if (
      !result.anamnesis_hoja ||
      !result.categorias ||
      !Array.isArray(result.categorias)
    ) {
      throw new Error(
        "Invalid structure in AI response: missing anamnesis_hoja or categorias"
      );
    }

    // Validar que cada categoría tenga preguntas
    for (const categoria of result.categorias) {
      if (!categoria.nombre || !Array.isArray(categoria.preguntas)) {
        throw new Error(
          `Invalid category structure: ${JSON.stringify(categoria)}`
        );
      }

      // Validar cada pregunta
      for (const pregunta of categoria.preguntas) {
        if (
          !pregunta.texto ||
          !pregunta.id_tipo_pregunta ||
          pregunta.opciones === undefined
        ) {
          throw new Error(
            `Invalid question structure: ${JSON.stringify(pregunta)}`
          );
        }

        // Validar que id_tipo_pregunta sea 1, 2 o 3
        if (![1, 2, 3].includes(pregunta.id_tipo_pregunta)) {
          throw new Error(
            `Invalid id_tipo_pregunta: ${pregunta.id_tipo_pregunta}`
          );
        }

        // Validar que opciones sea un objeto
        if (typeof pregunta.opciones !== "object") {
          throw new Error(`Invalid opciones type: ${typeof pregunta.opciones}`);
        }
      }
    }

    console.log(`    ✓ AI transformation successful:`);
    console.log(`      - Categories: ${result.categorias.length}`);
    console.log(
      `      - Total questions: ${result.categorias.reduce(
        (sum, cat) => sum + cat.preguntas.length,
        0
      )}`
    );

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    console.error(`    ✗ AI transformation failed:`, error.message);

    return {
      success: false,
      error: "AI_TRANSFORMATION_ERROR",
      message: error.message,
      details: error.response?.data || error,
    };
  }
}

/**
 * Transforma las respuestas de una encuesta realizada usando el mapeo de preguntas
 * @param {Array} koiboxPreguntas - Array de preguntas con respuestas de Koibox
 * @param {Object} preguntasMapping - Mapeo de koibox_question_id a {id_pregunta, id_categoria, categoria_nombre, tipo}
 * @returns {Array} - Array de respuestas en formato local
 */
function transformSurveyResponses(koiboxPreguntas, preguntasMapping) {
  // Agrupar respuestas por categoría
  const responsesByCategory = {};

  for (const koiboxPregunta of koiboxPreguntas) {
    const preguntaInfo = preguntasMapping[koiboxPregunta.pregunta.id];

    if (!preguntaInfo) {
      console.warn(
        `    ⚠ Question ${koiboxPregunta.pregunta.id} not found in mapping, skipping...`
      );
      continue;
    }

    const categoryId = preguntaInfo.id_categoria;
    const categoryName = preguntaInfo.categoria_nombre;

    // Inicializar categoría si no existe
    if (!responsesByCategory[categoryId]) {
      responsesByCategory[categoryId] = {
        respuestas: [],
        category_id: categoryId,
        category_name: categoryName,
      };
    }

    // Determinar el tipo de respuesta basado en el tipo de pregunta
    let tipo = "textarea";
    if (preguntaInfo.tipo === 2) {
      tipo = "radio"; // Selección única
    } else if (preguntaInfo.tipo === 3) {
      tipo = "checkbox"; // Selección múltiple
    }

    // Agregar respuesta
    responsesByCategory[categoryId].respuestas.push({
      tipo,
      texto:
        koiboxPregunta.pregunta.descripcion_es ||
        koiboxPregunta.pregunta.descripcion,
      respuesta: koiboxPregunta.texto_respuesta,
      question_id: preguntaInfo.id_pregunta,
    });
  }

  // Convertir objeto a array
  return Object.values(responsesByCategory);
}

module.exports = {
  transformSurveyWithAI,
  transformSurveyResponses,
};
