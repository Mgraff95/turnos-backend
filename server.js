const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { iniciarScheduler } = require('./lib/scheduler');

const app = express();

// ── Middleware global ──────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3000',
    'https://turnos-frontend-eta.vercel.app'
  ],
  credentials: true
}));
app.use(express.json());

// ── Rutas ──────────────────────────────────────
app.use('/api/servicios', require('./routes/servicios'));
app.use('/api/horarios', require('./routes/horarios'));
app.use('/api/turnos', require('./routes/turnos'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/whatsapp/webhook', require('./routes/webhook'));

// ── Health check ───────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ── Error handler global ───────────────────────
app.use(require('./middleware/errorHandler'));

// ── Start ──────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Turnos API corriendo en puerto ${PORT}`);
  console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);

  // Iniciar scheduler de recordatorios
  iniciarScheduler();
});