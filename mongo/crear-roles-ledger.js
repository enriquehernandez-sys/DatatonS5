// Ejecutar en el MongoDB PROPIO de la cadena digital (no en el del S5):
//   mongosh "mongodb://admin@ledger-db:27017/admin" mongo/crear-roles-ledger.js
//
// Principio de mínimo privilegio:
//   - s5_cadena_worker : puede INSERTAR bloques pero NUNCA modificarlos ni borrarlos.
//   - s5_cadena_api    : solo lectura (+ registrar alertas).
//   - s5_cadena_panel  : panel público: lectura de la cadena, registrar alertas, seguimiento y bitácora.
//   - s5_cadena_gestor : administra cuentas del panel (solo para scripts/usuario-panel.js).
//   - s5_cadena_audit  : solo lectura (auditores externos / OIC). Sin acceso a cuentas ni bitácora.

const DB = 's5_cadena';
const ledger = db.getSiblingDB(DB);
const admin = db.getSiblingDB('admin');

// 1) Colecciones, validador e índices (los crea el administrador).
if (!ledger.getCollectionNames().includes('bloques')) {
  ledger.createCollection('bloques', {
    validationLevel: 'strict',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['version', 'index', 'timestamp', 'prevHash', 'merkleRoot', 'entryCount', 'keyId', 'hash', 'signature', 'entradas'],
        properties: {
          index: { bsonType: ['int', 'long'], minimum: 0 },
          prevHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
          merkleRoot: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
          hash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
          signature: { bsonType: 'string' },
          entradas: { bsonType: 'array' },
        },
      },
    },
  });
}
ledger.bloques.createIndex({ index: 1 }, { unique: true });
ledger.bloques.createIndex({ hash: 1 }, { unique: true });
ledger.bloques.createIndex({ 'entradas.denunciaId': 1 });
ledger.bloques.createIndex({ 'entradas.hashDocumento': 1 });
['pendientes', 'estado_denuncias', 'control', 'alertas', 'alertas_seguimiento', 'bitacora_accesos', 'usuarios_panel'].forEach((c) => {
  if (!ledger.getCollectionNames().includes(c)) ledger.createCollection(c);
});
ledger.pendientes.createIndex({ entryId: 1 });
ledger.pendientes.createIndex({ denunciaId: 1 });
ledger.estado_denuncias.createIndex({ hashDocumento: 1 });
ledger.bloques.createIndex({ timestamp: 1 });
ledger.alertas.createIndex({ clave: 1 }, { unique: true });
ledger.alertas.createIndex({ detectadaEn: -1 });
ledger.alertas_seguimiento.createIndex({ alertaId: 1, en: 1 });
ledger.bitacora_accesos.createIndex({ en: -1 });

// Se puede ejecutar varias veces: crea lo que falta y actualiza los privilegios de lo existente.
// Si antes se define `var CLAVES = { usuario: 'contraseña', ... }` no se piden las contraseñas
// (lo usa scripts/windows/instalar-cadena.ps1).
const pwdFor = (u) => {
  if (typeof CLAVES !== 'undefined' && CLAVES[u]) return CLAVES[u];
  print(`Contraseña para ${u}:`);
  return passwordPrompt();
};
const ensureRole = (def) => {
  if (admin.getRole(def.role)) admin.updateRole(def.role, { privileges: def.privileges, roles: def.roles });
  else admin.createRole(def);
};
const ensureUser = (user, roles) => {
  if (admin.getUser(user)) {
    admin.grantRolesToUser(user, roles);
    print(`El usuario ${user} ya existía: se conserva su contraseña.`);
  } else {
    admin.createUser({ user, pwd: pwdFor(user), roles });
  }
};

// 2) Roles personalizados.
const res = (collection) => ({ db: DB, collection });
ensureRole({
  role: 'cadenaEscritor',
  privileges: [
    { resource: res('bloques'), actions: ['find', 'insert'] }, // ← sin update ni remove
    { resource: res('pendientes'), actions: ['find', 'insert', 'remove'] },
    { resource: res('estado_denuncias'), actions: ['find', 'insert', 'update'] },
    { resource: res('control'), actions: ['find', 'insert', 'update'] },
    { resource: res('alertas'), actions: ['find', 'insert'] }, // ← sin update ni remove
    { resource: res(''), actions: ['listCollections'] },
  ],
  roles: [],
});
ensureRole({
  role: 'cadenaLector',
  privileges: [
    { resource: res('bloques'), actions: ['find'] },
    { resource: res('pendientes'), actions: ['find'] },
    { resource: res('estado_denuncias'), actions: ['find'] },
    { resource: res('control'), actions: ['find'] },
    { resource: res('alertas'), actions: ['find'] },
    { resource: res('alertas_seguimiento'), actions: ['find'] },
  ],
  roles: [],
});
ensureRole({
  role: 'cadenaApi',
  privileges: [{ resource: res('alertas'), actions: ['insert'] }],
  roles: [{ role: 'cadenaLector', db: 'admin' }],
});
// Panel: todo es solo inserción; el seguimiento y la bitácora no pueden editarse ni borrarse.
ensureRole({
  role: 'cadenaPanel',
  privileges: [
    { resource: res('alertas'), actions: ['insert'] },
    { resource: res('alertas_seguimiento'), actions: ['insert'] },
    { resource: res('bitacora_accesos'), actions: ['find', 'insert'] },
    { resource: res('usuarios_panel'), actions: ['find'] },
  ],
  roles: [{ role: 'cadenaLector', db: 'admin' }],
});
ensureRole({
  role: 'cadenaGestorUsuarios',
  privileges: [{ resource: res('usuarios_panel'), actions: ['find', 'insert', 'update'] }],
  roles: [],
});

// 3) Usuarios.
ensureUser('s5_cadena_worker', ['cadenaEscritor']);
ensureUser('s5_cadena_api', ['cadenaApi']);
ensureUser('s5_cadena_panel', ['cadenaPanel']);
ensureUser('s5_cadena_gestor', ['cadenaGestorUsuarios']);
ensureUser('s5_cadena_audit', ['cadenaLector']);

print('Listo. Habilite también la bitácora de auditoría de MongoDB (auditLog) si su edición la soporta.');
