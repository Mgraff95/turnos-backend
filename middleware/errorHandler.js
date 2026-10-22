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
  // `publico` es el mensaje pensado para quien usa la web; `message` suele ser
  // un codigo interno (SERVICIOS_DE_DISTINTAS_PROFESIONALES y similares).
  res.status(err.status || 500).json({
    error: err.publico || err.message || 'Error interno del servidor'
  });
}

module.exports = errorHandler;
