function errorHandler(err, req, res, next) {
  console.error('❌ Error:', err.message);

  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  // Errores de Prisma
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Registro duplicado' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Registro no encontrado' });
  }

  // Error genérico
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor'
  });
}

module.exports = errorHandler;
