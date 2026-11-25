[CmdletBinding()]
param([switch]$Check,[uri]$Proxy)
$ErrorActionPreference='Stop'
if(-not $Proxy){
  if($env:MAGPIE_IDE_PROXY){$Proxy=[uri]$env:MAGPIE_IDE_PROXY}
  else{
    $preferences=Join-Path $PSScriptRoot '.local\launcher.json'
    if(Test-Path -LiteralPath $preferences){$saved=Get-Content -LiteralPath $preferences -Raw -Encoding UTF8|ConvertFrom-Json;if($saved.proxy){$Proxy=[uri]$saved.proxy}}
  }
}
$app=Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\Antigravity IDE.exe'
if(-not (Test-Path -LiteralPath $app -PathType Leaf)){throw 'Antigravity IDE is not installed.'}
$c=$null
$file=Join-Path $env:USERPROFILE '.antigravity-ide\magpie-ide.json'
if(Test-Path -LiteralPath $file){try{$c=Get-Content -Raw -Encoding UTF8 -LiteralPath $file|ConvertFrom-Json}catch{throw 'Invalid Magpie configuration. Reconnect or disconnect the Antigravity IDE agent in Magpie.'}}
$start=[Diagnostics.ProcessStartInfo]::new($app);$start.UseShellExecute=$false;$start.WorkingDirectory=Split-Path -Parent $app
foreach($n in 'ELECTRON_RUN_AS_NODE','VSCODE_IPC_HOOK_CLI','VSCODE_CWD'){ $start.EnvironmentVariables.Remove($n) }
if(@($start.EnvironmentVariables.Keys|Where-Object {$_ -like 'AGY_LLM_GATEWAY_*'}).Count){throw 'An external enterprise gateway is already set. This launcher will not override it.'}
$connected=[bool]($c -and $c.selectedModel -and $c.gatewayKey)
if(-not $connected -and ($c.gatewayKey -or $c.gatewayUrl -or $c.selectedModel)){throw 'Magpie configuration is incomplete. Reconnect or disconnect the Antigravity IDE agent.'}
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $node (Join-Path $PSScriptRoot 'manage-native.cjs') check | Out-Null
if($LASTEXITCODE -ne 0){throw 'Native adapter unavailable. Install it for this IDE version before launching.'}
$model=if($connected){[string]$c.selectedModel}else{$null}
$ids=@($c.models | Where-Object { $_ -and $_.id } | ForEach-Object { $_.id } | Select-Object -Unique)
$source=if($connected){'magpie'}else{'google'}
$start.EnvironmentVariables['MAGPIE_IDE_NATIVE_SOURCE']='managed-v3'
$start.EnvironmentVariables['MAGPIE_IDE_RUN_ID']=[Guid]::NewGuid().ToString('N')
$start.EnvironmentVariables['NO_PROXY']=(@('127.0.0.1','localhost','::1',$env:NO_PROXY)|Where-Object {$_}) -join ','
if($Proxy){
  if($Proxy.Scheme -ne 'http' -or $Proxy.Host -notin '127.0.0.1','localhost','[::1]' -or $Proxy.UserInfo -or $Proxy.Query -or $Proxy.Fragment -or $Proxy.AbsolutePath -ne '/'){throw 'Expected a local HTTP proxy.'}
  $tcp=[Net.Sockets.TcpClient]::new();try{$tcp.Connect($Proxy.DnsSafeHost,$Proxy.Port)}catch{throw 'The local network proxy is not running.'}finally{$tcp.Dispose()}
  $address=$Proxy.GetLeftPart([UriPartial]::Authority);foreach($n in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'){$start.EnvironmentVariables[$n]=$address}
  $start.Arguments="--proxy-server=$address --proxy-bypass-list=localhost;127.0.0.1;[::1]"
}
if($Check){[pscustomobject]@{source=$source;model=$model;visibleModels=$ids.Count};return}
$alive=@(Get-CimInstance Win32_Process -Filter "Name='Antigravity IDE.exe'"|Where-Object {$_.ExecutablePath -eq $app -and $_.CommandLine -notmatch '(?i)--type=|--user-data-dir|resources[\\/]app[\\/]out[\\/]cli\.js'})
if($alive.Count){throw 'Antigravity IDE is already open. Use File > Exit to end the old session, then use this launcher again.'}
[void][Diagnostics.Process]::Start($start)
