$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$roots = @()
foreach ($key in @('HKCU:\Software\Tencent\WeChat','HKCU:\Software\Tencent\Weixin')) {
  try {
    $value = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
    if ($value.FileSavePath) { $roots += [Environment]::ExpandEnvironmentVariables([string]$value.FileSavePath) }
  } catch { }
}
$documents = [Environment]::GetFolderPath('MyDocuments')
try {
  $personal = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').Personal
  if ($personal) { $documents = [Environment]::ExpandEnvironmentVariables([string]$personal) }
} catch { }
$drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object { $_.RootDirectory.FullName })
$exe = ''
try {
  $running = Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'" | Where-Object { $_.ExecutablePath } | Select-Object -First 1
  if ($running) { $exe = $running.ExecutablePath }
} catch { }
[Console]::WriteLine((@{ documents=$documents; roots=@($roots); drives=@($drives); exe=$exe } | ConvertTo-Json -Compress -Depth 3))
