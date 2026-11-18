#Requires -Version 5.1
<#
.SYNOPSIS
  Inicia la Cadena Digital S5 en este equipo: MongoDB (si no está corriendo), el panel y,
  cuando el .env ya tiene la conexión al S5, el servicio de sellado.

    powershell -ExecutionPolicy Bypass -File .\scripts\windows\iniciar-cadena.ps1

  Cada servicio abre su propia ventana de consola; cerrarla lo detiene.
#>
[CmdletBinding()]
param([switch]$SoloPanel)

$ErrorActionPreference = 'Stop'
$Proyecto = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Raiz = Join-Path $Proyecto 'MongoDB'
$Utf8 = New-Object Text.UTF8Encoding $false

function Leer-Env([string]$clave) {
  $f = Join-Path $Proyecto '.env'
  foreach ($l in [IO.File]::ReadAllLines($f, $Utf8)) { if ($l -match "^\s*$([regex]::Escape($clave))=(.*)$") { return $Matches[1].Trim() } }
  return ''
}
function Puerto-Abierto([string]$ip, [int]$puerto) {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect($ip, $puerto); $c.Close(); return $true } catch { return $false }
}

$uriLedger = Leer-Env 'LEDGER_MONGO_URI'
$puertoMongo = if ($uriLedger -match '@[^:/]+:(\d+)/') { [int]$Matches[1] } else { 2730 }

# 1) MongoDB del ledger
if (Puerto-Abierto '127.0.0.1' $puertoMongo) {
  Write-Host "MongoDB ya está activo en el puerto $puertoMongo" -ForegroundColor Green
} else {
  $svc = Get-Service -Name 'MongoDBCadenaS5' -ErrorAction SilentlyContinue
  if ($svc) {
    try { Start-Service 'MongoDBCadenaS5' } catch { throw 'No se pudo iniciar el servicio MongoDBCadenaS5; ejecute PowerShell como administrador.' }
  } else {
    Start-Process -FilePath (Join-Path $Raiz 'bin\mongod.exe') -ArgumentList @('--config', "`"$(Join-Path $Raiz 'config\mongod.cfg')`"") -WindowStyle Hidden
  }
  $limite = (Get-Date).AddSeconds(60)
  while (-not (Puerto-Abierto '127.0.0.1' $puertoMongo)) {
    if ((Get-Date) -gt $limite) { throw "MongoDB no respondió; revise $Raiz\logs\mongod.log" }
    Start-Sleep -Milliseconds 700
  }
  Write-Host "MongoDB iniciado en el puerto $puertoMongo" -ForegroundColor Green
}

# 2) Servicio de sellado (solo si ya hay conexión al S5)
$s5 = Leer-Env 'S5_MONGO_URI'
if ($SoloPanel) {
  Write-Host 'Servicio de sellado omitido (-SoloPanel).' -ForegroundColor Yellow
} elseif (-not $s5 -or $s5 -match 'servidor-s5|CAMBIAR') {
  Write-Host 'Servicio de sellado NO iniciado: falta configurar S5_MONGO_URI en .env (conexión de solo lectura al S5).' -ForegroundColor Yellow
} else {
  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $Proyecto -ArgumentList @(
    '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'Cadena S5 - Sellado'; npm run start:worker")
  Write-Host 'Servicio de sellado iniciado (ventana "Cadena S5 - Sellado").' -ForegroundColor Green
}

# 3) Panel
$ip = Leer-Env 'PANEL_HOST'; $puerto = Leer-Env 'PANEL_PORT'
if (Puerto-Abierto $ip ([int]$puerto)) {
  Write-Host "El panel ya está activo en https://${ip}:$puerto" -ForegroundColor Green
} else {
  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $Proyecto -ArgumentList @(
    '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'Cadena S5 - Panel'; npm run start:panel")
  Write-Host "Panel iniciado: https://${ip}:$puerto  (ventana 'Cadena S5 - Panel')" -ForegroundColor Green
}
