#Requires -Version 5.1
<#
.SYNOPSIS
  Instala y configura en ESTE equipo la Cadena Digital S5: MongoDB del ledger, llaves,
  certificado HTTPS temporal y el archivo .env para el panel y el servicio de sellado.

.DESCRIPTION
  Ejecutar desde la carpeta del proyecto, en PowerShell COMO ADMINISTRADOR (recomendado):

    powershell -ExecutionPolicy Bypass -File .\scripts\windows\instalar-cadena.ps1

  Se puede ejecutar varias veces: conserva lo que ya existe (datos, contraseñas, llaves y certificado).
  Sin permisos de administrador también funciona, pero MongoDB no queda como servicio de Windows
  y no se abre el puerto del panel en el firewall.

  Todo queda dentro del proyecto:
    MongoDB\bin          servidor MongoDB          MongoDB\datos          base de datos del ledger
    MongoDB\mongosh      consola de MongoDB        MongoDB\logs           bitácora de MongoDB
    MongoDB\config       mongod.cfg y keyfile      MongoDB\credenciales   contraseñas generadas (protegidas)
    llaves\              firma, pepper, secreto    tls\                   certificado HTTPS temporal

.PARAMETER MongoZip
  Ruta o URL del .zip de MongoDB Community Server para Windows, si este equipo no puede
  consultar el catálogo de descargas de MongoDB.
.PARAMETER MongoshZip
  Ruta o URL del .zip de mongosh para Windows (win32-x64), en el mismo caso.
