[CmdletBinding()]
param([uri]$Proxy, [switch]$Check)
$ErrorActionPreference = 'Stop'
if (-not $Proxy -and $env:MAGPIE_IDE_PROXY) { $Proxy = [uri]$env:MAGPIE_IDE_PROXY }
if (-not $Proxy) {
    $preferences = Join-Path $PSScriptRoot '.local\launcher.json'
    if (Test-Path -LiteralPath $preferences) {
        $saved = Get-Content -LiteralPath $preferences -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved.proxy) { $Proxy = [uri]$saved.proxy }
    }
}
if (-not $Proxy) { throw 'Supply -Proxy http://127.0.0.1:<your-port>, set MAGPIE_IDE_PROXY, or save a proxy with install.ps1 -Proxy.' }
& (Join-Path $PSScriptRoot 'start-native.ps1') -Proxy $Proxy -Check:$Check
