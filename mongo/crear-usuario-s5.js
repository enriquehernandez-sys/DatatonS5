// Ejecutar en el MongoDB del S5 con un usuario administrador:
//   mongosh "mongodb://admin@servidor-s5:27017/admin" mongo/crear-usuario-s5.js
//
// Crea un usuario de SOLO LECTURA para el servicio de cadena digital.
// El rol `read` incluye find y changeStream; NO permite insertar, modificar ni borrar.
// Cambie la base `S5_DB` si su instalación usa otro nombre.

const S5_DB = 'S5';
const USUARIO = 's5_cadena_lector';

db.getSiblingDB('admin').createUser({
  user: USUARIO,
  pwd: passwordPrompt(),
  roles: [{ role: 'read', db: S5_DB }],
  // Restringe el usuario a la IP del servidor de la cadena digital:
  authenticationRestrictions: [{ clientSource: ['10.0.20.10'] }],
});

print(`Usuario ${USUARIO} creado con rol read sobre ${S5_DB}.`);
print('Recuerde: los change streams requieren que el S5 corra como replica set.');
print('Opcional (MongoDB 6+): habilite post-imágenes exactas con');
print(`  db.getSiblingDB('${S5_DB}').runCommand({ collMod: 'denuncias', changeStreamPreAndPostImages: { enabled: true } })`);
print('  y configure S5_FULL_DOCUMENT=required');
