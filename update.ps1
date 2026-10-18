param([switch]$Setup,[switch]$FromExtension,[string]$Uri)

$ErrorActionPreference='Stop'

function Get-BingdaRoot([string]$Root){
  $path=[IO.Path]::GetFullPath($Root).TrimEnd('\')
  $extension=Join-Path $path 'extension'
  foreach($directory in @($path,$extension)){
    $item=Get-Item -LiteralPath $directory -ErrorAction Stop
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '请在并答的原安装目录中运行更新工具。'}
  }
  $manifestPath=Join-Path $extension 'manifest.json'
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if($manifest.name -ne '并答 · 多模型答题助手' -or $manifest.version -notmatch '^\d+(\.\d+){1,3}$'){throw '不是有效的并答安装目录。'}
  return [pscustomobject]@{path=$path;version=$manifest.version}
}

function Assert-BingdaChild([string]$Root,[string]$Path){
  $parent=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\'
  $child=[IO.Path]::GetFullPath($Path)
  if(-not $child.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase)){throw '更新文件路径超出安装目录。'}
}

function Remove-BingdaStage([string]$Root,[string]$Stage){
  Assert-BingdaChild $Root $Stage
  if([IO.Path]::GetFileName($Stage) -notmatch '^\.bingda-update-[0-9a-f]{32}$'){throw '不能清理非更新临时目录。'}
  if(Test-Path -LiteralPath $Stage){
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($Stage,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
  }
}

function Get-BingdaProtocolCommand([string]$Root){
  $scriptPath=Join-Path ([IO.Path]::GetFullPath($Root)) 'update.ps1'
  $powershellPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  return ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -FromExtension -Uri "%1"' -f $powershellPath,$scriptPath)
}

function Install-BingdaProtocol([string]$Root){
  $installed=Get-BingdaRoot $Root
  $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\bingda-ai-update')
  try{
    $key.SetValue('','URL:并答在线更新',[Microsoft.Win32.RegistryValueKind]::String)
    $key.SetValue('URL Protocol','',[Microsoft.Win32.RegistryValueKind]::String)
    $command=$key.CreateSubKey('shell\open\command')
    try{$command.SetValue('',(Get-BingdaProtocolCommand $installed.path),[Microsoft.Win32.RegistryValueKind]::String)}finally{$command.Dispose()}
  }finally{$key.Dispose()}
}

function Assert-BingdaMetadata($Metadata){
  if($Metadata.version -notmatch '^\d+(\.\d+){1,3}$'){throw '线上更新版本无效。'}
  if($Metadata.url -notmatch '^https://github\.com/NINIFM/edge-answer-hub/releases/download/v\d+\.\d+\.\d+(?:\.\d+)?/bingda-edge\.zip$'){throw '更新下载地址不属于并答的 GitHub 发布包。'}
  if($Metadata.sha256 -notmatch '^[0-9a-fA-F]{64}$'){throw '线上更新校验信息无效。'}
}

function Get-BingdaUpdateInfo{
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $url='https://raw.githubusercontent.com/NINIFM/edge-answer-hub/main/update.json?t='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $response=Invoke-WebRequest -UseBasicParsing -Uri $url -Headers @{'User-Agent'='BingdaUpdater'} -TimeoutSec 25
  $metadata=$response.Content | ConvertFrom-Json
  Assert-BingdaMetadata $metadata
  return $metadata
}

function Update-BingdaInstallation([string]$Root,$Metadata,[string]$ArchivePath){
  $installed=Get-BingdaRoot $Root
  Assert-BingdaMetadata $Metadata
  if([version]$Metadata.version -le [version]$installed.version){return [pscustomobject]@{status='current';version=$installed.version}}
  $stage=Join-Path $installed.path ('.bingda-update-'+[Guid]::NewGuid().ToString('N'))
  Assert-BingdaChild $installed.path $stage
  New-Item -ItemType Directory -Path $stage | Out-Null
  $retainRecovery=$false
  try{
    if(-not $ArchivePath){
      $ArchivePath=Join-Path $stage 'release.zip'
      Write-Host '正在从 GitHub 下载最新版…'
      Invoke-WebRequest -UseBasicParsing -Uri $Metadata.url -Headers @{'User-Agent'='BingdaUpdater'} -OutFile $ArchivePath -TimeoutSec 60 | Out-Null
    }
    $archiveFile=Get-Item -LiteralPath $ArchivePath
    if($archiveFile.Length -gt 20MB){throw '更新安装包过大，已停止更新。'}
    if((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $Metadata.sha256){throw '安装包校验失败，未替换原文件。'}
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip=[IO.Compression.ZipFile]::OpenRead($ArchivePath)
    $files=New-Object 'System.Collections.Generic.List[string]'
    $seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $payload=Join-Path $stage 'new'
    try{
      if($zip.Entries.Count -gt 64){throw '更新包文件数量异常。'}
      $total=0L
      foreach($entry in $zip.Entries){
        $name=$entry.FullName
        $allowed=$name -cmatch '^extension/[a-z0-9][a-z0-9.-]*\.(?:js|mjs|json|html|css|svg|png|ico)$' -or $name -cin @('LICENSE','安装说明.txt','更新并答.cmd','update.ps1')
        if(-not $allowed -or -not $seen.Add($name) -or $name.Contains('..') -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw ('更新包包含不允许的文件路径：'+$name)}
        $total+=$entry.Length
        if($entry.Length -gt 8MB -or $total -gt 20MB){throw '更新包解压大小异常。'}
        $destination=Join-Path $payload $name
        Assert-BingdaChild $stage $destination
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
        $inputStream=$entry.Open();$outputStream=[IO.File]::Create($destination)
        try{$inputStream.CopyTo($outputStream)}finally{$inputStream.Dispose();$outputStream.Dispose()}
        $files.Add($name)
      }
    }finally{$zip.Dispose()}
    $required=@('LICENSE','安装说明.txt','更新并答.cmd','update.ps1','extension/content.js','extension/controller.mjs','extension/core.mjs','extension/dashboard.css','extension/dashboard.html','extension/dashboard.mjs','extension/help.html','extension/manifest.json','extension/page-bridge.js','extension/providers.mjs','extension/worker.mjs')
    foreach($name in $required){if(-not $seen.Contains($name)){throw ('更新包缺少必要文件：'+$name)}}
    $newManifest=Get-Content -LiteralPath (Join-Path $payload 'extension/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($newManifest.name -ne '并答 · 多模型答题助手' -or $newManifest.version -ne $Metadata.version -or $newManifest.manifest_version -ne 3){throw '安装包版本与线上更新版本不一致。'}
    $ordered=@($files | Where-Object {$_ -ne 'extension/manifest.json'} | Sort-Object)+@('extension/manifest.json')
    $originals=@{}
    foreach($name in $ordered){
      $destination=Join-Path $installed.path $name
      Assert-BingdaChild $installed.path $destination
      $exists=Test-Path -LiteralPath $destination
      $backup=Join-Path (Join-Path $stage 'old') $name
      if($exists){
        $item=Get-Item -LiteralPath $destination
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw ('目标文件类型异常：'+$name)}
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($backup)) -Force | Out-Null
        [IO.File]::Copy($destination,$backup,$false)
      }
      $originals[$name]=[pscustomobject]@{exists=$exists;backup=$backup}
    }
    $applied=New-Object 'System.Collections.Generic.List[string]'
    try{
      foreach($name in $ordered){
        $destination=Join-Path $installed.path $name
        $source=Join-Path $payload $name
        if($originals[$name].exists){[IO.File]::Replace($source,$destination,$originals[$name].backup)}else{[IO.File]::Move($source,$destination)}
        $applied.Add($name)
      }
    }catch{
      $failure=$_.Exception.Message
      try{
        Add-Type -AssemblyName Microsoft.VisualBasic
        for($index=$applied.Count-1;$index -ge 0;$index--){
          $name=$applied[$index];$destination=Join-Path $installed.path $name
          Assert-BingdaChild $installed.path $destination
          if($originals[$name].exists){[IO.File]::Copy($originals[$name].backup,$destination,$true)}else{
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($destination,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
          }
        }
      }catch{$retainRecovery=$true;throw ('更新失败，恢复文件保留在 '+$stage+'。原因：'+$failure+'；回滚错误：'+$_.Exception.Message)}
      throw ('文件替换失败，已回滚并保留原版本：'+$failure)
    }
    return [pscustomobject]@{status='updated';version=$Metadata.version}
  }finally{if(-not $retainRecovery){Remove-BingdaStage $installed.path $stage}}
}

function Start-BingdaUpdater{
  if($FromExtension -and ($Setup -or $Uri -cne 'bingda-ai-update://run/')){throw '更新启动地址无效。'}
  $installed=Get-BingdaRoot $PSScriptRoot
  $hash=[Security.Cryptography.SHA256]::Create()
  try{$rootId=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($installed.path.ToLowerInvariant())))).Replace('-','')}finally{$hash.Dispose()}
  $mutex=[Threading.Mutex]::new($false,('Local\BingdaUpdate-'+$rootId))
  $acquired=$false
  try{
    try{$acquired=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true}
    if(-not $acquired){throw '已有更新工具正在运行，请等待它完成。'}
    if($Setup){
      Install-BingdaProtocol $installed.path
      Write-Host '已为当前 Windows 用户启用面板的一键更新入口。'
    }
    Write-Host ('当前版本：'+$installed.version+'；正在检查 GitHub 最新版…')
    $metadata=Get-BingdaUpdateInfo
    $result=Update-BingdaInstallation -Root $installed.path -Metadata $metadata
    if($result.status -eq 'updated'){
      Write-Host ('已更新到 '+$result.version+'。请在 Edge 的 edge://extensions 点击并答的“重新加载”，再刷新面板和模型网页。') -ForegroundColor Green
    }else{Write-Host ('当前已是 '+$result.version+'，无需替换文件。') -ForegroundColor Green}
  }finally{if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose()}
}

if($MyInvocation.InvocationName -ne '.'){
  [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
  $exitCode=0
  try{Start-BingdaUpdater}catch{Write-Host ('更新未完成：'+$_.Exception.Message) -ForegroundColor Red;$exitCode=1}
  if($FromExtension){Read-Host '按回车关闭更新窗口' | Out-Null}
  exit $exitCode
}
