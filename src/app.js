const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

// Importar rutas de migraciones
const koiboxRoutes = require('./migrations/koibox');

const app = express();

// ==========================================
// Middlewares globales
// ==========================================

// Seguridad
app.use(helmet());

// CORS
app.use(cors());

// Logging de requests
app.use(morgan('combined'));

// Parser de JSON
app.use(express.json());

// Parser de URL encoded
app.use(express.urlencoded({ extended: true }));

// ==========================================
// Rutas
// ==========================================

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ClinicSay Migrations API',
    version: '1.0.0',
    status: 'running'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Rutas de migraciones por plataforma
app.use('/migrations/koibox', koiboxRoutes);

// Aquí se pueden agregar más plataformas en el futuro
// app.use('/migrations/otra-plataforma', otraPlataformaRoutes);

// ==========================================
// Manejo de errores
// ==========================================

// Ruta no encontrada
app.use(notFoundHandler);

// Manejo de errores globales
app.use(errorHandler);

module.exports = app;
