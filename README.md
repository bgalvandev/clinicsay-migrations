# ClinicSay Migrations API

Sistema de migraciones multiplataforma para sincronizar datos de APIs externas hacia una base de datos unificada, con mapeo inteligente usando IA.

## Características

- **Migraciones multiplataforma**: Estructura modular para soportar múltiples plataformas
- **Mapeo inteligente con IA**: Utiliza OpenAI para mapear automáticamente datos entre sistemas
- **Procesamiento por lotes**: Maneja grandes volúmenes de datos eficientemente
- **Paginación automática**: Obtiene datos paginados de APIs externas
- **Transacciones seguras**: Cada lote se inserta con transacciones para integridad de datos
- **Manejo robusto de errores**: Continúa procesando lotes incluso si algunos fallan

## Requisitos

- Node.js >= 14.x
- MySQL >= 5.7
- Cuenta de OpenAI con API Key

## Instalación

1. Clonar el repositorio:
```bash
git clone <repository-url>
cd clinicsay-migrations
```

2. Instalar dependencias:
```bash
npm install
```

3. Configurar variables de entorno:
```bash
cp .env.example .env
```

4. Editar `.env` con tus credenciales:
```env
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tu_password
DB_DATABASE=mydb
OPENAI_API_KEY=sk-tu_api_key
KOIBOX_API=https://api.koibox.cloud
```

## Estructura del Proyecto

```
clinicsay-migrations/
├── src/
│   ├── config/
│   │   ├── database.js          # Configuración MySQL
│   │   └── openai.js            # Configuración OpenAI
│   ├── services/
│   │   ├── ai-mapper.service.js # Servicio de mapeo con IA
│   │   └── batch.service.js     # Procesamiento por lotes
│   ├── migrations/
│   │   └── koibox/
│   │       ├── productos.js     # Migración de productos
│   │       ├── pacientes.js     # Migración de pacientes
│   │       └── index.js
│   ├── middlewares/
│   │   ├── auth.middleware.js   # Validación de tokens
│   │   └── error.middleware.js  # Manejo de errores
│   ├── utils/
│   │   └── api-client.js        # Cliente HTTP
│   └── app.js                   # Configuración Express
├── .env.example
├── package.json
└── server.js
```

## Uso

### Iniciar el servidor

```bash
npm start
```

Para desarrollo con auto-reload:
```bash
npm run dev
```

El servidor se iniciará en `http://localhost:3000`

### Endpoints Disponibles

#### Health Check
```bash
GET /
GET /health
```

#### Migrar Productos de Koibox

```bash
POST /migrations/koibox/productos
```

**Headers:**
```
Authorization: Bearer {KOIBOX_TOKEN}
Content-Type: application/json
```

**Body:**
```json
{
  "clinic": {
    "id_clinica": 64,
    "id_super_clinica": 48
  },
  "default": {
    "is_archived": 0
  }
}
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "message": "Migration completed successfully",
  "stats": {
    "totalProducts": 327,
    "batches": 4,
    "successfulBatches": 4,
    "failedBatches": 0,
    "insertedRecords": 327
  },
  "errors": []
}
```

#### Migrar Pacientes de Koibox

```bash
POST /migrations/koibox/pacientes
```

**Headers:**
```
Authorization: Bearer {KOIBOX_TOKEN}
Content-Type: application/json
```

**Body:**
```json
{
  "clinic": {
    "id_clinica": 64,
    "id_super_clinica": 48
  },
  "default": {
    "is_archived": 0
  }
}
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "message": "Migration completed successfully",
  "stats": {
    "totalPatients": 1250,
    "batches": 13,
    "successfulBatches": 13,
    "failedBatches": 0,
    "insertedRecords": 1250
  },
  "errors": []
}
```

## Cómo Funciona

### Flujo de Migración de Productos Koibox

1. **Validación**: Verifica Bearer token y datos de clínica
2. **Mapeo de Impuestos**:
   - Obtiene configuración de impuestos de Koibox API
   - Consulta tipos de IVA en BD local
   - Usa IA para mapear correspondencias
   - Detiene si hay impuestos sin correspondencia
3. **Procesamiento Streaming** (eficiente en memoria):
   - Obtiene página de productos (100 registros)
   - Transforma datos al formato de BD local
   - Inserta inmediatamente en BD con transacciones
   - Repite para la siguiente página
   - **No acumula datos en memoria**, procesa lote por lote

### Flujo de Migración de Pacientes Koibox

