#requires -Version 7.0
$ErrorActionPreference='Stop'
$base=Split-Path -Parent $PSScriptRoot
$scratch=Join-Path $base '.local\tmp\host-smoke'
$app=Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\Antigravity IDE.exe'
foreach ($name in 'profile\User','extensions','empty') { [void][IO.Directory]::CreateDirectory((Join-Path $scratch $name)) }
$s=Join-Path $scratch 'profile\User\settings.json'
if(-not (Test-Path -LiteralPath $s)){[IO.File]::WriteAllText($s,'{"security.workspace.trust.enabled":false,"update.mode":"none","telemetry.telemetryLevel":"off","workbench.startupEditor":"none","extensions.autoCheckUpdates":false,"extensions.autoUpdate":false,"window.restoreWindows":"none"}')}
$psi=[Diagnostics.ProcessStartInfo]::new($app);$psi.UseShellExecute=$false;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
foreach ($n in 'ELECTRON_RUN_AS_NODE','VSCODE_IPC_HOOK_CLI','VSCODE_CWD'){[void]$psi.Environment.Remove($n)}
foreach($arg in @('--new-window','--disable-updates','--skip-release-notes','--skip-welcome',('--user-data-dir='+(Join-Path $scratch 'profile')),('--extensions-dir='+(Join-Path $scratch 'extensions')),('--extensionDevelopmentPath='+(Join-Path $base 'extension')),('--extensionTestsPath='+(Join-Path $base 'test\host-smoke.cjs')),(Join-Path $scratch 'empty'))){[void]$psi.ArgumentList.Add($arg)}
$process=[Diagnostics.Process]::Start($psi)
$o=$process.StandardOutput.ReadToEndAsync();$e=$process.StandardError.ReadToEndAsync()
if(-not $process.WaitForExit(85000)){[void]$process.CloseMainWindow();Write-Output 'Host timed out';exit 1}
$raw=$o.Result+$e.Result
$marker=$raw.Contains('MAGPIE_HOST_SMOKE_OK');[pscustomobject]@{exit=$process.ExitCode;completed=$marker}; if(-not $marker){exit 1}
exit $process.ExitCode