#>
[CmdletBinding()]
param(
  [string]$IpPanel = '192.168.1.77',
  [int]$PuertoPanel = 8444,
  [int]$PuertoMongo = 2730,
  [string]$MongoZip = '',
  [string]$MongoshZip = '',
  [int]$MesesCertificado = 12
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'   # acelera Invoke-WebRequest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Proyecto = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Raiz = Join-Path $Proyecto 'MongoDB'
$Dir = @{
  bin = Join-Path $Raiz 'bin'; mongosh = Join-Path $Raiz 'mongosh'; datos = Join-Path $Raiz 'datos'
  logs = Join-Path $Raiz 'logs'; config = Join-Path $Raiz 'config'; cred = Join-Path $Raiz 'credenciales'
  descargas = Join-Path $Raiz 'descargas'; llaves = Join-Path $Proyecto 'llaves'; tls = Join-Path $Proyecto 'tls'
}
$Servicio = 'MongoDBCadenaS5'
$EsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
$Utf8 = New-Object Text.UTF8Encoding $false   # sin BOM: Node lee .env y los secretos tal cual

function Paso([string]$n, [string]$t) { Write-Host ""; Write-Host "[$n] $t" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "    OK  $t" -ForegroundColor Green }
function Aviso([string]$t) { Write-Host "    !!  $t" -ForegroundColor Yellow }
function Escribir([string]$ruta, [string]$texto) { [IO.File]::WriteAllText($ruta, $texto, $Utf8) }
function Barra([string]$ruta) { $ruta.Replace('\', '/') }

# Contraseña aleatoria con alfabeto de 64 símbolos seguros para URI (sin sesgo).
function Nueva-Clave([int]$largo = 32) {
  $alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  $bytes = New-Object byte[] $largo
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $alfabeto[$_ % 64] })
}
function Nuevos-Bytes64([int]$n) {
  $b = New-Object byte[] $n
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b)
}
# Solo el usuario actual, SYSTEM y Administradores pueden leer el archivo (por SID: funciona en Windows en español).
function Proteger([string]$ruta) {
  $yo = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls $ruta /inheritance:r /grant:r "*${yo}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { Aviso "No se pudieron restringir los permisos de $ruta" }
}
function Descargar([string]$origen, [string]$destino) {
  if (Test-Path $origen) { Copy-Item $origen $destino -Force; return }
  Write-Host "    Descargando $origen"
  Invoke-WebRequest -Uri $origen -OutFile $destino -UseBasicParsing
}
function Esperar-Puerto([int]$puerto, [int]$segundos = 60) {
  $limite = (Get-Date).AddSeconds($segundos)
  while ((Get-Date) -lt $limite) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $puerto); $c.Close(); return $true } catch { Start-Sleep -Milliseconds 700 }
  }
  return $false
}
# Ejecuta un script de mongosh guardado en un archivo temporal protegido (las contraseñas no
# aparecen en la línea de comandos ni en pantalla) y lo borra al terminar.
function Mongosh-Script([string]$js) {
  $tmp = Join-Path $Dir.cred ("tmp-" + [Guid]::NewGuid().ToString('N') + '.js')
  Escribir $tmp $js
  Proteger $tmp
  try {
    & (Join-Path $Dir.mongosh 'mongosh.exe') "mongodb://127.0.0.1:$PuertoMongo/?directConnection=true" --quiet --norc $tmp
    if ($LASTEXITCODE -ne 0) { throw "mongosh terminó con código $LASTEXITCODE" }
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
# Asigna KEY=valor en un archivo .env conservando comentarios y el resto de líneas.
function Fijar-Env([string]$archivo, [hashtable]$valores) {
  $lineas = New-Object Collections.Generic.List[string]
  if (Test-Path $archivo) { [IO.File]::ReadAllLines($archivo, $Utf8) | ForEach-Object { $lineas.Add($_) } }
  foreach ($k in $valores.Keys) {
    $i = -1
    for ($j = 0; $j -lt $lineas.Count; $j++) { if ($lineas[$j] -match "^\s*$([regex]::Escape($k))=") { $i = $j; break } }
    $linea = "$k=$($valores[$k])"
    if ($i -ge 0) { $lineas[$i] = $linea } else { $lineas.Add($linea) }
  }
  Escribir $archivo (($lineas -join "`r`n") + "`r`n")
}

Write-Host "Cadena Digital S5 - instalación en $env:COMPUTERNAME" -ForegroundColor White
Write-Host "Proyecto: $Proyecto"
if (-not $EsAdmin) { Aviso 'Sin permisos de administrador: MongoDB no quedará como servicio y no se abrirá el firewall.' }

# ---------------------------------------------------------------------------------------------
Paso 1 'Requisitos'
$nodeVer = $null
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeVer = (& node -v) }
if (-not $nodeVer) { throw 'No se encontró Node.js. Instale Node.js 22 LTS o superior (https://nodejs.org) y vuelva a ejecutar.' }
$v = [version]($nodeVer.TrimStart('v'))
if ($v -lt [version]'22.9.0') { throw "Se requiere Node.js 22.9 o superior (tiene $nodeVer)." }
Ok "Node.js $nodeVer"
if (-not (Test-Path (Join-Path $Proyecto 'node_modules\mongodb'))) {
  Push-Location $Proyecto; try { & npm ci --omit=dev; if ($LASTEXITCODE -ne 0) { throw 'npm ci falló' } } finally { Pop-Location }
}
Ok 'Dependencias de Node instaladas'
if (-not (Get-NetIPAddress -IPAddress $IpPanel -ErrorAction SilentlyContinue)) {
  Aviso "La IP $IpPanel no está asignada a este equipo; el panel no podrá escuchar en ella. Revise con ipconfig."
} else { Ok "IP $IpPanel presente en este equipo" }
foreach ($d in $Dir.Values) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---------------------------------------------------------------------------------------------
Paso 2 'MongoDB Server y mongosh'
if (-not (Test-Path (Join-Path $Dir.bin 'mongod.exe'))) {
  $sha = $null
  if (-not $MongoZip) {
    try {
      $catalogo = Invoke-RestMethod -Uri 'https://downloads.mongodb.org/full.json' -UseBasicParsing
      $ver = $catalogo.versions | Where-Object { $_.PSObject.Properties['production_release'] -and $_.production_release -and $_.version -like '8.0.*' } |
        Sort-Object { [version]$_.version } -Descending | Select-Object -First 1
      $dl = $ver.downloads | Where-Object { $_.target -eq 'windows' -and $_.edition -eq 'base' -and $_.arch -eq 'x86_64' } | Select-Object -First 1
      $MongoZip = $dl.archive.url
      if ($dl.archive.PSObject.Properties['sha256']) { $sha = $dl.archive.sha256 }
      Write-Host "    MongoDB $($ver.version)"
    } catch {
      throw "No se pudo consultar el catálogo de MongoDB ($($_.Exception.Message)). Descargue el ZIP de MongoDB Community Server 8.0 para Windows desde https://www.mongodb.com/try/download/community y ejecute de nuevo con -MongoZip <ruta del zip>."
    }
  }
  $zip = Join-Path $Dir.descargas 'mongodb.zip'
  Descargar $MongoZip $zip
  if ($sha) {
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sha.ToUpper()) { throw 'La huella SHA-256 del ZIP de MongoDB no coincide; descarga corrupta o alterada.' }
    Ok 'Huella SHA-256 del ZIP verificada'
  }
  $tmp = Join-Path $Dir.descargas 'mongodb'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp -Force
  $mongod = Get-ChildItem $tmp -Recurse -Filter mongod.exe | Select-Object -First 1
  if (-not $mongod) { throw 'El ZIP no contiene mongod.exe' }
  Copy-Item (Join-Path $mongod.DirectoryName '*') $Dir.bin -Recurse -Force
  Remove-Item $tmp -Recurse -Force
}
Ok "MongoDB Server: $(& (Join-Path $Dir.bin 'mongod.exe') --version | Select-Object -First 1)"

