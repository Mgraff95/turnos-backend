const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');
const { calcularHoraFin, verificarYReservar } = require('../lib/availability');
const { enviarConfirmacion } = require('../services/whatsapp');

// ── Login admin ────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Faltan campos: email, password' });
    }

    const admin = await prisma.usuarioAdmin.findUnique({ where: { email } });

    if (!admin || !admin.activo) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const passwordValido = await bcrypt.compare(password, admin.password_hash);
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    await prisma.usuarioAdmin.update({
      where: { id: admin.id },
      data: { last_login: new Date() }
    });

    const token = jwt.sign(
      { id: admin.id, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: { id: admin.id, email: admin.email, nombre: admin.nombre }
    });
  } catch (err) { next(err); }
});

// ── Dashboard: todos los turnos ────────────────
router.get('/turnos', authAdmin, async (req, res, next) => {
  try {
    const { estado, desde, hasta } = req.query;

    const where = {};
    if (estado) where.estado = estado;
    if (desde || hasta) {
      where.fecha = {};
      if (desde) where.fecha.gte = new Date(desde);
      if (hasta) where.fecha.lte = new Date(hasta);
    }

    const turnos = await prisma.turno.findMany({
      where,
      include: { servicio: true },
      orderBy: [{ fecha: 'asc' }, { hora_inicio: 'asc' }]
    });
    res.json(turnos);
  } catch (err) { next(err); }
});

// ── Admin: Crear turno manual ──────────────────
router.post('/turnos', authAdmin, async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, servicio_id, fecha, hora_inicio } = req.body;

    if (!nombre || !apellido || !telefono || !servicio_id || !fecha || !hora_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const telLimpio = telefono.replace(/\D/g, '');

    const servicio = await prisma.servicio.findUnique({
      where: { id: parseInt(servicio_id) }
    });
    if (!servicio || !servicio.activo) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const horaFin = calcularHoraFin(hora_inicio, servicio.duracion_minutos);

    const tokenExpires = new Date();
    tokenExpires.setDate(tokenExpires.getDate() + 30);

    const turno = await verificarYReservar({
      cliente_nombre: nombre.trim(),
      cliente_apellido: apellido.trim(),
      cliente_telefono: telLimpio,
      servicio_id: parseInt(servicio_id),
      fecha: new Date(fecha),
      hora_inicio,
      hora_fin: horaFin,
      estado: 'confirmado',
      token_acceso: uuidv4(),
      token_expires_at: tokenExpires,
      origen: 'manual'
    });

    // Enviar WhatsApp (no bloqueante)
    enviarConfirmacion(turno).catch(err =>
      console.error('Error enviando WA:', err.message)
    );

    res.status(201).json({ success: true, turno });
  } catch (err) {
    if (err.message === 'HORARIO_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'Ese horario ya no está disponible.' });
    }
    next(err);
  }
});

// ── Recordatorios pendientes ───────────────────
router.get('/recordatorios-pendientes', authAdmin, async (req, res, next) => {
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaManana = manana.toISOString().split('T')[0];

    const turnos = await prisma.turno.findMany({
      where: { fecha: new Date(fechaManana), estado: 'confirmado' },
      include: { servicio: true },
      orderBy: { hora_inicio: 'asc' }
    });
    res.json(turnos);
  } catch (err) { next(err); }
});

module.exports = router;
