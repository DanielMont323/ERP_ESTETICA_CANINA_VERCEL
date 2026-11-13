require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const productoRoutes = require('./routes/productos');
const clienteRoutes = require('./routes/clientes');
const mascotaRoutes = require('./routes/mascotas');
const servicioRoutes = require('./routes/servicios');
const ventaRoutes = require('./routes/ventas');
const proveedorRoutes = require('./routes/proveedores');
const compraRoutes = require('./routes/compras');
const cuentaPorPagarRoutes = require('./routes/cuentasPorPagar');
const costoRoutes = require('./routes/costos');
const recordatorioRoutes = require('./routes/recordatorios');
const reportRoutes = require('./routes/reports');
const supplierProductRoutes = require('./routes/supplierProducts');
const categoriaProductoRoutes = require('./routes/categoriasProducto');
const carnetVacunacionRoutes = require('./routes/carnetVacunacion');
const categoriaServicioRoutes = require('./routes/categoriasServicio');
const vacunaRoutes = require('./routes/vacunas');
const clasificacionVacunaRoutes = require('./routes/clasificacionesVacunas');
const inventarioRoutes = require('./routes/inventario');

// Import middleware
const { authenticateToken, requireAdmin } = require('./middleware/auth');

// Conectar a la base de datos
connectDB();

const app = express();

// Middleware
// CORS: solo la app del ERP puede llamar a la API desde un navegador (antes se aceptaba cualquier sitio).
// - Frontend en Vercel: erp-estetica-canina-vercel*.vercel.app (producción y vistas previas)
// - Desarrollo local: localhost / 127.0.0.1
// - Otros dominios (p. ej. uno propio): variable CORS_ORIGINS separada por comas
// Las peticiones sin Origin (scripts, curl) no pasan por CORS; las protege el token.
const ORIGENES_EXTRA = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const origenPermitido = origin =>
  /^https:\/\/erp-estetica-canina-vercel[a-z0-9-]*\.vercel\.app$/.test(origin) ||
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
  ORIGENES_EXTRA.includes(origin);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    callback(null, origenPermitido(origin));
  },
  credentials: true
};
app.use(cors(corsOptions));

// Encabezados básicos de seguridad (sin dependencias nuevas)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '1mb' }));

// Routes
// S2: toda la API exige token, excepto /api/auth y /api/health.
app.use('/api/auth', authRoutes);
app.use('/api/productos', authenticateToken, productoRoutes);
app.use('/api/clientes', authenticateToken, clienteRoutes);
app.use('/api/mascotas', authenticateToken, mascotaRoutes);
app.use('/api/servicios', authenticateToken, servicioRoutes);
app.use('/api/ventas', authenticateToken, ventaRoutes);
app.use('/api/proveedores', authenticateToken, proveedorRoutes);
app.use('/api/compras', authenticateToken, compraRoutes);
app.use('/api/cuentas-por-pagar', authenticateToken, cuentaPorPagarRoutes);
app.use('/api/costos', authenticateToken, costoRoutes);
app.use('/api/recordatorios', authenticateToken, recordatorioRoutes);
app.use('/api/reports', authenticateToken, reportRoutes);
app.use('/api/supplier-products', authenticateToken, supplierProductRoutes);
app.use('/api/categorias-producto', authenticateToken, categoriaProductoRoutes);
app.use('/api/carnet-vacunacion', authenticateToken, carnetVacunacionRoutes);
app.use('/api/categorias-servicio', authenticateToken, categoriaServicioRoutes);
app.use('/api/vacunas', authenticateToken, vacunaRoutes);
app.use('/api/clasificaciones-vacunas', authenticateToken, clasificacionVacunaRoutes);
app.use('/api/inventario', authenticateToken, inventarioRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    success: false, 
    message: 'Error interno del servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Ruta API no encontrada' 
  });
});

const PORT = process.env.PORT || 5000;

// Only start the server if not running in Vercel environment
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