if (-not (Test-Path (Join-Path $Dir.mongosh 'mongosh.exe'))) {
  if (-not $MongoshZip) {
    try {
      $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/mongodb-js/mongosh/releases/latest' -UseBasicParsing
      $MongoshZip = ($rel.assets | Where-Object { $_.name -match 'win32-x64\.zip$' } | Select-Object -First 1).browser_download_url
      Write-Host "    mongosh $($rel.tag_name)"
    } catch {
      throw "No se pudo consultar la versión de mongosh. Descárguelo (Windows x64 .zip) desde https://www.mongodb.com/try/download/shell y ejecute de nuevo con -MongoshZip <ruta del zip>."
    }
  }
  $zip = Join-Path $Dir.descargas 'mongosh.zip'
  Descargar $MongoshZip $zip
  $tmp = Join-Path $Dir.descargas 'mongosh'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp -Force
  $exe = Get-ChildItem $tmp -Recurse -Filter mongosh.exe | Select-Object -First 1
  if (-not $exe) { throw 'El ZIP no contiene mongosh.exe' }
  Copy-Item (Join-Path $exe.DirectoryName '*') $Dir.mongosh -Recurse -Force
  Remove-Item $tmp -Recurse -Force
}
Ok "mongosh $(& (Join-Path $Dir.mongosh 'mongosh.exe') --version)"

# ---------------------------------------------------------------------------------------------
Paso 3 "Configuración de MongoDB (puerto $PuertoMongo, solo localhost, replica set, autenticación)"
$keyfile = Join-Path $Dir.config 'keyfile'
if (-not (Test-Path $keyfile)) { Escribir $keyfile (Nuevos-Bytes64 756); Proteger $keyfile; Ok 'keyfile generado' }
$cfg = Join-Path $Dir.config 'mongod.cfg'
Escribir $cfg @"
# Generado por instalar-cadena.ps1 - MongoDB del ledger de la Cadena Digital S5
storage:
  dbPath: '$(Barra $Dir.datos)'
systemLog:
  destination: file
  path: '$(Barra (Join-Path $Dir.logs 'mongod.log'))'
  logAppend: true
net:
  port: $PuertoMongo
  bindIp: 127.0.0.1
replication:
  replSetName: rs0
security:
  authorization: enabled
  keyFile: '$(Barra $keyfile)'
"@
Ok "mongod.cfg (escucha solo en 127.0.0.1:$PuertoMongo; no se expone a la red)"