1. **Validación**: Verifica Bearer token y datos de clínica
2. **Mapeo de Datos con IA** (3 mapeos):
   - **Sexo**: Mapea tipos de género desde filtros API con tabla `sexo` de BD
   - **Ciudad/Provincia**: Obtiene provincias de filtros API y crea mapper directo ID → Nombre
   - **Referido**: Mapea fuentes de referencia (como_nos_conocio) ID → Nombre
   - Detiene si hay géneros sin correspondencia (ciudad y referido son opcionales)
3. **Procesamiento Streaming** (eficiente en memoria):
   - Obtiene página de pacientes (100 registros)
   - Transforma datos al formato de BD local:
     - Concatena apellido1 + apellido2
     - Formatea teléfono con prefijo +34
     - Mapea ciudad desde provincia
     - Mapea referido desde como_nos_conocio
     - Concatena notas + informacion_clinica en observaciones
   - Inserta inmediatamente en BD con transacciones
   - Repite para la siguiente página
   - **No acumula datos en memoria**, procesa lote por lote

### Servicio de Mapeo con IA

El servicio de IA (`ai-mapper.service.js`) utiliza OpenAI para establecer correspondencias inteligentes entre datos:

**Entrada:**
```json
{
  "apiResult": [
    { "id": 1, "nombre": "IVA 21%", "porcentaje": 21 }
  ],
  "dbResult": [
    { "id_tipo_iva": 1, "nombre": "IVA General", "valor": 21.00 }
  ]
}
```

**Salida:**
```json
{
  "mapper": {
    "1": 1
  },
  "missing": []
}
```

El resultado se guarda en cache para evitar llamadas repetitivas a OpenAI.

## Agregar Nuevas Migraciones

### Para una nueva entidad en Koibox:

1. Crear archivo en `src/migrations/koibox/`:
```javascript
// src/migrations/koibox/clientes.js
const express = require('express');
const router = express.Router();

router.post('/clientes', async (req, res) => {
  // Implementar lógica de migración
});

module.exports = router;
```

2. Registrar en `src/migrations/koibox/index.js`:
```javascript
const clientesRouter = require('./clientes');
router.use('/', clientesRouter);
```

### Para una nueva plataforma:

1. Crear directorio: `src/migrations/nueva-plataforma/`
2. Agregar `.env`: `NUEVA_PLATAFORMA_API=https://api.example.com`
3. Registrar en `src/app.js`:
```javascript
app.use('/migrations/nueva-plataforma', nuevaPlataformaRoutes);
```

## Seguridad

- Todas las queries usan prepared statements para prevenir SQL injection
- Bearer token requerido para todas las migraciones
- Headers de seguridad con Helmet
- Variables sensibles en `.env` (no committed)

## Optimizaciones

- **Procesamiento Streaming**: Procesa e inserta datos por lotes inmediatamente, sin acumular en memoria
- **Pool de conexiones MySQL**: Maneja múltiples requests concurrentes eficientemente
- **Cache de mapeos**: Evita llamadas repetitivas a OpenAI durante toda la sesión
- **Bulk inserts**: Inserta múltiples registros en una sola query con transacciones
- **Paginación eficiente**: Obtiene → Transforma → Inserta → Libera memoria → Repite

## Logs

El sistema proporciona logs detallados en consola:

```
========================================
Starting Koibox Products Migration
========================================
→ Step 1: Fetching tax configuration...
✓ Found 7 tax types in Koibox API
✓ Found 3 tax types in local database
→ Mapping tax types using AI...
✓ Tax mapping completed successfully

→ Step 2: Fetching, transforming and inserting products...

→ Processing batch 1/4 (100 products)...
✓ Transformed 100 products
→ Inserting batch 1 into database...
✓ Batch 1 completed: 100 records inserted
✓ Batch 1 completed: 100/100 records inserted

→ Processing batch 2/4 (100 products)...
✓ Transformed 100 products
→ Inserting batch 2 into database...
✓ Batch 2 completed: 100/100 records inserted
...

✓ All batches processed: 327/327 total records inserted
========================================
Migration Completed
========================================
```

## Manejo de Errores

El sistema maneja varios tipos de errores:

- **Errores de API externa**: Registra y continúa con otros lotes
- **Errores de BD**: Rollback de transacción y continúa
- **Errores de mapeo**: Detiene la migración y reporta elementos faltantes
- **Errores de IA**: Registra error y permite retry manual

## Contribuir

1. Fork el proyecto
2. Crear branch (`git checkout -b feature/nueva-funcionalidad`)
3. Commit cambios (`git commit -m 'Agregar nueva funcionalidad'`)
4. Push al branch (`git push origin feature/nueva-funcionalidad`)
5. Crear Pull Request

## Licencia

ISC

## Autor

Bruno Galvan
