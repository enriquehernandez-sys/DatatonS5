/**
 * Administración de cuentas del panel (Contralor interno / Administrador).
 * Se ejecuta con un usuario de MongoDB con el rol `cadenaGestorUsuarios`; el panel solo LEE las cuentas.
 *
 *   npm run usuario-panel -- alta <usuario> <contralor|administrador> "<Nombre completo>"
 *   npm run usuario-panel -- contrasena <usuario>     (cambia la contraseña y cierra sus sesiones)
 *   npm run usuario-panel -- rol <usuario> <contralor|administrador>
 *   npm run usuario-panel -- baja <usuario>           (desactiva; las cuentas no se borran)
 *   npm run usuario-panel -- lista
 *
 * Variables: LEDGER_GESTOR_MONGO_URI (o LEDGER_MONGO_URI) y LEDGER_DB.
 */
import { createInterface } from 'node:readline';
import { MongoClient } from 'mongodb';
import { hashPassword, ROLES, USUARIO_RE } from '../src/panel/auth.js';

const [cmd, usuarioRaw, a3, a4] = process.argv.slice(2);
const uri = process.env.LEDGER_GESTOR_MONGO_URI || process.env.LEDGER_MONGO_URI;
if (!uri) throw new Error('Defina LEDGER_GESTOR_MONGO_URI');
const usuario = usuarioRaw?.toLowerCase();

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (v) => { rl.close(); process.stdout.write('\n'); resolve(v); });
  });
}
async function nuevaContrasena() {
  const p1 = await askHidden('Contraseña (mín. 12 caracteres): ');
  const p2 = await askHidden('Confirme la contraseña: ');
  if (p1 !== p2) throw new Error('Las contraseñas no coinciden');
  return hashPassword(p1);
}
const checkUser = () => { if (!USUARIO_RE.test(usuario ?? '')) throw new Error('Usuario inválido (a-z, 0-9, . _ -; 3 a 64)'); };
const checkRol = (r) => { if (!ROLES.includes(r)) throw new Error(`Rol inválido: use ${ROLES.join(' o ')}`); };

const client = await new MongoClient(uri).connect();
try {
  const col = client.db(process.env.LEDGER_DB || 's5_cadena').collection('usuarios_panel');
  const now = new Date();
  switch (cmd) {
    case 'alta': {
      checkUser(); checkRol(a3);
      if (!a4) throw new Error('Indique el nombre completo');
      await col.insertOne({ _id: usuario, nombre: a4, rol: a3, activo: true, version: 1, hash: await nuevaContrasena(), creadoEn: now, actualizadoEn: now });
      console.log(`Cuenta ${usuario} (${a3}) creada.`);
      break;
    }
    case 'contrasena': {
      checkUser();
      const r = await col.updateOne({ _id: usuario }, { $set: { hash: await nuevaContrasena(), actualizadoEn: now }, $inc: { version: 1 } });
      console.log(r.matchedCount ? 'Contraseña actualizada; sesiones anteriores invalidadas.' : 'No existe la cuenta.');
      break;
    }
    case 'rol': {
      checkUser(); checkRol(a3);
      const r = await col.updateOne({ _id: usuario }, { $set: { rol: a3, actualizadoEn: now }, $inc: { version: 1 } });
      console.log(r.matchedCount ? `Rol cambiado a ${a3}.` : 'No existe la cuenta.');
      break;
    }
    case 'baja': {
      checkUser();
      const r = await col.updateOne({ _id: usuario }, { $set: { activo: false, actualizadoEn: now }, $inc: { version: 1 } });
      console.log(r.matchedCount ? 'Cuenta desactivada.' : 'No existe la cuenta.');
      break;
    }
    case 'lista':
      for (const u of await col.find({}, { projection: { hash: 0 } }).sort({ _id: 1 }).toArray()) {
        console.log(`${u._id.padEnd(24)} ${u.rol.padEnd(14)} ${u.activo ? 'activa  ' : 'inactiva'} ${u.nombre}`);
      }
      break;
    default:
      console.error('Comandos: alta | contrasena | rol | baja | lista');
      process.exitCode = 1;
  }
} finally {
  await client.close();
}
