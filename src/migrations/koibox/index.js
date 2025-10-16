const express = require("express");
const productosRouter = require("./productos");
const pacientesRouter = require("./pacientes");
const citasRouter = require("./citas");
const recibosRouter = require("./recibos");
const encuestasRouter = require("./encuestas");
const presupuestosRouter = require("./presupuestos");

const router = express.Router();

// Montar rutas de migraciones
router.use("/", productosRouter);
router.use("/", pacientesRouter);
router.use("/", citasRouter);
router.use("/", recibosRouter);
router.use("/", encuestasRouter);
router.use("/", presupuestosRouter);

// Aquí se pueden agregar más rutas de migración para Koibox
// router.use('/', categoriasRouter);
// router.use('/', serviciosRouter);
// etc...

module.exports = router;