# ---------------------------------------------------------------------------------------------
Paso 4 'Arranque de MongoDB'
$svc = Get-Service -Name $Servicio -ErrorAction SilentlyContinue
if ($EsAdmin) {
  if (-not $svc) {
    & (Join-Path $Dir.bin 'mongod.exe') --config $cfg --install --serviceName $Servicio --serviceDisplayName 'MongoDB - Cadena Digital S5'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo registrar el servicio de MongoDB' }
    Set-Service -Name $Servicio -StartupType Automatic
    Ok "Servicio de Windows '$Servicio' registrado (inicio automático)"
  }
  if ((Get-Service $Servicio).Status -ne 'Running') { Start-Service $Servicio }
  Ok 'Servicio de MongoDB en ejecución'
} elseif ($svc) {
  if ($svc.Status -ne 'Running') { throw "El servicio $Servicio existe pero está detenido; ejecute este script como administrador." }
} elseif (-not (Esperar-Puerto $PuertoMongo 1)) {
  Start-Process -FilePath (Join-Path $Dir.bin 'mongod.exe') -ArgumentList @('--config', "`"$cfg`"") -WindowStyle Hidden
  Aviso 'MongoDB se inició como proceso. Tras reiniciar el equipo use scripts\windows\iniciar-cadena.ps1.'
}
if (-not (Esperar-Puerto $PuertoMongo 60)) { throw "MongoDB no respondió en el puerto $PuertoMongo. Revise $($Dir.logs)\mongod.log" }
Ok "MongoDB responde en 127.0.0.1:$PuertoMongo"

# ---------------------------------------------------------------------------------------------
Paso 5 'Replica set y usuario administrador de MongoDB'
$credAdmin = Join-Path $Dir.cred 'admin.txt'
if (-not (Test-Path $credAdmin)) {
  # Primera vez: la "excepción de localhost" permite iniciar el replica set y crear el primer usuario.
  $claveAdmin = Nueva-Clave 32
  Mongosh-Script @"
try { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:$PuertoMongo' }] }); } catch (e) { if (!/already initialized/i.test(e.message)) throw e; }
let n = 0; while (!db.hello().isWritablePrimary && n++ < 60) sleep(1000);
if (!db.hello().isWritablePrimary) throw new Error('El replica set no llegó a PRIMARY');
db.getSiblingDB('admin').createUser({ user: 'admin_cadena', pwd: '$claveAdmin', roles: ['root'] });
print('Replica set rs0 iniciado y usuario admin_cadena creado.');
"@
  Escribir $credAdmin $claveAdmin   # solo después de crear el usuario con éxito
  Proteger $credAdmin
  Ok "Usuario admin_cadena creado (contraseña en MongoDB\credenciales\admin.txt)"
} else { Ok 'Replica set y administrador ya existían' }
$claveAdmin = ([IO.File]::ReadAllText($credAdmin, $Utf8)).Trim()

# ---------------------------------------------------------------------------------------------
Paso 6 'Base del ledger, roles de mínimo privilegio y usuarios de servicio'
$credLedger = Join-Path $Dir.cred 'usuarios-ledger.json'
$usuarios = @('s5_cadena_worker', 's5_cadena_api', 's5_cadena_panel', 's5_cadena_gestor', 's5_cadena_audit')
$claves = @{}
if (Test-Path $credLedger) {
  $prev = ([IO.File]::ReadAllText($credLedger, $Utf8)) | ConvertFrom-Json
  foreach ($u in $usuarios) { if ($prev.PSObject.Properties[$u]) { $claves[$u] = $prev.$u } }
}
foreach ($u in $usuarios) { if (-not $claves.ContainsKey($u)) { $claves[$u] = Nueva-Clave 32 } }
Escribir $credLedger ($claves | ConvertTo-Json)
Proteger $credLedger
$jsClaves = ($usuarios | ForEach-Object { "'$_': '$($claves[$_])'" }) -join ', '
Mongosh-Script @"
db.getSiblingDB('admin').auth('admin_cadena', '$claveAdmin');
var CLAVES = { $jsClaves };
load('$(Barra (Join-Path $Proyecto 'mongo\crear-roles-ledger.js'))');
"@
Ok 'Base s5_cadena, colecciones, índices, roles y 5 usuarios de servicio listos'

# ---------------------------------------------------------------------------------------------
Paso 7 'Llaves y secretos'
Push-Location $Proyecto
try {
  if (-not (Test-Path (Join-Path $Dir.llaves 'firma-privada.pem'))) {
    & node scripts/generar-llaves.js llaves
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar la llave de firma' }
  }
} finally { Pop-Location }
Proteger (Join-Path $Dir.llaves 'firma-privada.pem')
Ok 'Llave de firma Ed25519 (llaves\firma-privada.pem; respáldela en lugar seguro)'
foreach ($s in @(@{ f = 'pepper.txt'; n = 48; d = 'Pepper de las huellas (NO debe cambiar nunca)' }, @{ f = 'panel-secreto.txt'; n = 48; d = 'Secreto de sesiones del panel' })) {
  $ruta = Join-Path $Dir.llaves $s.f
  if (-not (Test-Path $ruta)) { Escribir $ruta (Nuevos-Bytes64 $s.n); Proteger $ruta }
  Ok $s.d
}

# ---------------------------------------------------------------------------------------------
Paso 8 "Certificado HTTPS temporal para $IpPanel"
$pfx = Join-Path $Dir.tls 'panel.pfx'
$pfxClave = Join-Path $Dir.tls 'panel-pfx-clave.txt'
if (-not (Test-Path $pfx)) {
  $cert = New-SelfSignedCertificate -Subject "CN=$IpPanel, O=Cadena Digital S5 (temporal)" `
    -TextExtension @("2.5.29.17={text}IPAddress=$IpPanel&IPAddress=127.0.0.1&DNS=localhost&DNS=$env:COMPUTERNAME") `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddMonths($MesesCertificado) -CertStoreLocation 'Cert:\CurrentUser\My' `
    -FriendlyName 'Panel Cadena Digital S5 (temporal)'
  $clave = Nueva-Clave 32
  $seguro = ConvertTo-SecureString $clave -AsPlainText -Force
  try { Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $seguro -CryptoAlgorithmOption AES256_SHA256 | Out-Null }
  catch { Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $seguro | Out-Null }   # Windows anteriores a 1709
  Export-Certificate -Cert $cert -FilePath (Join-Path $Dir.tls 'panel.cer') | Out-Null
  Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
  Escribir $pfxClave $clave
  Proteger $pfx; Proteger $pfxClave
  Ok "Certificado autofirmado válido por $MesesCertificado meses (tls\panel.pfx)"
  Ok 'tls\panel.cer = parte pública; instálela en los equipos que consultarán el panel para evitar la advertencia'
} else { Ok 'El certificado ya existía (tls\panel.pfx)' }

# ---------------------------------------------------------------------------------------------
Paso 9 'Archivos .env'
$envFile = Join-Path $Proyecto '.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $Proyecto '.env.example') $envFile }
$respaldo = Join-Path $Proyecto (".env.respaldo-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item $envFile $respaldo
$uri = { param($u) "mongodb://${u}:$($claves[$u])@127.0.0.1:$PuertoMongo/?authSource=admin&replicaSet=rs0" }
$actual = [IO.File]::ReadAllText($envFile, $Utf8)
$s5Ejemplo = $actual -match '(?m)^S5_MONGO_URI=.*servidor-s5'
$cambios = @{
  LEDGER_MONGO_URI = (& $uri 's5_cadena_panel'); LEDGER_DB = 's5_cadena'
  LEDGER_GESTOR_MONGO_URI = (& $uri 's5_cadena_gestor')
  LLAVE_FIRMA_PATH = './llaves/firma-privada.pem'; LLAVES_CONFIANZA_DIR = './llaves/confianza'
  HASH_PEPPER_PATH = './llaves/pepper.txt'
  PANEL_HOST = $IpPanel; PANEL_PORT = "$PuertoPanel"
  PANEL_TLS_PFX_PATH = './tls/panel.pfx'; PANEL_TLS_PFX_CLAVE_PATH = './tls/panel-pfx-clave.txt'
  PANEL_TLS_CERT_PATH = ''; PANEL_TLS_KEY_PATH = ''
  PANEL_SECRETO_SESION_PATH = './llaves/panel-secreto.txt'
  PERMITIR_HTTP_INSEGURO = 'false'
}
if ($s5Ejemplo) { $cambios['S5_MONGO_URI'] = '' }   # el valor de ejemplo impediría arrancar el panel
Fijar-Env $envFile $cambios
Proteger $envFile
Ok ".env actualizado (respaldo del anterior: $(Split-Path $respaldo -Leaf))"
# El servicio de sellado usa su PROPIO usuario de MongoDB (puede insertar bloques; el panel no).
$envWorker = Join-Path $Proyecto '.env.worker'
Fijar-Env $envWorker @{ LEDGER_MONGO_URI = (& $uri 's5_cadena_worker') }
Proteger $envWorker
Ok '.env.worker con el usuario del servicio de sellado'
$envApi = Join-Path $Proyecto '.env.api'
Fijar-Env $envApi @{ LEDGER_MONGO_URI = (& $uri 's5_cadena_api') }
Proteger $envApi
Ok '.env.api con el usuario de la API de verificación'

# ---------------------------------------------------------------------------------------------
Paso 10 "Firewall (puerto $PuertoPanel del panel)"
$regla = "Cadena Digital S5 - Panel ($PuertoPanel)"
if ($EsAdmin) {
  if (-not (Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $regla -Direction Inbound -Protocol TCP -LocalPort $PuertoPanel -Action Allow -Profile Domain,Private | Out-Null
  }
  Ok "Regla de entrada para TCP $PuertoPanel (redes de dominio y privadas). MongoDB NO se abre a la red."
} else {
  Aviso "Pida a un administrador: New-NetFirewallRule -DisplayName '$regla' -Direction Inbound -Protocol TCP -LocalPort $PuertoPanel -Action Allow -Profile Domain,Private"
}

# ---------------------------------------------------------------------------------------------
Paso 11 'Prueba de arranque del panel'
$out = Join-Path $Dir.logs 'prueba-panel.log'
$p = Start-Process -FilePath 'node' -ArgumentList @('--env-file=.env', 'src/index.js', '--rol=panel') -WorkingDirectory $Proyecto `
  -RedirectStandardOutput $out -RedirectStandardError "$out.err" -WindowStyle Hidden -PassThru
$listo = Esperar-Puerto $PuertoPanel 25
if ($listo) {
  try {
    $r = Invoke-WebRequest -Uri "https://${IpPanel}:$PuertoPanel/salud" -UseBasicParsing -TimeoutSec 10 `
      -Headers @{ 'Cache-Control' = 'no-cache' } -ErrorAction Stop
    Ok "El panel respondió: $($r.Content)"
  } catch {
    # Windows PowerShell rechaza el certificado autofirmado; basta con que el puerto responda.
    Ok "El panel escucha en https://${IpPanel}:$PuertoPanel"
  }
} else {
  Aviso 'El panel no arrancó. Detalle:'
  Get-Content $out, "$out.err" -ErrorAction SilentlyContinue | Select-Object -Last 15 | ForEach-Object { Write-Host "      $_" }
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }

# ---------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "Instalación terminada." -ForegroundColor Green
Write-Host @"

Siguientes pasos:
  1. Cree la primera cuenta de administrador del panel (le pedirá la contraseña):
       npm run usuario-panel -- alta admin.ti administrador "Nombre Apellido"
     y la(s) del Contralor interno:
       npm run usuario-panel -- alta contralor1 contralor "Nombre Apellido"
  2. Inicie la cadena:
       powershell -ExecutionPolicy Bypass -File .\scripts\windows\iniciar-cadena.ps1
  3. Abra https://${IpPanel}:$PuertoPanel  (certificado temporal: el navegador advertirá la primera vez;
     para evitarlo, instale tls\panel.cer como 'Entidad de certificación raíz de confianza').
  4. Servicio de sellado: escriba en .env la conexión de SOLO LECTURA al S5 (S5_MONGO_URI, S5_DB,
     S5_COLLECTION) y vuelva a ejecutar iniciar-cadena.ps1; lo arrancará automáticamente.

Respalde en un lugar seguro: llaves\, tls\ y MongoDB\credenciales\ (no los suba a git).
"@
