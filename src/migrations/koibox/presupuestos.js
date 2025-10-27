const express = require("express");
const { createApiClient, get } = require("../../utils/api-client");
const { mapData } = require("../../services/ai-mapper.service");
const { query } = require("../../config/database");
const { processBatches } = require("../../services/batch.service");
const {
  validateBearerToken,
  validateClinicData,
} = require("../../middlewares/auth.middleware");

const router = express.Router();

/**
 * POST /migrations/koibox/presupuestos
 * Migra presupuestos desde Koibox API a la base de datos local
 * Si un presupuesto tiene venta asociada, también crea el recibo correspondiente
 */
router.post(
  "/presupuestos",
  validateBearerToken,
  validateClinicData,
  async (req, res) => {
    try {
      const { clinic, default: defaultValues = {} } = req.body;
      const bearerToken = req.bearerToken;

      console.log("\n========================================");
      console.log("Starting Koibox Budget (Presupuestos) Migration");
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
      // PASO 1: Cargar pacientes desde BD
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

      console.log(`✓ Loaded ${dbPatients.length} patients`);
      console.log(
        `  Patient mapper entries: ${Object.keys(patientMapping).length}`
      );

      // ==========================================
      // PASO 2: Mapear médicos con IA
      // ==========================================
      console.log("\n→ Step 2: Fetching and mapping doctors...");

      const allDoctorsResponse = await get(koiboxClient, `/main/users/?centro=${clinic.centro}`);

      if (!allDoctorsResponse.success) {
        return res.status(500).json({
          success: false,
          error: "FETCH_DOCTORS_ERROR",
          message: "Failed to fetch doctors from Koibox",
          details: allDoctorsResponse.error,
        });
      }

      // Obtener resultados de la API
      const apiDoctors = allDoctorsResponse.data.results.map((doctor) => {
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

      // ==========================================
      // PASO 4: Procesar presupuestos por paciente
      // ==========================================
      console.log("\n→ Step 4: Processing budgets by patient...");

      // Estadísticas globales
      const globalStats = {
        totalPatients: dbPatients.length,
        processedPatients: 0,
        totalBudgets: 0,
        budgetsWithVenta: 0,
        insertedPresupuestos: 0,
        insertedDetalles: 0,
        insertedRecibos: 0,
        insertedDetallesRecibo: 0,
        updatedCitas: 0,
        skippedBudgets: 0,
        errors: [],
        warnings: {
          missingPatients: 0,
          missingDoctors: 0,
          missingTaxes: 0,
          failedDetails: 0,
          failedVentasFetch: 0,
        },
      };

      // Procesar cada paciente
      for (let i = 0; i < dbPatients.length; i++) {
        const patient = dbPatients[i];
        const oldId = patient.old_id;

        if (!oldId) {
          console.warn(
            `⚠ Warning: Patient ${patient.id_paciente} has no old_id, skipping...`
          );
          continue;
        }

        console.log(
          `\n→ Processing patient ${i + 1}/${
            dbPatients.length
          } (old_id: ${oldId})...`
        );

        try {
          // ==========================================
          // PASO 4.1: Obtener presupuestos del paciente (con paginación)
          // ==========================================
          let allBudgets = [];
          let offset = 0;
          const limit = 100;
          let hasMore = true;

          while (hasMore) {
            const budgetResponse = await get(
              koiboxClient,
              `/ventas/presupuestos/?cliente=${oldId}&offset=${offset}&limit=${limit}`
            );

            if (!budgetResponse.success) {
              console.warn(
                `⚠ Warning: Failed to fetch budgets for patient ${oldId}`
              );
              globalStats.warnings.missingPatients++;
              break;
            }

            const { count, results } = budgetResponse.data;

            if (!results || results.length === 0) {
              break;
            }

            allBudgets = allBudgets.concat(results);

            // Verificar si hay más páginas
            offset += limit;
            hasMore = offset < count;

            console.log(
              `  Fetched ${allBudgets.length}/${count} budgets for patient ${oldId}`
            );
          }

          if (allBudgets.length === 0) {
            console.log(`  No budgets found for patient ${oldId}`);
            globalStats.processedPatients++;
            continue;
          }

          console.log(
            `✓ Found ${allBudgets.length} budgets for patient ${oldId}`
          );

          // ==========================================
          // PASO 4.2: Separar presupuestos con/sin venta
          // ==========================================
          const budgetsWithoutVenta = allBudgets.filter(
            (b) => b.venta === null
          );
          const budgetsWithVenta = allBudgets.filter((b) => b.venta !== null);

          console.log(`  Budgets without venta: ${budgetsWithoutVenta.length}`);
          console.log(`  Budgets with venta: ${budgetsWithVenta.length}`);

          globalStats.budgetsWithVenta += budgetsWithVenta.length;

          // ==========================================
          // PASO 4.3: Procesar presupuestos SIN venta
          // ==========================================
          if (budgetsWithoutVenta.length > 0) {
            console.log(
              `\n→ Processing ${budgetsWithoutVenta.length} budgets without venta...`
            );

            const transformedPresupuestos = budgetsWithoutVenta
              .map((budget) => {
                // Mapear id_paciente
                const idPaciente = patientMapping[oldId];

                if (!idPaciente) {
                  globalStats.warnings.missingPatients++;
                  console.warn(
                    `⚠ Warning: Patient mapping not found for old_id ${oldId}`
                  );
                  return null;
                }

                // Mapear id_medico desde created_by
                const idMedico = budget.created_by?.value
                  ? doctorMapping.mapper[budget.created_by.value.toString()]
                  : null;

                if (budget.created_by?.value && !idMedico) {
                  globalStats.warnings.missingDoctors++;
                  console.warn(
                    `⚠ Warning: Doctor not found for budget ${budget.id} (doctor ID: ${budget.created_by.value})`
                  );
                }

                // Formatear fecha
                let fecha = null;
                if (budget.fecha) {
                  fecha = budget.fecha.replace("T", " ").split(".")[0];
                }

                // Calcular saldo pendiente (total - pagado)
                const montoTotal = budget.total || 0;
                const montoPagado = 0; // Koibox no proporciona este dato
                const saldoPendiente = montoTotal - montoPagado;

                return {
                  id_paciente: idPaciente,
                  id_super_clinica: clinic.id_super_clinica,
                  id_clinica: clinic.id_clinica,
                  fecha: fecha,
                  fecha_vencimiento: null,
                  url_presupuesto: null,
                  monto_total: montoTotal,
                  monto_pagado: montoPagado,
                  saldo_pendiente: saldoPendiente,
                  id_estado: defaultValues.id_estado || 1,
                  id_tipo_pago: null,
                  id_medico: idMedico || null,
                  descripcion: budget.observaciones || null,
                  old_id: budget.id,
                  id_estado_registro: defaultValues.id_estado_registro || 1,
                  numero_historia: null,
                  id_contacto: null,
                  usuario_creacion: budget.created_by?.text || null,
                  id_usuario_creacion: budget.created_by?.value || null,
                  id_factura: null,
                  // Metadata
                  _lineas_presupuesto: budget.lineas_presupuesto || [],
                };
              })
              .filter(Boolean);

            // Insertar presupuestos sin venta
            if (transformedPresupuestos.length > 0) {
              const cleanPresupuestos = transformedPresupuestos.map(
                ({ _lineas_presupuesto, ...presupuesto }) => presupuesto
              );

              const presupuestoStats = await processBatches(
                "presupuestos",
                cleanPresupuestos,
                100
              );

              globalStats.totalBudgets += presupuestoStats.totalRecords;
              globalStats.insertedPresupuestos +=
                presupuestoStats.insertedRecords;
              globalStats.errors.push(...presupuestoStats.errors);

              console.log(
                `✓ Presupuestos inserted: ${presupuestoStats.insertedRecords}/${presupuestoStats.totalRecords}`
              );

              // Obtener IDs de presupuestos insertados
              const oldIds = transformedPresupuestos.map((p) => p.old_id);
              const placeholders = oldIds.map(() => "?").join(",");

              const insertedPresupuestos = await query(
                `SELECT id_presupuesto, old_id FROM presupuestos
                 WHERE old_id IN (${placeholders})
                 AND id_clinica = ?
                 AND id_super_clinica = ?`,
                [...oldIds, clinic.id_clinica, clinic.id_super_clinica]
              );

              const presupuestoIdMapping = {};
              insertedPresupuestos.forEach((presupuesto) => {
                presupuestoIdMapping[presupuesto.old_id] =
                  presupuesto.id_presupuesto;
              });

              // Insertar detalles de presupuestos
              const allDetalles = [];

              transformedPresupuestos.forEach((presupuesto) => {
                const idPresupuesto = presupuestoIdMapping[presupuesto.old_id];

                if (!idPresupuesto) {
                  console.warn(
                    `⚠ Warning: Could not find id_presupuesto for old_id ${presupuesto.old_id}`
                  );
                  return;
                }

                presupuesto._lineas_presupuesto.forEach((linea, index) => {
                  const idTratamiento = linea.servicio ? 9092 : null;
                  const idProducto = linea.producto ? 521 : null;

                  const idTipoIva = linea.impuesto
                    ? taxMapping.mapper[linea.impuesto.toString()]
                    : null;

                  if (linea.impuesto && !idTipoIva) {
                    globalStats.warnings.missingTaxes++;
                  }

                  const descuento =
                    linea.importe_descuento_moneda ||
                    linea.valor_descuento ||
                    0;

                  allDetalles.push({
                    id_presupuesto: idPresupuesto,
                    id_tratamiento: idTratamiento,
                    item: index + 1,
                    descripcion: linea.descripcion || "",
                    cantidad: linea.cantidad || 1,
                    precio: linea.precio || 0,
                    descuento: descuento,
                    id_tipo_iva: idTipoIva || null,
                    total_item: linea.total || 0,
                    id_producto: idProducto,
                    old_id: linea.id,
                  });
                });
              });

              if (allDetalles.length > 0) {
                const detalleStats = await processBatches(
                  "detalle_presupuesto",
                  allDetalles,
                  100
                );

                globalStats.insertedDetalles += detalleStats.insertedRecords;

                if (detalleStats.failedBatches > 0) {
                  globalStats.warnings.failedDetails +=
                    detalleStats.failedBatches;
                }

                console.log(
                  `✓ Detalle_presupuesto inserted: ${detalleStats.insertedRecords}/${detalleStats.totalRecords}`
                );
              }
            }
          }

          // ==========================================
          // PASO 4.4: Procesar presupuestos CON venta
          // ==========================================
          if (budgetsWithVenta.length > 0) {
            console.log(
              `\n→ Processing ${budgetsWithVenta.length} budgets WITH venta...`
            );

            for (const budget of budgetsWithVenta) {
              try {
                // ==========================================
                // VALIDACIÓN: Verificar si la venta ya está migrada
                // ==========================================
                console.log(
                  `  → Checking if venta ${budget.venta} is already migrated...`
                );

                const [existingRecibo] = await query(
                  `SELECT id_recibo FROM recibos
                   WHERE old_id = ?
                   AND id_clinica = ?
                   AND id_super_clinica = ?`,
                  [budget.venta, clinic.id_clinica, clinic.id_super_clinica]
                );

                if (existingRecibo) {
                  console.log(
                    `  ⊗ Budget ${budget.id} skipped: venta ${budget.venta} already migrated (recibo ${existingRecibo.id_recibo})`
                  );
                  globalStats.skippedBudgets++;
                  continue;
                }

                console.log(
                  `  → Fetching venta details for budget ${budget.id}...`
                );

                // Obtener detalles de la venta
                const ventaResponse = await get(
                  koiboxClient,
                  `/ventas/ventas/?cliente__id__exact=${oldId}&detail=true`
                );

                if (!ventaResponse.success) {
                  console.warn(
                    `⚠ Warning: Failed to fetch venta for budget ${budget.id}`
                  );
                  globalStats.warnings.failedVentasFetch++;
                  continue;
                }

                const ventas = ventaResponse.data.results || [];

                // Buscar la venta que corresponde a este presupuesto
                const venta = ventas.find((v) => v.id === budget.venta);

                if (!venta) {
                  console.warn(
                    `⚠ Warning: Venta ${budget.venta} not found for budget ${budget.id}`
                  );
                  globalStats.warnings.failedVentasFetch++;
                  continue;
                }

                console.log(
                  `  ✓ Found venta ${venta.id} for budget ${budget.id}`
                );

                // ==========================================
                // PASO 4.4.1: Insertar presupuesto
                // ==========================================
                const idPaciente = patientMapping[oldId];

                if (!idPaciente) {
                  globalStats.warnings.missingPatients++;
                  continue;
                }

                const idMedico = budget.created_by?.value
                  ? doctorMapping.mapper[budget.created_by.value.toString()]
                  : null;

                let fecha = null;
                if (budget.fecha) {
                  fecha = budget.fecha.replace("T", " ").split(".")[0];
                }

                const montoTotal = budget.total || 0;
                const montoPagado = venta.total || 0;
                const saldoPendiente = montoTotal - montoPagado;

                const presupuestoData = {
                  id_paciente: idPaciente,
                  id_super_clinica: clinic.id_super_clinica,
                  id_clinica: clinic.id_clinica,
                  fecha: fecha,
                  fecha_vencimiento: null,
                  url_presupuesto: null,
                  monto_total: montoTotal,
                  monto_pagado: montoPagado,
                  saldo_pendiente: saldoPendiente,
                  id_estado: defaultValues.id_estado || 1,
                  id_tipo_pago: budget.venta !== null ? 1 : null,
                  id_medico: idMedico || null,
                  descripcion: budget.observaciones || null,
                  old_id: budget.id,
                  id_estado_registro: defaultValues.id_estado_registro || 1,
                  numero_historia: null,
                  id_contacto: null,
                  fecha_creacion: fecha,
                  usuario_creacion: budget.created_by?.text || null,
                  id_usuario_creacion: budget.created_by?.value || null,
                  id_factura: null,
                };

                const presupuestoStats = await processBatches(
                  "presupuestos",
                  [presupuestoData],
                  1
                );

                globalStats.totalBudgets++;
                globalStats.insertedPresupuestos +=
                  presupuestoStats.insertedRecords;

                // Obtener ID del presupuesto insertado
                const [insertedPresupuesto] = await query(
                  `SELECT id_presupuesto FROM presupuestos
                   WHERE old_id = ?
                   AND id_clinica = ?
                   AND id_super_clinica = ?`,
                  [budget.id, clinic.id_clinica, clinic.id_super_clinica]
                );

                if (!insertedPresupuesto) {
                  console.warn(
                    `⚠ Warning: Could not find inserted presupuesto for budget ${budget.id}`
                  );
                  continue;
                }

                const idPresupuesto = insertedPresupuesto.id_presupuesto;

                // Insertar detalles del presupuesto
                const detallesPresupuesto = [];

                (budget.lineas_presupuesto || []).forEach((linea, index) => {
                  const idTratamiento = linea.servicio ? 9092 : null;
                  const idProducto = linea.producto ? 521 : null;

                  const idTipoIva = linea.impuesto
                    ? taxMapping.mapper[linea.impuesto.toString()]
                    : null;

                  const descuento =
                    linea.importe_descuento_moneda ||
                    linea.valor_descuento ||
                    0;

                  detallesPresupuesto.push({
                    id_presupuesto: idPresupuesto,
                    id_tratamiento: idTratamiento,
                    item: index + 1,
                    descripcion: linea.descripcion || "",
                    cantidad: linea.cantidad || 1,
                    precio: linea.precio || 0,
                    descuento: descuento,
                    id_tipo_iva: idTipoIva || null,
                    total_item: linea.total || 0,
                    id_producto: idProducto,
                    old_id: linea.id,
                  });
                });

                if (detallesPresupuesto.length > 0) {
                  const detallePresupuestoStats = await processBatches(
                    "detalle_presupuesto",
                    detallesPresupuesto,
                    100
                  );

                  globalStats.insertedDetalles +=
                    detallePresupuestoStats.insertedRecords;
                }

                // ==========================================
                // PASO 4.4.2: Insertar recibo vinculado
                // ==========================================
                console.log(`  → Creating recibo for venta ${venta.id}...`);

                const idMedicoRecibo = venta.assigned_to?.value
                  ? doctorMapping.mapper[venta.assigned_to.value.toString()]
                  : null;

                let fechaRecibo = null;
                if (venta.fecha) {
                  const fecha = venta.fecha.split("T")[0];
                  const hora =
                    venta.fecha.split("T")[1]?.split(".")[0] || "00:00:00";
                  fechaRecibo = `${fecha} ${hora}`;
                }

                const reciboData = {
                  id_cita: null,
                  id_super_clinica: clinic.id_super_clinica,
                  id_clinica: clinic.id_clinica,
                  id_paciente: idPaciente,
                  id_medico: idMedicoRecibo || null,
                  numero_recibo: venta.num_ticket || 0,
                  forma_pago: venta.forma_pago?.text || "efectivo",
                  fecha_recibo: fechaRecibo || null,
                  monto_total: venta.total || 0,
                  id_factura: null,
                  old_id: venta.id,
                  id_presupuesto: idPresupuesto, // VINCULACIÓN CON PRESUPUESTO
                  fecha_creacion: fechaRecibo || null,
                  detalles_migracion: null,
                  descontar_del_presupuesto: 0,
                };

                const reciboStats = await processBatches(
                  "recibos",
                  [reciboData],
                  1
                );

                globalStats.insertedRecibos += reciboStats.insertedRecords;

                // Obtener ID del recibo insertado
                const [insertedRecibo] = await query(
                  `SELECT id_recibo FROM recibos
                   WHERE old_id = ?
                   AND id_clinica = ?
                   AND id_super_clinica = ?`,
                  [venta.id, clinic.id_clinica, clinic.id_super_clinica]
                );

                if (!insertedRecibo) {
                  console.warn(
                    `⚠ Warning: Could not find inserted recibo for venta ${venta.id}`
                  );
                  continue;
                }

                const idRecibo = insertedRecibo.id_recibo;

                // Insertar detalles del recibo
                const detallesRecibo = [];

                (venta.lineas_venta || []).forEach((linea, index) => {
                  const idTratamiento = linea.servicio ? 9092 : null;
                  const idProducto = linea.producto ? 521 : null;

                  const idTipoIva = linea.impuesto
                    ? taxMapping.mapper[linea.impuesto.toString()]
                    : null;

                  const descuento =
                    linea.importe_descuento_moneda ||
                    linea.valor_descuento ||
                    0;

                  detallesRecibo.push({
                    id_recibo: idRecibo,
                    id_cita: null,
                    id_tratamiento: idTratamiento,
                    id_producto: idProducto,
                    item: index + 1,
                    descripcion: linea.descripcion || "",
                    cantidad: linea.cantidad || 1,
                    precio: linea.precio || 0,
                    descuento: descuento,
                    id_tipo_iva: idTipoIva || null,
                    total_item: linea.total || 0,
                    old_id: linea.id,
                  });
                });

                if (detallesRecibo.length > 0) {
                  const detalleReciboStats = await processBatches(
                    "detalle_recibo",
                    detallesRecibo,
                    100
                  );

                  globalStats.insertedDetallesRecibo +=
                    detalleReciboStats.insertedRecords;
                }

                console.log(
                  `  ✓ Created recibo ${idRecibo} linked to presupuesto ${idPresupuesto}`
                );
              } catch (error) {
                console.error(
                  `✗ Error processing budget with venta ${budget.id}:`,
                  error.message
                );
                globalStats.errors.push({
                  budget_id: budget.id,
                  venta_id: budget.venta,
                  error: error.message,
                });
              }
            }
          }

          globalStats.processedPatients++;
          console.log(`✓ Patient ${i + 1}/${dbPatients.length} completed`);
        } catch (error) {
          console.error(`✗ Error processing patient ${oldId}:`, error.message);
          globalStats.errors.push({
            patient_old_id: oldId,
            error: error.message,
          });
        }
      }

      // ==========================================
      // PASO 5: Generar respuesta
      // ==========================================
      console.log("\n========================================");
      console.log("Migration Completed");
      console.log("========================================");
      console.log("Total Patients:", globalStats.totalPatients);
      console.log("Processed Patients:", globalStats.processedPatients);
      console.log("Total Budgets:", globalStats.totalBudgets);
      console.log("Budgets with Venta:", globalStats.budgetsWithVenta);
      console.log("Inserted Presupuestos:", globalStats.insertedPresupuestos);
      console.log(
        "Inserted Detalles Presupuesto:",
        globalStats.insertedDetalles
      );
      console.log("Inserted Recibos:", globalStats.insertedRecibos);
      console.log(
        "Inserted Detalles Recibo:",
        globalStats.insertedDetallesRecibo
      );
      console.log("Updated Citas:", globalStats.updatedCitas);
      console.log("Warnings:");
      console.log(
        "  - Missing Patients:",
        globalStats.warnings.missingPatients
      );
      console.log("  - Missing Doctors:", globalStats.warnings.missingDoctors);
      console.log("  - Missing Taxes:", globalStats.warnings.missingTaxes);
      console.log("  - Failed Details:", globalStats.warnings.failedDetails);
      console.log(
        "  - Failed Ventas Fetch:",
        globalStats.warnings.failedVentasFetch
      );
      console.log("========================================\n");

      const success = globalStats.errors.length === 0;

      return res.status(success ? 200 : 207).json({
        success,
        message: success
          ? "Migration completed successfully"
          : "Migration completed with errors",
        stats: {
          totalPatients: globalStats.totalPatients,
          processedPatients: globalStats.processedPatients,
          totalBudgets: globalStats.totalBudgets,
          budgetsWithVenta: globalStats.budgetsWithVenta,
          insertedPresupuestos: globalStats.insertedPresupuestos,
          insertedDetalles: globalStats.insertedDetalles,
          insertedRecibos: globalStats.insertedRecibos,
          insertedDetallesRecibo: globalStats.insertedDetallesRecibo,
          updatedCitas: globalStats.updatedCitas,
          warnings: globalStats.warnings,
        },
        errors: globalStats.errors,
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
