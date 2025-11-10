const express = require("express");
const {
  createApiClient,
  get,
  getAllPaginated,
} = require("../../utils/api-client");
const { query, transaction } = require("../../config/database");
const {
  validateBearerToken,
  validateClinicData,
} = require("../../middlewares/auth.middleware");
const {
  transformSurveyWithAI,
  transformSurveyResponses,
} = require("../../services/survey-transformer.service");

const router = express.Router();

/**
 * Obtiene el mapeo de pacientes (old_id -> id_paciente)
 * @param {number} id_clinica - ID de la clínica
 * @param {number} id_super_clinica - ID de la super clínica
 * @returns {Promise<Object>} - Mapeo de old_id a id_paciente
 */
async function getPatientMapping(id_clinica, id_super_clinica) {
  console.log("→ Building patient mapping (old_id -> id_paciente)...");

  const patients = await query(
    `SELECT id_paciente, old_id FROM pacientes
     WHERE id_clinica = ? AND id_super_clinica = ? AND old_id IS NOT NULL`,
    [id_clinica, id_super_clinica]
  );

  const mapping = {};
  patients.forEach((patient) => {
    mapping[patient.old_id] = patient.id_paciente;
  });

  console.log(`✓ Patient mapping created: ${Object.keys(mapping).length} patients`);
  return mapping;
}

/**
 * Obtiene todas las plantillas de encuestas desde Koibox
 * Hace consultas sucesivas hasta obtener 404
 * @param {Object} koiboxClient - Cliente API de Koibox
 * @returns {Promise<Array>} - Array de plantillas de encuestas
 */
