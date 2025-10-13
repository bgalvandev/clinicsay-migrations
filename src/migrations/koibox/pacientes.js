const express = require("express");
const {
  createApiClient,
  get,
  processPaginatedInBatches,
} = require("../../utils/api-client");
const { mapData } = require("../../services/ai-mapper.service");
const { query } = require("../../config/database");
const { processBatches } = require("../../services/batch.service");
const {
  validateBearerToken,
  validateClinicData,
} = require("../../middlewares/auth.middleware");

const router = express.Router();

/**
 * POST /migrations/koibox/pacientes
 * Migra pacientes desde Koibox API a la base de datos local
 */
router.post(
  "/pacientes",
  validateBearerToken,
  validateClinicData,
  async (req, res) => {
    try {
      const { clinic, default: defaultValues = {} } = req.body;
      const bearerToken = req.bearerToken;

      console.log("\n========================================");
      console.log("Starting Koibox Patients Migration");
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
      // PASO 1: Obtener filtros y realizar mapeos con IA
      // ==========================================
      console.log("→ Step 1: Fetching filters configuration from Koibox...");

      const filtersResponse = await get(
        koiboxClient,
        "/clientes/clientes/filters/"
      );

      if (!filtersResponse.success) {
        return res.status(500).json({
          success: false,
          error: "KOIBOX_API_ERROR",
          message: "Failed to fetch filters configuration from Koibox",
          details: filtersResponse.error,
        });
      }

      const filters = filtersResponse.data;

      // ==========================================
      // PASO 1.1: Mapear Sexo
      // ==========================================
      console.log("\n→ Step 1.1: Mapping gender types...");

      const apiGenders = filters.sexos;

      if (!apiGenders || !Array.isArray(apiGenders)) {
        return res.status(500).json({
          success: false,
          error: "INVALID_GENDER_DATA",
          message: "Gender data not found in Koibox API response",
        });
      }

      console.log(`✓ Found ${apiGenders.length} gender types in Koibox API`);

      // Obtener sexos de la BD local
      const dbGenders = await query("SELECT * FROM sexo");
      console.log(`✓ Found ${dbGenders.length} gender types in local database`);

      // Mapear con IA
      const genderMapping = await mapData("gender", apiGenders, dbGenders);

      if (genderMapping.error) {
        return res.status(500).json({
          success: false,
          error: "GENDER_MAPPING_ERROR",
          message: "AI mapping failed for gender types",
          details: genderMapping,
        });
      }

      if (genderMapping.missing && genderMapping.missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: "MISSING_GENDER_TYPES",
          message:
            "Some gender types from Koibox are not found in local database",
          missing: genderMapping.missing,
          mapper: genderMapping.mapper,
        });
      }

      console.log("✓ Gender mapping completed successfully");
      console.log("  Gender mapper:", genderMapping.mapper);

      // ==========================================
      // PASO 1.2: Mapear Ciudad (Provincia)
      // ==========================================
      console.log("\n→ Step 1.2: Mapping cities/provinces...");

      const apiProvinces = filters.provincias;

      if (!apiProvinces || !Array.isArray(apiProvinces)) {
        console.warn(
          "⚠ Warning: Province data not found in API, skipping province mapping"
        );
      }

      let provinceMapping = { mapper: {}, missing: [] };

      if (apiProvinces && apiProvinces.length > 0) {
        console.log(`✓ Found ${apiProvinces.length} provinces in Koibox API`);

        // Para provincias, simplemente creamos un mapper directo con el nombre
        // No necesitamos mapear con BD porque usaremos el nombre directamente
        provinceMapping.mapper = apiProvinces.reduce((acc, province) => {
          acc[province.id.toString()] = province.text; // ID -> Nombre de provincia
          return acc;
        }, {});

        console.log("✓ Province mapping created successfully");
      }

      // ==========================================
      // PASO 1.3: Mapear Referido (Como nos conocio)
      // ==========================================
      console.log("\n→ Step 1.3: Mapping referral sources...");

      const apiReferrals = filters.como_nos_conocio;

      if (!apiReferrals || !Array.isArray(apiReferrals)) {
        console.warn(
          "⚠ Warning: Referral data not found in API, skipping referral mapping"
        );
      }

      let referralMapping = { mapper: {}, missing: [] };

      if (apiReferrals && apiReferrals.length > 0) {
        console.log(
          `✓ Found ${apiReferrals.length} referral sources in Koibox API`
        );

        // Para referidos, simplemente creamos un mapper directo con el nombre
        referralMapping.mapper = apiReferrals.reduce((acc, referral) => {
          acc[referral.value.toString()] = referral.text; // ID -> Nombre de referido
          return acc;
        }, {});

        console.log("✓ Referral mapping created successfully");
      }

      // ==========================================
      // PASO 2: Obtener pacientes paginados, transformar e insertar
      // ==========================================
      console.log(
        "\n→ Step 2: Fetching, transforming and inserting patients..."
      );

      // Estadísticas globales
      const globalStats = {
        totalRecords: 0,
        totalBatches: 0,
        successfulBatches: 0,
        failedBatches: 0,
        insertedRecords: 0,
        errors: [],
      };

      // Procesar cada página: obtener → transformar → insertar
      const processingResult = await processPaginatedInBatches(
        koiboxClient,
        "/clientes/clientes/",
        async (patients, currentPage, totalPages) => {
          console.log(
            `\n→ Processing batch ${currentPage + 1}/${totalPages} (${
              patients.length
            } patients)...`
          );

          // Transformar pacientes de esta página
          const transformedBatch = patients.map((patient) => {
            // Determinar id_estado_registro basado en is_active y defaults
            let idEstadoRegistro = 1; // Por defecto: activo

            if (!patient.is_active) {
              idEstadoRegistro = 2; // Inactivo
            }

            // Mapear id de sexo usando el mapper de IA
            const idSexo = patient.sexo
              ? genderMapping.mapper[patient.sexo.toString()]
              : null;

            if (patient.sexo && !idSexo) {
              console.warn(
                `⚠ Warning: No gender mapping found for patient ${patient.id} (gender ID: ${patient.sexo})`
              );
            }

            // Obtener ciudad desde provincia mapeada
            const ciudad = patient.provincia
              ? provinceMapping.mapper[patient.provincia.toString()] ||
                patient.localidad
              : patient.localidad;

            // Obtener referido desde mapper
            const referido = patient.como_nos_conocio
              ? referralMapping.mapper[patient.como_nos_conocio.toString()]
              : null;

            // Concatenar apellidos
            const apellido = [patient.apellido1, patient.apellido2]
              .filter(Boolean)
              .join(" ");

            // Formatear teléfono con prefijo
            const telefono = patient.movil
              ? `+${patient.prefijo_tel || "34"}${patient.movil}`
              : patient.fijo || "";

            // Concatenar observaciones
            const observaciones = [patient.notas, patient.informacion_clinica]
              .filter(Boolean)
              .join("\n");

            return {
              nombre: patient.nombre || "",
              apellido: apellido || "",
              email: patient.email || null,
              telefono: telefono || null,
              fecha_nacimiento: patient.fecha_nacimiento || null,
              id_sexo: idSexo || null,
              direccion: patient.direccion || null,
              ciudad: ciudad || null,
              id_clinica: clinic.id_clinica,
              codigo_postal: patient.codigo_postal || "0",
              nif_cif: patient.dni || "0",
              url_foto: patient.foto_url_absolute_path || null,
              referido: referido || null,
              observaciones: observaciones || null,
              profesion: null,
              id_super_clinica: clinic.id_super_clinica,
              id_estado_registro: idEstadoRegistro,
              id_cliente: null,
              id_medico: null,
              lopd_aceptado: patient.is_agree_rgpd ? 1 : 0,
              Importado: null,
              kommo_lead_id: null,
              old_id: patient.id,
              fecha_alta: patient.fecha_alta
                ? patient.fecha_alta.split("T")[0]
                : null,
              fecha_creacion:
                patient.created?.replace("T", " ").split(".")[0] || null,
              fecha_modificacion:
                patient.updated?.replace("T", " ").split(".")[0] || null,
              // Valores por defecto si no vienen en los datos
            };
          });

          console.log(`✓ Transformed ${transformedBatch.length} patients`);

          // Insertar inmediatamente este lote en la BD
          console.log(`→ Inserting batch ${currentPage + 1} into database...`);

          const batchStats = await processBatches(
            "pacientes",
            transformedBatch,
            100 // Tamaño de lote
          );

          // Acumular estadísticas
          globalStats.totalRecords += batchStats.totalRecords;
          globalStats.totalBatches += batchStats.totalBatches;
          globalStats.successfulBatches += batchStats.successfulBatches;
          globalStats.failedBatches += batchStats.failedBatches;
          globalStats.insertedRecords += batchStats.insertedRecords;
          globalStats.errors.push(...batchStats.errors);

          console.log(
            `✓ Batch ${currentPage + 1} completed: ${
              batchStats.insertedRecords
            }/${batchStats.totalRecords} records inserted`
          );
        },
        100 // Límite de 100 por página
      );

      if (!processingResult.success) {
        return res.status(500).json({
          success: false,
          error: "FETCH_PATIENTS_ERROR",
          message: "Failed to fetch patients from Koibox",
          details: processingResult.error,
        });
      }

      console.log(
        `\n✓ All batches processed: ${globalStats.insertedRecords}/${globalStats.totalRecords} total records inserted`
      );

      const insertStats = globalStats;

      // ==========================================
      // PASO 4: Generar respuesta
      // ==========================================
      console.log("\n========================================");
      console.log("Migration Completed");
      console.log("========================================");
      console.log("Total Patients:", insertStats.totalRecords);
      console.log("Successful Batches:", insertStats.successfulBatches);
      console.log("Failed Batches:", insertStats.failedBatches);
      console.log("Inserted Records:", insertStats.insertedRecords);
      console.log("========================================\n");

      const success = insertStats.failedBatches === 0;

      return res.status(success ? 200 : 207).json({
        success,
        message: success
          ? "Migration completed successfully"
          : "Migration completed with errors",
        stats: {
          totalPatients: insertStats.totalRecords,
          batches: insertStats.totalBatches,
          successfulBatches: insertStats.successfulBatches,
          failedBatches: insertStats.failedBatches,
          insertedRecords: insertStats.insertedRecords,
        },
        errors: insertStats.errors,
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
