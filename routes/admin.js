const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { authAdmin } = require('../middleware/auth');

// ── Login admin ────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Faltan campos: email, password' });
    }

    const admin = await prisma.usuarioAdmin.findUnique({
      where: { email }
    });

    if (!admin || !admin.activo) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const passwordValido = await bcrypt.compare(password, admin.password_hash);
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Actualizar last_login
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

// ── Recordatorios pendientes (turnos de mañana) ─
router.get('/recordatorios-pendientes', authAdmin, async (req, res, next) => {
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaManana = manana.toISOString().split('T')[0];

    const turnos = await prisma.turno.findMany({
      where: {
        fecha: new Date(fechaManana),
        estado: 'confirmado'
      },
      include: { servicio: true },
      orderBy: { hora_inicio: 'asc' }
    });
    res.json(turnos);
  } catch (err) { next(err); }
});

module.exports = router;
