const express = require("express");
const {
  createApiClient,
  get,
  getAllPaginated,
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
 * POST /migrations/koibox/citas
 * Migra citas desde Koibox API a la base de datos local
 */
router.post(
  "/citas",
  validateBearerToken,
  validateClinicData,
  async (req, res) => {
    try {
      const { clinic, default: defaultValues = {} } = req.body;
      const bearerToken = req.bearerToken;

      console.log("\n========================================");
      console.log("Starting Koibox Appointments Migration");
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
      // PASO 1: Obtener filtros de citas (estados y recursos)
      // ==========================================
      console.log("→ Step 1: Fetching appointment filters from Koibox...");

      const filtersResponse = await get(koiboxClient, "/agenda/citas/form/");

      if (!filtersResponse.success) {
        return res.status(500).json({
          success: false,
          error: "KOIBOX_API_ERROR",
          message: "Failed to fetch appointment filters from Koibox",
          details: filtersResponse.error,
        });
      }

      const filters = filtersResponse.data;

      // ==========================================
      // PASO 2: Mapear impuestos (necesario para tratamientos missing)
      // ==========================================
      console.log("\n→ Step 2: Fetching and mapping taxes...");

      const taxConfigResponse = await get(
        koiboxClient,
        "/configuraciones/productos/form/"
      );

      if (!taxConfigResponse.success) {
        return res.status(500).json({
          success: false,
          error: "KOIBOX_API_ERROR",
          message: "Failed to fetch tax configuration from Koibox",
          details: taxConfigResponse.error,
        });
      }

      const apiTaxes = taxConfigResponse.data.impuestos;

      if (!apiTaxes || !Array.isArray(apiTaxes)) {
        return res.status(500).json({
          success: false,
          error: "INVALID_TAX_DATA",
          message: "Tax data not found in Koibox API response",
        });
      }

      console.log(`✓ Found ${apiTaxes.length} tax types in Koibox API`);

      // Obtener tipos de IVA de la BD local
      const dbTaxes = await query("SELECT * FROM tipo_iva");
      console.log(`✓ Found ${dbTaxes.length} tax types in local database`);

      // Mapear con IA
      const taxMapping = await mapData("tax", apiTaxes, dbTaxes);

      if (taxMapping.error) {
        return res.status(500).json({
          success: false,
          error: "TAX_MAPPING_ERROR",
          message: "AI mapping failed for tax types",
          details: taxMapping,
        });
      }

      if (taxMapping.missing && taxMapping.missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: "MISSING_TAX_TYPES",
          message: "Some tax types from Koibox are not found in local database",
          missing: taxMapping.missing,
          mapper: taxMapping.mapper,
        });
      }

      console.log("✓ Tax mapping completed successfully");
      console.log("  Tax mapper:", taxMapping.mapper);

      // ==========================================
      // PASO 3: Obtener y mapear médicos (con paginación completa)
      // ==========================================
      console.log("\n→ Step 3: Fetching and mapping doctors...");

      const allDoctorsResponse = await getAllPaginated(
        koiboxClient,
        "/main/users/",
        100
      );

      if (!allDoctorsResponse.success) {
        return res.status(500).json({
          success: false,
          error: "FETCH_DOCTORS_ERROR",
          message: "Failed to fetch doctors from Koibox",
          details: allDoctorsResponse.error,
        });
      }

      //  Obtener resultados de la API
      const apiDoctors = allDoctorsResponse.data.map((doctor) => {
        const { permissions, filtros_agenda, ...rest } = doctor;
        return rest;
      });

      console.log(`✓ Found ${apiDoctors.length} doctors in Koibox API`);

      // Obtener médicos de la BD local
      const dbDoctors = await query(
        "SELECT * FROM medicos WHERE id_clinica = ? AND id_super_clinica = ?",
        [clinic.id_clinica, clinic.id_super_clinica]
      );
      console.log(`✓ Found ${dbDoctors.length} doctors in local database`);

      // Mapear con IA
      const doctorMapping = await mapData("doctor", apiDoctors, dbDoctors, {
        allowManyToOne: true,
      });

      if (doctorMapping.error) {
        return res.status(500).json({
          success: false,
          error: "DOCTOR_MAPPING_ERROR",
          message: "AI mapping failed for doctors",
          details: doctorMapping,
        });
      }

      if (doctorMapping.missing && doctorMapping.missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: "MISSING_DOCTORS",
          message: "Some doctors from Koibox are not found in local database",
          missing: doctorMapping.missing,
          mapper: doctorMapping.mapper,
        });
      }

      console.log("✓ Doctor mapping completed successfully");

      // ==========================================
      // PASO 4: Obtener y mapear tratamientos (con paginación completa)
      // ==========================================
      console.log("\n→ Step 4: Fetching and mapping treatments...");

      const allTreatmentsResponse = await getAllPaginated(
        koiboxClient,
        "/configuraciones/servicios/",
        100
      );

      if (!allTreatmentsResponse.success) {
        return res.status(500).json({
          success: false,
          error: "FETCH_TREATMENTS_ERROR",
          message: "Failed to fetch treatments from Koibox",
          details: allTreatmentsResponse.error,
        });
      }

      const apiTreatments = allTreatmentsResponse.data;
      console.log(`✓ Found ${apiTreatments.length} treatments in Koibox API`);

      // Obtener tratamientos de la BD local
      const dbTreatments = await query(
        "SELECT * FROM tratamientos WHERE id_clinica = ? AND id_super_clinica = ?",
        [clinic.id_clinica, clinic.id_super_clinica]
      );
      console.log(
        `✓ Found ${dbTreatments.length} treatments in local database`
      );

      // Mapear con IA, pasando taxMapping para construir missing correctamente
      const treatmentMapping = await mapData(
        "treatment",
        apiTreatments,
        dbTreatments,
        {
          relatedMappings: {
            taxMapper: taxMapping.mapper,
            description: "Use taxMapper to map 'impuesto' field to 'id_tipo_iva' in missing objects"
          }
        }
      );

      if (treatmentMapping.error) {
        return res.status(500).json({
          success: false,
          error: "TREATMENT_MAPPING_ERROR",
          message: "AI mapping failed for treatments",
          details: treatmentMapping,
        });
      }

      if (treatmentMapping.missing && treatmentMapping.missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: "MISSING_TREATMENTS",
          message:
            "Some treatments from Koibox are not found in local database",
          missing: treatmentMapping.missing,
          mapper: treatmentMapping.mapper,
        });
      }

      console.log("✓ Treatment mapping completed successfully");

      // ==========================================
      // PASO 5: Mapear estados (many-to-one, sin missing)
      // ==========================================
      console.log("\n→ Step 5: Mapping appointment states...");

      const apiStates = filters.estados;

      if (!apiStates || !Array.isArray(apiStates)) {
        return res.status(500).json({
          success: false,
          error: "INVALID_STATE_DATA",
          message: "State data not found in Koibox API response",
        });
      }

      console.log(
        `✓ Found ${apiStates.length} appointment states in Koibox API`
      );

      // Obtener estados de la BD local
      const dbStates = await query("SELECT * FROM estado_cita");
      console.log(
        `✓ Found ${dbStates.length} appointment states in local database`
      );

      // Mapear con IA (many-to-one, sin missing)
      const stateMapping = await mapData(
        "appointment_state",
        apiStates,
        dbStates,
        {
          allowManyToOne: true,
          requireCompleteMapping: true,
        }
      );

      if (stateMapping.error) {
        return res.status(500).json({
          success: false,
          error: "STATE_MAPPING_ERROR",
          message: "AI mapping failed for appointment states",
          details: stateMapping,
        });
      }

      if (stateMapping.missing && stateMapping.missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: "MISSING_STATES",
          message:
            "Some appointment states from Koibox could not be mapped. This should not happen with many-to-one mapping.",
          missing: stateMapping.missing,
          mapper: stateMapping.mapper,
        });
      }

      console.log("✓ State mapping completed successfully (many-to-one)");

      // ==========================================
      // PASO 6: Mapear espacios
      // ==========================================
      console.log("\n→ Step 6: Mapping spaces/resources...");

      const apiSpaces = filters.recursos;

      if (!apiSpaces || !Array.isArray(apiSpaces)) {
        console.warn(
          "⚠ Warning: Space data not found in API, skipping space mapping"
        );
      }

      let spaceMapping = { mapper: {}, missing: [] };

      if (apiSpaces && apiSpaces.length > 0) {
        console.log(`✓ Found ${apiSpaces.length} spaces in Koibox API`);

        // Obtener espacios de la BD local
        const dbSpaces = await query(
          "SELECT * FROM espacios WHERE id_clinica = ? AND id_super_clinica = ?",
          [clinic.id_clinica, clinic.id_super_clinica]
        );
        console.log(`✓ Found ${dbSpaces.length} spaces in local database`);

        // Mapear con IA
        spaceMapping = await mapData("space", apiSpaces, dbSpaces);

        if (spaceMapping.error) {
          return res.status(500).json({
            success: false,
            error: "SPACE_MAPPING_ERROR",
            message: "AI mapping failed for spaces",
            details: spaceMapping,
          });
        }

        if (spaceMapping.missing && spaceMapping.missing.length > 0) {
          return res.status(400).json({
            success: false,
            error: "MISSING_SPACES",
            message: "Some spaces from Koibox are not found in local database",
            missing: spaceMapping.missing,
            mapper: spaceMapping.mapper,
          });
        }

        console.log("✓ Space mapping completed successfully");
        console.log("  Space mapper:", spaceMapping.mapper);
      }

      // ==========================================
      // PASO 7: Obtener pacientes de BD para mapeo directo
      // ==========================================
      console.log("\n→ Step 7: Loading patients from database...");

      const dbPatients = await query(
        "SELECT id_paciente, old_id FROM pacientes WHERE id_clinica = ? AND id_super_clinica = ?",
        [clinic.id_clinica, clinic.id_super_clinica]
      );

      // Crear mapeo directo old_id -> id_paciente
      const patientMapping = {};
      dbPatients.forEach((patient) => {
        if (patient.old_id) {
          patientMapping[patient.old_id.toString()] = patient.id_paciente;
        }
      });

      console.log(`✓ Loaded ${dbPatients.length} patients for direct mapping`);
      console.log(
        `  Patient mapper entries: ${Object.keys(patientMapping).length}`
      );

      // ==========================================
      // PASO 8: Procesar citas con streaming
      // ==========================================
      console.log(
        "\n→ Step 8: Fetching, transforming and inserting appointments..."
      );

      // Estadísticas globales
      const globalStats = {
        totalRecords: 0,
        totalBatches: 0,
        successfulBatches: 0,
        failedBatches: 0,
        insertedRecords: 0,
        errors: [],
        warnings: {
          missingPatients: 0,
          missingDoctors: 0,
          missingTreatments: 0,
          missingSpaces: 0,
        },
      };

      // Procesar cada página: obtener → transformar → insertar
      const processingResult = await processPaginatedInBatches(
        koiboxClient,
        "/agenda/citas/",
        async (appointments, currentPage, totalPages) => {
          console.log(
            `\n→ Processing batch ${currentPage + 1}/${totalPages} (${
              appointments.length
            } appointments)...`
          );

          // Transformar citas de esta página
          const transformedBatch = appointments
            .flatMap((appointment) => {
              // Mapear id_paciente desde old_id
              const idPaciente = appointment.cliente
                ? patientMapping[appointment.cliente.toString()]
                : null;

              if (appointment.cliente && !idPaciente) {
                globalStats.warnings.missingPatients++;
                console.warn(
                  `⚠ Warning: Patient not found for appointment ${appointment.id} (patient ID: ${appointment.cliente})`
                );
                return null; // Skip this appointment
              }

              // Mapear id_medico desde mapper
              const idMedico = appointment.user
                ? doctorMapping.mapper[appointment.user.toString()]
                : null;

              if (appointment.user && !idMedico) {
                globalStats.warnings.missingDoctors++;
                console.warn(
                  `⚠ Warning: Doctor not found for appointment ${appointment.id} (doctor ID: ${appointment.user})`
                );
              }

              // Mapear id_estado_cita desde mapper
              const idEstadoCita = appointment.estado
                ? stateMapping.mapper[appointment.estado.toString()]
                : null;

              // Mapear id_espacio desde mapper (usar primer recurso si hay varios)
              const firstResource =
                appointment.recursos && appointment.recursos.length > 0
                  ? appointment.recursos[0]
                  : null;
              const idEspacio = firstResource
                ? spaceMapping.mapper[firstResource.toString()]
                : null;

              if (firstResource && !idEspacio) {
                globalStats.warnings.missingSpaces++;
              }

              // Concatenar observaciones
              const observacionesMedicas =
                appointment.informacion_clinica || null;
              const comentariosCita = [
                appointment.observaciones,
                appointment.notas,
              ]
                .filter(Boolean)
                .join("\n");

              // Datos base compartidos por todas las citas duplicadas
              const baseAppointmentData = {
                id_paciente: idPaciente,
                id_medico: idMedico || null,
                id_super_clinica: clinic.id_super_clinica,
                id_clinica: clinic.id_clinica,
                fecha_cita: appointment.fecha || null,
                hora_inicio: appointment.hora_inicio || null,
                hora_fin: appointment.hora_fin || null,
                id_estado_cita: idEstadoCita || 1,
                id_espacio: idEspacio || null,
                comentario_ia: null,
                comentario_ausente_cancelado: null,
                es_pack_bono: null,
                id_pack_bono: null,
                id_presupuesto: null,
                id_recibo: null,
                item_presupuesto: null,
                old_id: appointment.id,
                id_contacto: null,
                fecha_creacion:
                  appointment.created?.replace("T", " ").split(".")[0] || null,
                fecha_modificacion:
                  appointment.updated?.replace("T", " ").split(".")[0] || null,
                usuario_creacion: null,
                id_usuario_creacion: null,
                fecha_migracion: null,
                detalles_migracion: null,
                id_estados_cita_in: null,
              };

              // Obtener todos los servicios de la cita
              const services =
                appointment.servicios && appointment.servicios.length > 0
                  ? appointment.servicios
                  : [null];

              // Crear una cita por cada servicio
              const appointmentRecords = services.map((serviceId, index) => {
                const isPrimary = index === 0;

                // Mapear tratamiento
                const idTratamiento = serviceId
                  ? treatmentMapping.mapper[serviceId.toString()]
                  : null;

                if (serviceId && !idTratamiento) {
                  globalStats.warnings.missingTreatments++;
                  console.warn(
                    `⚠ Warning: Treatment not found for appointment ${appointment.id} (service ID: ${serviceId})`
                  );
                }

                return {
                  ...baseAppointmentData,
                  id_tratamiento: idTratamiento || null,
                  // Solo la primera cita tiene observaciones y comentarios
                  observaciones_medicas: isPrimary
                    ? observacionesMedicas
                    : null,
                  comentarios_cita: isPrimary ? comentariosCita || null : null,
                  // La primera es principal (NULL), las demás se marcarán después
                  id_cita_reference: isPrimary ? null : "PENDING",
                  // Metadata para identificar duplicados
                  _isPrimary: isPrimary,
                  _originalId: appointment.id,
                };
              });

              return appointmentRecords;
            })
            .filter(Boolean); // Filtrar nulls (citas sin paciente)

          console.log(
            `✓ Transformed ${transformedBatch.length} appointment records (including duplicates for multiple services)`
          );

          if (transformedBatch.length === 0) {
            console.log(
              `⚠ Skipping batch ${currentPage + 1}: no valid appointments`
            );
            return;
          }

          // Separar citas primarias y secundarias
          const primaryAppointments = transformedBatch.filter(
            (apt) => apt._isPrimary
          );
          const secondaryAppointments = transformedBatch.filter(
            (apt) => !apt._isPrimary
          );

          console.log(
            `→ Inserting batch ${currentPage + 1}: ${primaryAppointments.length} primary, ${secondaryAppointments.length} secondary appointments`
          );

          // PASO 1: Insertar citas primarias
          if (primaryAppointments.length > 0) {
            // Remover metadata antes de insertar
            const cleanPrimaryAppointments = primaryAppointments.map(
              ({ _isPrimary, _originalId, ...appointment }) => appointment
            );

            const primaryStats = await processBatches(
              "citas",
              cleanPrimaryAppointments,
              100
            );

            // Acumular estadísticas
            globalStats.totalRecords += primaryStats.totalRecords;
            globalStats.totalBatches += primaryStats.totalBatches;
            globalStats.successfulBatches += primaryStats.successfulBatches;
            globalStats.failedBatches += primaryStats.failedBatches;
            globalStats.insertedRecords += primaryStats.insertedRecords;
            globalStats.errors.push(...primaryStats.errors);

            console.log(
              `✓ Primary appointments inserted: ${primaryStats.insertedRecords}/${primaryStats.totalRecords}`
            );
          }

          // PASO 2: Obtener IDs de las citas primarias recién insertadas y actualizar secundarias
          if (secondaryAppointments.length > 0) {
            // Obtener old_ids únicos de las citas secundarias
            const uniqueOldIds = [
              ...new Set(secondaryAppointments.map((apt) => apt._originalId)),
            ];

            // Consultar las citas primarias recién insertadas por old_id
            const placeholders = uniqueOldIds.map(() => "?").join(",");
            const insertedPrimaryAppointments = await query(
              `SELECT id_cita, old_id FROM citas
               WHERE old_id IN (${placeholders})
               AND id_cita_reference IS NULL
               AND id_clinica = ?
               AND id_super_clinica = ?`,
              [...uniqueOldIds, clinic.id_clinica, clinic.id_super_clinica]
            );

            // Crear mapeo old_id -> id_cita
            const primaryIdMapping = {};
            insertedPrimaryAppointments.forEach((apt) => {
              primaryIdMapping[apt.old_id] = apt.id_cita;
            });

            // Actualizar id_cita_reference en citas secundarias
            const cleanSecondaryAppointments = secondaryAppointments.map(
              ({ _isPrimary, _originalId, id_cita_reference, ...appointment }) => ({
                ...appointment,
                id_cita_reference: primaryIdMapping[_originalId] || null,
              })
            );

            // Insertar citas secundarias
            const secondaryStats = await processBatches(
              "citas",
              cleanSecondaryAppointments,
              100
            );

            // Acumular estadísticas
            globalStats.totalRecords += secondaryStats.totalRecords;
            globalStats.totalBatches += secondaryStats.totalBatches;
            globalStats.successfulBatches += secondaryStats.successfulBatches;
            globalStats.failedBatches += secondaryStats.failedBatches;
            globalStats.insertedRecords += secondaryStats.insertedRecords;
            globalStats.errors.push(...secondaryStats.errors);

            console.log(
              `✓ Secondary appointments inserted: ${secondaryStats.insertedRecords}/${secondaryStats.totalRecords}`
            );
          }

          console.log(
            `✓ Batch ${currentPage + 1} completed: ${
              globalStats.insertedRecords
            } total records inserted`
          );
        },
        100 // Límite de 100 por página
      );

      if (!processingResult.success) {
        return res.status(500).json({
          success: false,
          error: "FETCH_APPOINTMENTS_ERROR",
          message: "Failed to fetch appointments from Koibox",
          details: processingResult.error,
        });
      }

      console.log(
        `\n✓ All batches processed: ${globalStats.insertedRecords}/${globalStats.totalRecords} total records inserted`
      );

      if (globalStats.warnings.missingPatients > 0) {
        console.warn(
          `⚠ ${globalStats.warnings.missingPatients} appointments skipped due to missing patients`
        );
      }

      const insertStats = globalStats;

      // ==========================================
      // PASO 9: Generar respuesta
      // ==========================================
      console.log("\n========================================");
      console.log("Migration Completed");
      console.log("========================================");
      console.log("Total Appointments:", insertStats.totalRecords);
      console.log("Successful Batches:", insertStats.successfulBatches);
      console.log("Failed Batches:", insertStats.failedBatches);
      console.log("Inserted Records:", insertStats.insertedRecords);
      console.log("Warnings:");
      console.log(
        "  - Missing Patients:",
        insertStats.warnings.missingPatients
      );
      console.log("  - Missing Doctors:", insertStats.warnings.missingDoctors);
      console.log(
        "  - Missing Treatments:",
        insertStats.warnings.missingTreatments
      );
      console.log("  - Missing Spaces:", insertStats.warnings.missingSpaces);
      console.log("========================================\n");

      const success = insertStats.failedBatches === 0;

      return res.status(success ? 200 : 207).json({
        success,
        message: success
          ? "Migration completed successfully"
          : "Migration completed with errors",
        stats: {
          totalAppointments: insertStats.totalRecords,
          batches: insertStats.totalBatches,
          successfulBatches: insertStats.successfulBatches,
          failedBatches: insertStats.failedBatches,
          insertedRecords: insertStats.insertedRecords,
          warnings: insertStats.warnings,
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
