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
 * POST /migrations/koibox/recibos
 * Migra recibos (ventas) desde Koibox API a la base de datos local
 */
router.post(
  "/recibos",
  validateBearerToken,
  validateClinicData,
  async (req, res) => {
    try {
      const { clinic, default: defaultValues = {} } = req.body;
      const bearerToken = req.bearerToken;

      console.log("\n========================================");
      console.log("Starting Koibox Sales (Recibos) Migration");
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
      // PASO 1: Mapear Pacientes (mapeo directo desde BD)
      // ==========================================
      console.log("\n→ Step 1: Loading patients from database...");

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
      // PASO 1.1: Preparar función para obtener y registrar pacientes faltantes
      // ==========================================
      console.log(
        "\n→ Step 1.1: Preparing patient fetch and registration function..."
      );

      // Función para obtener paciente de Koibox y registrarlo
      const fetchAndRegisterPatient = async (clienteId) => {
        try {
          console.log(`→ Fetching patient ${clienteId} from Koibox API...`);

          const patientResponse = await get(
            koiboxClient,
            `/clientes/clientes/${clienteId}/`
          );

          if (!patientResponse.success) {
            console.error(
              `✗ Failed to fetch patient ${clienteId} from Koibox API`
            );
            return null;
          }

          const patient = patientResponse.data;

          // Obtener filtros para mapear sexo y provincia
          const filtersResponse = await get(
            koiboxClient,
            "/clientes/clientes/filters/"
          );

          let idSexo = null;
          let ciudad = patient.localidad;
          let referido = null;

          if (filtersResponse.success) {
            const filters = filtersResponse.data;

            // Mapear sexo
            if (patient.sexo && filters.sexos) {
              const dbGenders = await query("SELECT * FROM sexo");
              const genderMapping = await mapData(
                "gender",
                filters.sexos,
                dbGenders
              );
              if (!genderMapping.error) {
                idSexo = genderMapping.mapper[patient.sexo.toString()] || null;
              }
            }

            // Mapear provincia para ciudad
            if (patient.provincia && filters.provincias) {
              const provinceMap = filters.provincias.reduce((acc, province) => {
                acc[province.id.toString()] = province.text;
                return acc;
              }, {});
              ciudad = provinceMap[patient.provincia.toString()] || patient.localidad;
            }

            // Mapear referido
            if (patient.como_nos_conocio && filters.como_nos_conocio) {
              const referralMap = filters.como_nos_conocio.reduce((acc, ref) => {
                acc[ref.value.toString()] = ref.text;
                return acc;
              }, {});
              referido = referralMap[patient.como_nos_conocio.toString()] || null;
            }
          }

          // Determinar estado de registro
          let idEstadoRegistro = 1; // Activo por defecto
          if (!patient.is_active) {
            idEstadoRegistro = 2; // Inactivo
          }

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

          // Preparar datos del paciente
          const patientData = {
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
          };

          // Insertar paciente en la BD
          const insertResult = await processBatches(
            "pacientes",
            [patientData],
            1
          );

          if (insertResult.insertedRecords > 0) {
            // Obtener el ID del paciente recién insertado
            const insertedPatient = await query(
              "SELECT id_paciente FROM pacientes WHERE old_id = ? AND id_clinica = ? AND id_super_clinica = ?",
              [patient.id, clinic.id_clinica, clinic.id_super_clinica]
            );

            if (insertedPatient.length > 0) {
              console.log(
                `✓ Patient ${clienteId} registered successfully with ID ${insertedPatient[0].id_paciente}`
              );
              return insertedPatient[0].id_paciente;
            }
          }

          console.error(`✗ Failed to insert patient ${clienteId}`);
          return null;
        } catch (error) {
          console.error(
            `✗ Error fetching/registering patient ${clienteId}:`,
            error.message
          );
          return null;
        }
      };

      // ==========================================
      // PASO 2: Obtener y mapear médicos con IA
      // ==========================================
      console.log("\n→ Step 2: Fetching and mapping doctors...");

      const allDoctorsResponse = await getAllPaginated(
        koiboxClient,
        `/main/users/?centro=${clinic.centro}`,
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

      // Obtener resultados de la API
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
      // PASO 3: Mapear tipos de IVA con IA
      // ==========================================
      console.log("\n→ Step 3: Fetching and mapping tax types...");

      const taxFormResponse = await get(koiboxClient, "/ventas/ventas/form/");

      if (!taxFormResponse.success) {
        return res.status(500).json({
          success: false,
          error: "KOIBOX_API_ERROR",
          message: "Failed to fetch tax form from Koibox",
          details: taxFormResponse.error,
        });
      }

      const apiTaxes = taxFormResponse.data.impuestos;

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
      // PASO 4: Procesar ventas con streaming
      // ==========================================
      console.log("\n→ Step 4: Fetching, transforming and inserting sales...");

      // Estadísticas globales
      const globalStats = {
        totalSales: 0,
        totalBatches: 0,
        successfulBatches: 0,
        failedBatches: 0,
        insertedRecibos: 0,
        insertedDetalles: 0,
        updatedCitas: 0,
        errors: [],
        warnings: {
          missingPatients: 0,
          missingDoctors: 0,
          missingTaxes: 0,
          failedDetails: 0,
          registeredPatients: 0,
        },
      };

      // Procesar cada página: obtener → obtener detalles → transformar → insertar
      const processingResult = await processPaginatedInBatches(
        koiboxClient,
        "/ventas/ventas/",
        async (sales, currentPage, totalPages) => {
          console.log(
            `\n→ Processing batch ${currentPage + 1}/${totalPages} (${
              sales.length
            } sales)...`
          );

          // ==========================================
          // PASO 4.1: Obtener detalles de cada venta (API 2)
          // ==========================================
          console.log(`→ Fetching details for ${sales.length} sales...`);

          const salesWithDetails = await Promise.all(
            sales.map(async (sale) => {
              try {
                const detailResponse = await get(
                  koiboxClient,
                  `/ventas/ventas/${sale.id}`
                );

                if (!detailResponse.success) {
                  console.warn(
                    `⚠ Warning: Failed to fetch details for sale ${sale.id}`
                  );
                  return { ...sale, lineas_venta: [], detailError: true };
                }

                return {
                  ...sale,
                  lineas_venta: detailResponse.data.lineas_venta || [],
                  cita: detailResponse.data.cita,
                };
              } catch (error) {
                console.warn(
                  `⚠ Warning: Error fetching details for sale ${sale.id}:`,
                  error.message
                );
                return { ...sale, lineas_venta: [], detailError: true };
              }
            })
          );

          console.log(`✓ Fetched details for ${salesWithDetails.length} sales`);

          // ==========================================
          // PASO 4.2: Transformar recibos
          // ==========================================
          const transformedRecibos = [];

          for (const sale of salesWithDetails) {
            // Mapear id_paciente desde old_id
            let idPaciente = sale.cliente?.value
              ? patientMapping[sale.cliente.value.toString()]
              : null;

            // Si no se encuentra el paciente, intentar obtenerlo de la API
            if (sale.cliente?.value && !idPaciente) {
              console.warn(
                `⚠ Warning: Patient not found for sale ${sale.id} (patient ID: ${sale.cliente.value}), attempting to fetch from API...`
              );

              idPaciente = await fetchAndRegisterPatient(sale.cliente.value);

              if (idPaciente) {
                // Actualizar el mapping para futuras referencias
                patientMapping[sale.cliente.value.toString()] = idPaciente;
                globalStats.warnings.registeredPatients++;
              } else {
                globalStats.warnings.missingPatients++;
                console.warn(
                  `✗ Could not fetch/register patient ${sale.cliente.value} for sale ${sale.id}, skipping...`
                );
                continue; // Skip this sale
              }
            }

            // Mapear id_medico desde mapper
            const idMedico = sale.assigned_to?.value
              ? doctorMapping.mapper[sale.assigned_to.value.toString()]
              : null;

            if (sale.assigned_to?.value && !idMedico) {
              globalStats.warnings.missingDoctors++;
              console.warn(
                `⚠ Warning: Doctor not found for sale ${sale.id} (doctor ID: ${sale.assigned_to.value})`
              );
            }

            // Combinar fecha + hora para fecha_recibo
            let fechaRecibo = null;
            if (sale.fecha) {
              const fecha = sale.fecha.split("T")[0];
              const hora =
                sale.fecha.split("T")[1]?.split(".")[0] || "00:00:00";
              fechaRecibo = `${fecha} ${hora}`;
            }

            transformedRecibos.push({
              id_cita: null, // Se establecerá si existe cita
              id_super_clinica: clinic.id_super_clinica,
              id_clinica: clinic.id_clinica,
              id_paciente: idPaciente,
              id_medico: idMedico || null,
              numero_recibo: sale.num_ticket || 0,
              forma_pago: sale.forma_pago?.text || "efectivo",
              fecha_recibo: fechaRecibo || null,
              monto_total: sale.total || 0,
              id_factura: null,
              old_id: sale.id,
              id_presupuesto: null,
              fecha_creacion: fechaRecibo || null,
              detalles_migracion: null,
              descontar_del_presupuesto: 0,
              // Metadata para procesar detalles después
              _lineas_venta: sale.lineas_venta,
              _cita_old_id: sale.cita,
            });
          }

          console.log(`✓ Transformed ${transformedRecibos.length} recibos`);

          if (transformedRecibos.length === 0) {
            console.log(`⚠ Skipping batch ${currentPage + 1}: no valid sales`);
            return;
          }

          // ==========================================
          // PASO 4.3: Insertar recibos
          // ==========================================
          console.log(`→ Inserting ${transformedRecibos.length} recibos...`);

          // Remover metadata antes de insertar
          const cleanRecibos = transformedRecibos.map(
            ({ _lineas_venta, _cita_old_id, ...recibo }) => recibo
          );

          const reciboStats = await processBatches(
            "recibos",
            cleanRecibos,
            100
          );

          // Acumular estadísticas
          globalStats.totalSales += reciboStats.totalRecords;
          globalStats.totalBatches += reciboStats.totalBatches;
          globalStats.successfulBatches += reciboStats.successfulBatches;
          globalStats.failedBatches += reciboStats.failedBatches;
          globalStats.insertedRecibos += reciboStats.insertedRecords;
          globalStats.errors.push(...reciboStats.errors);

          console.log(
            `✓ Recibos inserted: ${reciboStats.insertedRecords}/${reciboStats.totalRecords}`
          );

          // ==========================================
          // PASO 4.4: Obtener IDs de recibos recién insertados
          // ==========================================
          const oldIds = transformedRecibos.map((r) => r.old_id);
          const placeholders = oldIds.map(() => "?").join(",");

          const insertedRecibos = await query(
            `SELECT id_recibo, old_id FROM recibos
             WHERE old_id IN (${placeholders})
             AND id_clinica = ?
             AND id_super_clinica = ?`,
            [...oldIds, clinic.id_clinica, clinic.id_super_clinica]
          );

          // Crear mapeo old_id -> id_recibo
          const reciboIdMapping = {};
          insertedRecibos.forEach((recibo) => {
            reciboIdMapping[recibo.old_id] = recibo.id_recibo;
          });

          console.log(`✓ Found ${insertedRecibos.length} inserted recibos`);

          // ==========================================
          // PASO 4.5: Transformar e insertar detalles de recibos
          // ==========================================
          console.log("→ Processing sale details (lineas_venta)...");

          const allDetalles = [];

          transformedRecibos.forEach((recibo) => {
            const idRecibo = reciboIdMapping[recibo.old_id];

            if (!idRecibo) {
              console.warn(
                `⚠ Warning: Could not find id_recibo for old_id ${recibo.old_id}`
              );
              return;
            }

            // Transformar cada línea de venta
            recibo._lineas_venta.forEach((linea, index) => {
              // Determinar id_tratamiento o id_producto
              const idTratamiento = linea.servicio ? 9092 : null;
              const idProducto = linea.producto ? 521 : null;

              // Mapear id_tipo_iva
              const idTipoIva = linea.impuesto
                ? taxMapping.mapper[linea.impuesto.toString()]
                : null;

              if (linea.impuesto && !idTipoIva) {
                globalStats.warnings.missingTaxes++;
                console.warn(
                  `⚠ Warning: Tax not found for line ${linea.id} (tax ID: ${linea.impuesto})`
                );
              }

              // Calcular descuento (usar importe_descuento_moneda o valor_descuento)
              const descuento =
                linea.importe_descuento_moneda || linea.valor_descuento || 0;

              allDetalles.push({
                id_recibo: idRecibo,
                id_cita: null,
                id_tratamiento: idTratamiento,
                id_producto: idProducto,
                item: index + 1, // Orden de línea (1, 2, 3...)
                descripcion: linea.descripcion || "",
                cantidad: linea.cantidad || 1,
                precio: linea.precio || 0,
                descuento: descuento,
                id_tipo_iva: idTipoIva || null,
                total_item: linea.total || 0,
                old_id: linea.id,
              });
            });
          });

          console.log(`✓ Transformed ${allDetalles.length} sale details`);

          if (allDetalles.length > 0) {
            console.log(`→ Inserting ${allDetalles.length} detalle_recibo...`);

            const detalleStats = await processBatches(
              "detalle_recibo",
              allDetalles,
              100
            );

            globalStats.insertedDetalles += detalleStats.insertedRecords;

            if (detalleStats.failedBatches > 0) {
              globalStats.warnings.failedDetails += detalleStats.failedBatches;
            }

            console.log(
              `✓ Detalle_recibo inserted: ${detalleStats.insertedRecords}/${detalleStats.totalRecords}`
            );
          }

          // ==========================================
          // PASO 4.6: Actualizar citas con id_recibo
          // ==========================================
          console.log("→ Updating citas with id_recibo...");

          const citasToUpdate = transformedRecibos.filter(
            (recibo) => recibo._cita_old_id
          );

          if (citasToUpdate.length > 0) {
            for (const recibo of citasToUpdate) {
              const idRecibo = reciboIdMapping[recibo.old_id];

              if (!idRecibo) {
                continue;
              }

              try {
                const updateResult = await query(
                  `UPDATE citas
                   SET id_recibo = ?
                   WHERE old_id = ?
                   AND id_clinica = ?
                   AND id_super_clinica = ?`,
                  [
                    idRecibo,
                    recibo._cita_old_id,
                    clinic.id_clinica,
                    clinic.id_super_clinica,
                  ]
                );

                if (updateResult.affectedRows > 0) {
                  globalStats.updatedCitas++;
                }
              } catch (error) {
                console.warn(
                  `⚠ Warning: Failed to update cita ${recibo._cita_old_id}:`,
                  error.message
                );
              }
            }

            console.log(`✓ Updated ${globalStats.updatedCitas} citas`);
          }

          console.log(
            `✓ Batch ${currentPage + 1} completed: ${
              globalStats.insertedRecibos
            } recibos, ${globalStats.insertedDetalles} detalles`
          );
        },
        100 // Límite de 100 por página
      );

      if (!processingResult.success) {
        return res.status(500).json({
          success: false,
          error: "FETCH_SALES_ERROR",
          message: "Failed to fetch sales from Koibox",
          details: processingResult.error,
        });
      }

      console.log(
        `\n✓ All batches processed: ${globalStats.insertedRecibos} recibos, ${globalStats.insertedDetalles} detalles inserted`
      );

      const insertStats = globalStats;

      // ==========================================
      // PASO 5: Generar respuesta
      // ==========================================
      console.log("\n========================================");
      console.log("Migration Completed");
      console.log("========================================");
      console.log("Total Sales:", insertStats.totalSales);
      console.log("Successful Batches:", insertStats.successfulBatches);
      console.log("Failed Batches:", insertStats.failedBatches);
      console.log("Inserted Recibos:", insertStats.insertedRecibos);
      console.log("Inserted Detalles:", insertStats.insertedDetalles);
      console.log("Updated Citas:", insertStats.updatedCitas);
      console.log("Warnings:");
      console.log(
        "  - Missing Patients:",
        insertStats.warnings.missingPatients
      );
      console.log(
        "  - Registered Patients from API:",
        insertStats.warnings.registeredPatients
      );
      console.log("  - Missing Doctors:", insertStats.warnings.missingDoctors);
      console.log("  - Missing Taxes:", insertStats.warnings.missingTaxes);
      console.log("  - Failed Details:", insertStats.warnings.failedDetails);
      console.log("========================================\n");

      const success = insertStats.failedBatches === 0;

      return res.status(success ? 200 : 207).json({
        success,
        message: success
          ? "Migration completed successfully"
          : "Migration completed with errors",
        stats: {
          totalSales: insertStats.totalSales,
          batches: insertStats.totalBatches,
          successfulBatches: insertStats.successfulBatches,
          failedBatches: insertStats.failedBatches,
          insertedRecibos: insertStats.insertedRecibos,
          insertedDetalles: insertStats.insertedDetalles,
          updatedCitas: insertStats.updatedCitas,
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
