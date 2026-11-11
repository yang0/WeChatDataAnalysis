param([Parameter(Mandatory=$true)][string]$DllPath,[switch]$ProbeOnly,[switch]$FindOnly)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Emit($value){ [Console]::WriteLine(($value|ConvertTo-Json -Compress -Depth 5)) }
try {
  if($FindOnly){
    $process=Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'"|Where-Object{$_.ExecutablePath}|Select-Object -First 1
    Emit @{type='found';exe=if($process){$process.ExecutablePath}else{''}}
    exit 0
  }
  if(-not [Environment]::Is64BitProcess){throw '请使用 64 位 Magpie / PowerShell'}
  if(-not (Test-Path -LiteralPath $DllPath -PathType Leaf)){throw '缺少 Windows 密钥组件，请重新安装插件'}
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WeChatKeyBridge {
  [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string path,IntPtr file,uint flags);
  [DllImport("kernel32",CharSet=CharSet.Ansi,ExactSpelling=true,SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return:MarshalAs(UnmanagedType.I1)] delegate bool InitFn(uint pid,IntPtr p,IntPtr m,int offset);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return:MarshalAs(UnmanagedType.I1)] delegate bool PollFn(StringBuilder key,int n,StringBuilder md5,int m);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return:MarshalAs(UnmanagedType.I1)] delegate bool CleanFn();
  static IntPtr handle;
  static InitFn init;static PollFn poll;static CleanFn clean;
  static T Bind<T>(string name) where T:class {var p=GetProcAddress(handle,name);if(p==IntPtr.Zero)throw new Exception("Missing native export: "+name);return Marshal.GetDelegateForFunctionPointer(p,typeof(T)) as T;}
  public static void Load(string path){handle=LoadLibraryEx(path,IntPtr.Zero,8);if(handle==IntPtr.Zero)throw new Exception("Native component could not load: "+Marshal.GetLastWin32Error());init=Bind<InitFn>("InitializeHook");poll=Bind<PollFn>("PollKeyData");clean=Bind<CleanFn>("CleanupHook");}
  public static volatile bool Canceled;
  public static void WatchCancel(){var thread=new System.Threading.Thread(()=>{Console.ReadLine();Canceled=true;});thread.IsBackground=true;thread.Start();}
  public static bool Initialize(uint pid){return init(pid,IntPtr.Zero,IntPtr.Zero,0);}
  public static string Poll(){var key=new StringBuilder(128);var md5=new StringBuilder(128);return poll(key,key.Capacity,md5,md5.Capacity)?key.ToString():"";}
  public static void Close(){if(handle!=IntPtr.Zero){try{if(clean!=null)clean();}finally{FreeLibrary(handle);handle=IntPtr.Zero;}}}
}
'@
  [WeChatKeyBridge]::Load([IO.Path]::GetFullPath($DllPath))
  try {
    if($ProbeOnly){Emit @{type='probe';ok=$true;sample=[WeChatKeyBridge]::Poll()};exit 0}
    $inputLine=[Console]::ReadLine()
    $request=$inputLine|ConvertFrom-Json
    if($request.restart -ne $true){throw '请先勾选同意重启微信'}
    $exe=[string]$request.exe
    if(-not $exe){$running=Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'"|Where-Object{$_.ExecutablePath}|Select-Object -First 1;if($running){$exe=$running.ExecutablePath}}
    if(-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)){throw '请先启动微信，或选择 Weixin.exe / WeChat.exe'}
    $exe=(Get-Item -LiteralPath $exe).FullName
    if([IO.Path]::GetFileName($exe) -notin @('Weixin.exe','WeChat.exe')){throw '请选择微信程序 Weixin.exe / WeChat.exe'}
    Emit @{type='progress';message='正在重启微信，请在微信窗口完成登录…'}
    $targets=Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'"|Where-Object{$_.ExecutablePath -eq $exe}
    foreach($target in $targets){Stop-Process -Id $target.ProcessId -ErrorAction Stop}
    foreach($target in $targets){Wait-Process -Id $target.ProcessId -Timeout 8 -ErrorAction SilentlyContinue}
    $launched=Start-Process -FilePath $exe -WorkingDirectory ([IO.Path]::GetDirectoryName($exe)) -PassThru
    Start-Sleep -Seconds 2
    $candidates=Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'"|Where-Object{$_.ExecutablePath -eq $exe}|Sort-Object {([string]$_.CommandLine).Length}
    $targetPid=if($candidates){[uint32]($candidates|Select-Object -First 1).ProcessId}else{[uint32]$launched.Id}
    if(-not [WeChatKeyBridge]::Initialize($targetPid)){throw '密钥组件初始化失败，请以管理员身份运行 Magpie，并确认微信版本受支持'}
    [WeChatKeyBridge]::WatchCancel()
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    while([DateTime]::UtcNow -lt $deadline){
      if([WeChatKeyBridge]::Canceled){Emit @{type='complete';state='canceled'};exit 0}
      $key=[WeChatKeyBridge]::Poll()
      if($key -match '^[0-9a-fA-F]{64}$'){Emit @{type='key';key=$key};Emit @{type='complete';state='completed'};exit 0}
      Start-Sleep -Milliseconds 100
    }
    throw '获取密钥超时，请完成微信登录；若版本不兼容可填写已有密钥'
  } finally {[WeChatKeyBridge]::Close()}
} catch {
  Emit @{type='failure';message=$_.Exception.Message}
  Emit @{type='complete';state='error'}
  exit 1
}
