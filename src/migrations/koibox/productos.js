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
 * POST /migrations/koibox/productos
 * Migra productos desde Koibox API a la base de datos local
 */
router.post(
  "/productos",
  validateBearerToken,
  validateClinicData,
  async (req, res) => {
    try {
      const { clinic, default: defaultValues = {} } = req.body;
      const bearerToken = req.bearerToken;

      console.log("\n========================================");
      console.log("Starting Koibox Products Migration");
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
      // PASO 1: Obtener y mapear tipos de IVA
      // ==========================================
      console.log("→ Step 1: Fetching tax configuration from Koibox...");

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
      console.log("→ Fetching tax types from local database...");

      const dbTaxes = await query("SELECT * FROM tipo_iva");

      console.log(`✓ Found ${dbTaxes.length} tax types in local database`);

      // Mapear con IA
      console.log("→ Mapping tax types using AI...");

      const taxMapping = await mapData("tax", apiTaxes, dbTaxes);

      // Verificar si hay errores en el mapeo
      if (taxMapping.error) {
        return res.status(500).json({
          success: false,
          error: "TAX_MAPPING_ERROR",
          message: "AI mapping failed for tax types",
          details: taxMapping,
        });
      }

      // Verificar si hay elementos faltantes
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
      // PASO 2: Obtener productos paginados, transformar e insertar
      // ==========================================
      console.log("\n→ Step 2: Fetching, transforming and inserting products...");

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
        "/configuraciones/productos/",
        async (products, currentPage, totalPages) => {
          console.log(
            `\n→ Processing batch ${currentPage + 1}/${totalPages} (${
              products.length
            } products)...`
          );

          // Filtrar productos por centro
          const filteredProducts = products.filter((product) => {
            return product.centros && product.centros.includes(clinic.centro);
          });

          console.log(
            `✓ Filtered ${filteredProducts.length}/${products.length} products for centro ${clinic.centro}`
          );

          if (filteredProducts.length === 0) {
            console.log(`⚠ No products found for centro ${clinic.centro} in batch ${currentPage + 1}`);
            return;
          }

          // Transformar productos de esta página
          const transformedBatch = filteredProducts.map((product) => {
            // Determinar id_estado_registro basado en is_active y defaults
            let idEstadoRegistro = 1; // Por defecto: activo

            if (!product.is_active) {
              idEstadoRegistro = 2; // Inactivo
            }

            // Mapear id de impuesto usando el mapper de IA
            const idTipoIva = product.impuesto
              ? taxMapping.mapper[product.impuesto.toString()]
              : null;

            if (!idTipoIva && product.impuesto) {
              console.warn(
                `⚠ Warning: No tax mapping found for product ${product.id} (tax ID: ${product.impuesto})`
              );
            } else if (!product.impuesto) {
              console.warn(
                `⚠ Warning: Product ${product.id} has no tax ID (impuesto is null)`
              );
            }

            return {
              nombre_producto: product.nombre || null,
              descripcion: product.detalle || null,
              stock: product.stocks?.existencias || 0,
              precio: product.precio || 0,
              id_clinica: clinic.id_clinica,
              id_super_clinica: clinic.id_super_clinica,
              id_tipo_iva: idTipoIva || 1, // Default a 1 si no hay mapping
              id_estado_registro: idEstadoRegistro,
              codigo: product.ref || null,
              codigo_barras: product.barcode || null,
              proveedor: product.proveedor__nombre || null,
              precio_costo: product.precio_coste || 0,
              descuento: 0.0,
              old_id: product.id,
            };
          });

          console.log(`✓ Transformed ${transformedBatch.length} products`);

          // Insertar inmediatamente este lote en la BD
          console.log(`→ Inserting batch ${currentPage + 1} into database...`);

          const batchStats = await processBatches(
            "productos",
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
          error: "FETCH_PRODUCTS_ERROR",
          message: "Failed to fetch products from Koibox",
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
      console.log("Total Products:", insertStats.totalRecords);
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
          totalProducts: insertStats.totalRecords,
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
