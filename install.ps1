[CmdletBinding()]
param([switch]$SkipMagpiePlugin, [switch]$NoShortcut, [uri]$Proxy)
$ErrorActionPreference = 'Stop'
$app = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE'
$cli = Join-Path $app 'bin\antigravity-ide.cmd'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Install the supported Antigravity IDE build in its default per-user location first.' }
if (@(Get-Process -Name 'Antigravity IDE' -ErrorAction SilentlyContinue).Count) { throw 'Save your work and exit Antigravity IDE before installation.' }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
Get-Command py.exe -CommandType Application -ErrorAction Stop | Out-Null
$magpie = if (-not $SkipMagpiePlugin) { (Get-Command magpie -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
if ($Proxy -and ($Proxy.Scheme -ne 'http' -or $Proxy.Host -notin '127.0.0.1','localhost','[::1]' -or $Proxy.UserInfo -or $Proxy.Query -or $Proxy.Fragment -or $Proxy.AbsolutePath -ne '/')) { throw 'Proxy must be a local HTTP listener, for example http://127.0.0.1:7890.' }
Push-Location $PSScriptRoot
try {
    & $node .\manage-native.cjs status
    if ($LASTEXITCODE -ne 0) { throw 'Unsupported IDE build.' }
    $vsix = & py -3 -X utf8 .\package-vsix.py
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the IDE extension.' }
    & $node .\manage-native.cjs install
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the native adapter. Check existing modifications before retrying.' }
    & $cli --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the IDE extension. Native adapter backups are retained in .local/checkpoints.' }
    if (-not $SkipMagpiePlugin) {
        & $magpie plugin add $PSScriptRoot
        if ($LASTEXITCODE -ne 0) { throw 'Could not register the Magpie Agent plugin.' }
    }
    if ($Proxy) {
        $folder = Join-Path $PSScriptRoot '.local'
        [IO.Directory]::CreateDirectory($folder) | Out-Null
        [IO.File]::WriteAllText((Join-Path $folder 'launcher.json'), (@{proxy=$Proxy.GetLeftPart([UriPartial]::Authority)} | ConvertTo-Json))
    }
    if (-not $NoShortcut) {
        $linkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Antigravity IDE - Magpie.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($linkPath)
        $shortcut.TargetPath = Join-Path $PSScriptRoot 'start-native.cmd'
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.IconLocation = (Join-Path $app 'Antigravity IDE.exe') + ',0'
        $shortcut.WindowStyle = 7
        $shortcut.Save()
    }
    & .\start-native.ps1 -Check
    Write-Output 'Installed. In Magpie, connect Antigravity IDE, then launch with start-native.cmd or the new desktop shortcut.'
} finally { Pop-Location }
