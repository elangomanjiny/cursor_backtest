# Download & extract QuestDB Windows runtime into tools\questdb
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "tools\questdb"
$Zip = Join-Path $env:TEMP "questdb-rt-windows.tar.gz"
$Url = "https://github.com/questdb/questdb/releases/download/10.0.0/questdb-10.0.0-rt-windows-x86-64.tar.gz"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Write-Host "Downloading QuestDB 10.0.0..."
Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

Write-Host "Extracting to $Dest ..."
# tar is available on Win10+
tar -xzf $Zip -C $Dest --strip-components=1

$dataDir = Join-Path $Dest "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Write-Host "Done. First-time Windows service:"
Write-Host "  cd $Dest"
Write-Host "  .\bin\questdb.exe install -d .\data"
Write-Host "  .\bin\questdb.exe start -d .\data"
Write-Host "Console: http://127.0.0.1:9000"
