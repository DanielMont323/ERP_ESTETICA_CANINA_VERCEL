const express = require('express');
const jwt = require('jsonwebtoken');
const Usuario = require('../models/Usuario');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// Duración de la sesión: una jornada de trabajo (antes 30 días)
const DURACION_SESION = '12h';
// Bloqueo por intentos fallidos
const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;
// Límite adicional por dirección IP (mejor esfuerzo: en Vercel cada instancia lleva su propia cuenta)
const MAX_INTENTOS_IP = 30;
const VENTANA_IP_MS = 15 * 60 * 1000;
const intentosPorIp = new Map();
const MIN_LONGITUD_PASSWORD = 8;

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: DURACION_SESION });

const usuarioPublico = user => ({ id: user._id, name: user.name, email: user.email, role: user.role });

const validarPassword = password => {
  if (typeof password !== 'string' || password.length < MIN_LONGITUD_PASSWORD) {
    return `La contraseña debe tener al menos ${MIN_LONGITUD_PASSWORD} caracteres`;
  }
  return null;
};

const ipDe = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'desconocida';

function ipBloqueada(ip) {
  const ahora = Date.now();
  const r = intentosPorIp.get(ip);
  if (!r || ahora - r.inicio > VENTANA_IP_MS) return false;
  return r.n >= MAX_INTENTOS_IP;
}
function registrarFalloIp(ip) {
  const ahora = Date.now();
  const r = intentosPorIp.get(ip);
  if (!r || ahora - r.inicio > VENTANA_IP_MS) intentosPorIp.set(ip, { inicio: ahora, n: 1 });
  else r.n += 1;
  if (intentosPorIp.size > 5000) intentosPorIp.clear(); // evita crecer sin límite
}

// @route   POST /api/auth/register
// @desc    Crear usuario. Solo un administrador (antes era público: cualquiera podía crearse una cuenta).
//          No inicia sesión con el usuario nuevo; el administrador sigue en su sesión.
router.post('/register', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Nombre y correo son obligatorios' });
    }
    const errorPassword = validarPassword(password);
    if (errorPassword) return res.status(400).json({ success: false, message: errorPassword });
    if (role !== undefined && !['admin', 'user'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Rol inválido' });
    }

    const correo = String(email).trim().toLowerCase();
    if (await Usuario.findOne({ email: correo })) {
      return res.status(400).json({ success: false, message: 'Ya existe un usuario con ese correo' });
    }

    const user = await Usuario.create({ name, email: correo, password, role: role || 'user' });
    res.status(201).json({ success: true, data: usuarioPublico(user) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: Object.values(error.errors).map(e => e.message).join(', ') });
    }
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al crear usuario' });
  }
});

// @route   POST /api/auth/login
// @desc    Iniciar sesión. Tras 5 intentos fallidos la cuenta se bloquea 15 minutos.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Por favor ingresa email y contraseña' });
    }

    const ip = ipDe(req);
    if (ipBloqueada(ip)) {
      return res.status(429).json({ success: false, message: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' });
    }

    const user = await Usuario.findOne({ email: String(email).trim().toLowerCase() }).select('+password');
    if (!user) {
      registrarFalloIp(ip);
      return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
    }

    if (user.lockUntil && user.lockUntil > new Date()) {
      const minutos = Math.ceil((user.lockUntil - new Date()) / 60000);
      return res.status(429).json({
        success: false,
        message: `Cuenta bloqueada por varios intentos fallidos. Intenta de nuevo en ${minutos} minuto${minutos === 1 ? '' : 's'}.`
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      registrarFalloIp(ip);
      const intentos = (user.failedLoginAttempts || 0) + 1;
      const cambios = { failedLoginAttempts: intentos };
      if (intentos >= MAX_INTENTOS) {
        cambios.failedLoginAttempts = 0;
        cambios.lockUntil = new Date(Date.now() + MINUTOS_BLOQUEO * 60000);
      }
      await Usuario.updateOne({ _id: user._id }, { $set: cambios });
      return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
    }

    if (user.failedLoginAttempts || user.lockUntil) {
      await Usuario.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0 }, $unset: { lockUntil: 1 } });
    }

    res.json({ success: true, token: generateToken(user._id), user: usuarioPublico(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al iniciar sesión' });
  }
});

// @route   GET /api/auth/me
// @desc    Usuario de la sesión actual
router.get('/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: usuarioPublico(req.user) });
});

// @route   PUT /api/auth/password
// @desc    Cambiar la contraseña propia (pide la actual). Cierra las demás sesiones.
router.put('/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await Usuario.findById(req.user._id).select('+password');
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ success: false, message: 'La contraseña actual no es correcta' });
    }
    const errorPassword = validarPassword(newPassword);
    if (errorPassword) return res.status(400).json({ success: false, message: errorPassword });
    user.password = newPassword;
    await user.save();
    // Sesión nueva para quien hizo el cambio (las anteriores quedan invalidadas)
    res.json({ success: true, message: 'Contraseña actualizada', token: generateToken(user._id) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al cambiar la contraseña' });
  }
});

// @route   GET /api/auth/users
// @desc    Lista de usuarios. Requiere sesión (antes era pública). El correo solo lo ve un administrador.
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const campos = req.user.role === 'admin' ? 'name email role createdAt lockUntil' : 'name role';
    const users = await Usuario.find({}).select(campos).sort({ name: 1 });
    res.json({ success: true, data: users });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al obtener usuarios' });
  }
});

// @route   PUT /api/auth/users/:id/password
// @desc    Un administrador asigna una contraseña nueva a otro usuario (p. ej. si la olvidó).
router.put('/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const errorPassword = validarPassword(req.body.newPassword);
    if (errorPassword) return res.status(400).json({ success: false, message: errorPassword });
    const user = await Usuario.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    user.password = req.body.newPassword;
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();
    res.json({ success: true, message: `Contraseña de ${user.name} actualizada` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al cambiar la contraseña' });
  }
});

module.exports = router;