async function fetchAllSurveyTemplates(koiboxClient) {
  console.log("\n→ Fetching all survey templates from Koibox...");

  const templates = [];
  let surveyId = 1;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5; // Detener después de 5 errores consecutivos

  while (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
    const response = await get(koiboxClient, `/marketing/encuestas/${surveyId}`);

    if (response.success && response.data) {
      // Reset contador de errores al encontrar una encuesta
      consecutiveErrors = 0;
      templates.push(response.data);
      console.log(`  ✓ Found survey template ID ${surveyId}: "${response.data.nombre}"`);
      surveyId++;
    } else {
      // Incrementar contador de errores
      consecutiveErrors++;
      console.log(`  - Survey ID ${surveyId} not found (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
      surveyId++;
    }
  }

  console.log(`✓ Total survey templates found: ${templates.length}`);
  return templates;
}


/**
 * Migra una plantilla de encuesta de Koibox a las tablas de anamnesis usando IA
 * @param {Object} surveyTemplate - Plantilla de encuesta de Koibox
 * @param {number} id_clinica - ID de la clínica
 * @param {number} id_super_clinica - ID de la super clínica
 * @param {Object} connection - Conexión de base de datos (para transacción)
 * @returns {Promise<Object>} - IDs generados y mapeos
 */
async function migrateSurveyTemplate(surveyTemplate, id_clinica, id_super_clinica, connection) {
  console.log(`\n  → Migrating survey template "${surveyTemplate.nombre}"...`);

  // 1. Verificar si la encuesta ya existe
  const [existingSurveys] = await connection.execute(
    `SELECT id FROM anamnesis_hojas WHERE old_id = ?`,
    [surveyTemplate.id]
  );

  if (existingSurveys.length > 0) {
    const id_anamnesis_hoja = existingSurveys[0].id;
    console.log(`    ✓ Survey template already exists (ID: ${id_anamnesis_hoja}), loading existing structure...`);

    // Cargar estructura existente para el mapeo
    const [categorias] = await connection.execute(
      `SELECT id, nombre FROM anamnesis_categorias WHERE id_anamnesis_hoja = ?`,
      [id_anamnesis_hoja]
    );

    const preguntasMapping = {};
    const categoriasInfo = {};

    for (const categoria of categorias) {
      categoriasInfo[categoria.id] = categoria.nombre;

      // Obtener preguntas de esta categoría
      const [preguntas] = await connection.execute(
        `SELECT ap.id, ap.id_tipo_pregunta
         FROM anamnesis_preguntas ap
         INNER JOIN anamnesis_categorias_has_preguntas achp ON ap.id = achp.id_anamnesis_pregunta
         WHERE achp.id_anamnesis_categoria = ?`,
        [categoria.id]
      );

      // Mapear preguntas (asumimos orden correlativo con Koibox)
      preguntas.forEach((pregunta, index) => {
        if (surveyTemplate.preguntas[index]) {
          preguntasMapping[surveyTemplate.preguntas[index].id] = {
            id_pregunta: pregunta.id,
            id_categoria: categoria.id,
            categoria_nombre: categoria.nombre,
            tipo: pregunta.id_tipo_pregunta
          };
        }
      });
    }

    return {
      id_anamnesis_hoja,
      preguntasMapping,
      categoriasInfo,
      skipped: true
    };
  }

  // 2. Usar IA para transformar la estructura
  const aiResult = await transformSurveyWithAI(surveyTemplate, id_clinica, id_super_clinica);

  if (!aiResult.success) {
    throw new Error(`AI transformation failed: ${aiResult.message}`);
  }

  const transformedSurvey = aiResult.data;

  // 3. Insertar anamnesis_hojas
  const [hojaResult] = await connection.execute(
    `INSERT INTO anamnesis_hojas
     (nombre, publico_objetivo, id_clinica, id_super_clinica, old_id, estado, fecha_creacion)
     VALUES (?, ?, ?, ?, ?, 1, NOW())`,
    [
      transformedSurvey.anamnesis_hoja.nombre,
      transformedSurvey.anamnesis_hoja.publico_objetivo,
      id_clinica,
      id_super_clinica,
      surveyTemplate.id
    ]
  );

  const id_anamnesis_hoja = hojaResult.insertId;
  console.log(`    ✓ Created anamnesis_hojas (ID: ${id_anamnesis_hoja})`);

  // 4. Insertar categorías y preguntas
  const preguntasMapping = {}; // koibox_id -> {id_pregunta, id_categoria, categoria_nombre, tipo}
  const categoriasInfo = {};

  for (const categoria of transformedSurvey.categorias) {
    // Insertar categoría
    const [categoriaResult] = await connection.execute(
      `INSERT INTO anamnesis_categorias
       (id_anamnesis_hoja, nombre, orden)
       VALUES (?, ?, ?)`,
      [id_anamnesis_hoja, categoria.nombre, categoria.orden]
    );

    const id_anamnesis_categoria = categoriaResult.insertId;
    categoriasInfo[id_anamnesis_categoria] = categoria.nombre;
    console.log(`    ✓ Created category "${categoria.nombre}" (ID: ${id_anamnesis_categoria})`);

    // Insertar preguntas de esta categoría
    for (let i = 0; i < categoria.preguntas.length; i++) {
      const pregunta = categoria.preguntas[i];

      // Insertar pregunta
      const [preguntaResult] = await connection.execute(
        `INSERT INTO anamnesis_preguntas
         (texto, id_tipo_pregunta, opciones, id_clinica, id_super_clinica, estado, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, 1, NOW())`,
        [
          pregunta.texto,
          pregunta.id_tipo_pregunta,
          JSON.stringify(pregunta.opciones),
          id_clinica,
          id_super_clinica
        ]
      );

      const id_anamnesis_pregunta = preguntaResult.insertId;

      // Guardar mapeo
      preguntasMapping[pregunta.koibox_question_id] = {
        id_pregunta: id_anamnesis_pregunta,
        id_categoria: id_anamnesis_categoria,
        categoria_nombre: categoria.nombre,
        tipo: pregunta.id_tipo_pregunta
      };

      // Relacionar pregunta con categoría
      await connection.execute(
        `INSERT INTO anamnesis_categorias_has_preguntas
         (id_anamnesis_categoria, id_anamnesis_pregunta, orden)
         VALUES (?, ?, ?)`,
        [id_anamnesis_categoria, id_anamnesis_pregunta, i]
      );
    }

    console.log(`    ✓ Created ${categoria.preguntas.length} questions in category "${categoria.nombre}"`);
  }

  console.log(`    ✓ Migration completed: ${Object.keys(preguntasMapping).length} total questions`);

  return {
    id_anamnesis_hoja,
    preguntasMapping,
    categoriasInfo,
    skipped: false
  };
}


/**
 * POST /migrations/koibox/encuestas
 * Migra encuestas (anamnesis) desde Koibox API a la base de datos local
 */
router.post(
  "/encuestas",
  validateBearerToken,
  validateClinicData,
  async (req, res) => {
    try {
      const { clinic, default: defaultValues = {} } = req.body;
      const bearerToken = req.bearerToken;

      console.log("\n========================================");
      console.log("Starting Koibox Surveys Migration");
      console.log("========================================");
      console.log("Clinic ID:", clinic.id_clinica);
      console.log("Super Clinic ID:", clinic.id_super_clinica);
      console.log("Default values:", defaultValues);
      console.log("========================================\n");

      // Crear cliente API de Koibox
      const koiboxClient = createApiClient(process.env.KOIBOX_API, {
        Authorization: `Bearer ${bearerToken}`,
      });

      // ==========================================
      // PASO 1: Obtener mapeo de pacientes
      // ==========================================
      const patientMapping = await getPatientMapping(
        clinic.id_clinica,
        clinic.id_super_clinica
      );

      if (Object.keys(patientMapping).length === 0) {
        console.warn("⚠ Warning: No patients found for this clinic");
      }

      // ==========================================
      // PASO 2: Obtener todas las plantillas de encuestas
      // ==========================================
      const surveyTemplates = await fetchAllSurveyTemplates(koiboxClient);

      if (surveyTemplates.length === 0) {
        return res.status(404).json({
          success: false,
          error: "NO_SURVEYS_FOUND",
          message: "No survey templates found in Koibox",
        });
      }

      // ==========================================
      // PASO 3: Migrar plantillas de encuestas
      // ==========================================
      console.log("\n→ Step 3: Migrating survey templates to database...");

      const templatesMapping = {}; // old_id -> { id_anamnesis_hoja, id_anamnesis_categoria, preguntasIds }
      let templatesCreated = 0;
      let templatesSkipped = 0;

      for (const template of surveyTemplates) {
        try {
          await transaction(async (connection) => {
            const result = await migrateSurveyTemplate(
              template,
              clinic.id_clinica,
              clinic.id_super_clinica,
              connection
            );

            if (result.skipped) {
              templatesSkipped++;
            } else {
              templatesCreated++;
            }

            // Guardar mapeo completo
            templatesMapping[template.id] = {
              id_anamnesis_hoja: result.id_anamnesis_hoja,
              preguntasMapping: result.preguntasMapping,
              categoriasInfo: result.categoriasInfo
            };
          });
        } catch (error) {
          console.error(`  ✗ Error migrating template "${template.nombre}":`, error.message);
        }
      }

      console.log(`\n✓ Templates migration completed:`);
      console.log(`  - Created: ${templatesCreated}`);
      console.log(`  - Skipped (already exist): ${templatesSkipped}`);

      // ==========================================
      // PASO 4: Obtener encuestas realizadas (con respuestas)
      // ==========================================
      console.log("\n→ Step 4: Fetching completed surveys from Koibox...");

      const completedSurveysResponse = await getAllPaginated(
        koiboxClient,
        "/marketing/encuestas-realizadas/",
        100
      );

      if (!completedSurveysResponse.success) {
        return res.status(500).json({
          success: false,
          error: "FETCH_COMPLETED_SURVEYS_ERROR",
          message: "Failed to fetch completed surveys from Koibox",
          details: completedSurveysResponse.error,
        });
      }

      const completedSurveys = completedSurveysResponse.data;
      console.log(`✓ Found ${completedSurveys.length} completed surveys`);

      // ==========================================
      // PASO 5: Obtener detalles y migrar respuestas (EN PARALELO)
      // ==========================================
      console.log("\n→ Step 5: Fetching details and migrating responses...");

      const stats = {
        total: completedSurveys.length,
        processed: 0,
        inserted: 0,
        skipped: 0,
        errors: [],
      };

      // Procesar encuestas en lotes paralelos
      const BATCH_SIZE = 15; // Procesar 15 encuestas en paralelo

      for (let batchStart = 0; batchStart < completedSurveys.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, completedSurveys.length);
        const surveyBatch = completedSurveys.slice(batchStart, batchEnd);

        console.log(
          `\n→ Processing survey batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(completedSurveys.length / BATCH_SIZE)} (surveys ${batchStart + 1}-${batchEnd})...`
        );

        // Procesar este lote de encuestas en paralelo
        await Promise.all(
          surveyBatch.map(async (survey) => {
            try {
              // Obtener detalle con respuestas
              const detailResponse = await get(
                koiboxClient,
                `/marketing/encuestas-realizadas/${survey.id}`
              );

              if (!detailResponse.success || !detailResponse.data) {
                console.warn(`  ⚠ Could not fetch details for survey ${survey.id}, skipping...`);
                stats.skipped++;
                return; // Early return instead of continue
              }

              const surveyDetail = detailResponse.data;

              // Verificar si tenemos la plantilla mapeada
              const templateMap = templatesMapping[surveyDetail.encuesta.id];
              if (!templateMap) {
                console.warn(`  ⚠ Template ${surveyDetail.encuesta.id} not found in mapping, skipping...`);
                stats.skipped++;
                return; // Early return instead of continue
              }

              // Obtener id_paciente del mapeo
              const id_paciente = patientMapping[surveyDetail.cliente.value];
              if (!id_paciente) {
                console.warn(`  ⚠ Patient ${surveyDetail.cliente.value} not found in mapping, skipping...`);
                stats.skipped++;
                return; // Early return instead of continue
              }

              // Verificar si ya existe esta respuesta
              const existingResponse = await query(
                `SELECT id FROM anamnesis_hojas_has_pacientes
                 WHERE id_anamnesis_hoja = ? AND id_paciente = ?`,
                [templateMap.id_anamnesis_hoja, id_paciente]
              );

              if (existingResponse.length > 0) {
                stats.skipped++;
                return; // Early return instead of continue
              }

              // Transformar respuestas al formato local usando el servicio
              const respuestas = transformSurveyResponses(
                surveyDetail.preguntas,
                templateMap.preguntasMapping
              );

              // Insertar respuestas
              await query(
                `INSERT INTO anamnesis_hojas_has_pacientes
                 (id_anamnesis_hoja, id_paciente, respuestas, estado, fecha_creacion)
                 VALUES (?, ?, ?, 1, ?)`,
                [
                  templateMap.id_anamnesis_hoja,
                  id_paciente,
                  JSON.stringify(respuestas),
                  surveyDetail.created ? surveyDetail.created.replace("T", " ").split(".")[0] : null
                ]
              );

              stats.inserted++;
              stats.processed++;
            } catch (error) {
              console.error(`  ✗ Error processing survey ${survey.id}:`, error.message);
              stats.errors.push({
                survey_id: survey.id,
                error: error.message,
              });
              stats.processed++;
            }
          })
        );

        console.log(
          `  ✓ Batch ${Math.floor(batchStart / BATCH_SIZE) + 1} completed (${stats.processed}/${stats.total} surveys processed)`
        );
      }

      console.log("\n✓ Responses migration completed:");
      console.log(`  - Total: ${stats.total}`);
      console.log(`  - Inserted: ${stats.inserted}`);
      console.log(`  - Skipped: ${stats.skipped}`);
      console.log(`  - Errors: ${stats.errors.length}`);

      // ==========================================
      // PASO 6: Generar respuesta
      // ==========================================
      console.log("\n========================================");
      console.log("Migration Completed");
      console.log("========================================");
      console.log("Survey Templates Created:", templatesCreated);
      console.log("Survey Templates Skipped:", templatesSkipped);
      console.log("Responses Inserted:", stats.inserted);
      console.log("Responses Skipped:", stats.skipped);
      console.log("Errors:", stats.errors.length);
      console.log("========================================\n");

      const success = stats.errors.length === 0;

      return res.status(success ? 200 : 207).json({
        success,
        message: success
          ? "Migration completed successfully"
          : "Migration completed with errors",
        stats: {
          templates: {
            total: surveyTemplates.length,
            created: templatesCreated,
            skipped: templatesSkipped,
          },
          responses: {
            total: stats.total,
            inserted: stats.inserted,
            skipped: stats.skipped,
            errors: stats.errors.length,
          },
        },
        errors: stats.errors,
      });
    } catch (error) {
      console.error("\n✗ Migration failed:", error);

      return res.status(500).json({
        success: false,
        error: "MIGRATION_ERROR",
        message: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  }
);

module.exports = router;
