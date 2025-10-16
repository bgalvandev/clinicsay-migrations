require("dotenv").config();
const app = require("./src/app");
const { testConnection: testDbConnection } = require("./src/config/database");
const { testConnection: testOpenAIConnection } = require("./src/config/openai");

const PORT = process.env.PORT || 3000;

/**
 * Inicializa el servidor y verifica conexiones
 */
async function startServer() {
  console.log("\n========================================");
  console.log("ClinicSay Migrations API");
  console.log("========================================\n");

  try {
    // Verificar conexión a la base de datos
    console.log("Checking database connection...");
    const dbConnected = await testDbConnection();

    if (!dbConnected) {
      console.error(
        "\n✗ Failed to connect to database. Please check your configuration."
      );
      process.exit(1);
    }

    // Verificar conexión a OpenAI API
    console.log("\nChecking OpenAI API connection...");
    const openAIConnected = await testOpenAIConnection();

    if (!openAIConnected) {
      console.warn(
        "\n⚠ Warning: Failed to connect to OpenAI API. AI mapping features will not work."
      );
    }

    // Iniciar servidor
    console.log("\n========================================");
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`✓ API URL: http://localhost:${PORT}`);
      console.log("========================================\n");
      console.log("Available endpoints:");
      console.log("  GET  /");
      console.log("  GET  /health");
      console.log("  POST /migrations/koibox/productos");
      console.log("  POST /migrations/koibox/pacientes");
      console.log("  POST /migrations/koibox/citas");
      console.log("  POST /migrations/koibox/recibos");
      console.log("  POST /migrations/koibox/encuestas");
      console.log("  POST /migrations/koibox/presupuestos");
      console.log("\n========================================\n");
    });
  } catch (error) {
    console.error("\n✗ Failed to start server:", error);
    process.exit(1);
  }
}

// Manejo de errores no capturados
process.on("unhandledRejection", (error) => {
  console.error("Unhandled Promise Rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

// Iniciar servidor
startServer();
