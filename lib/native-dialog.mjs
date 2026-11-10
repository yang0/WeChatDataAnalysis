import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function pickPath(kind, { platform = process.platform, runner = exec } = {}) {
  if (!['folder', 'exe'].includes(kind)) throw new Error('选择类型无效');
  let bin, args;
  if (platform === 'win32') {
    const script = kind === 'folder'
      ? 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="选择文件夹"; if($d.ShowDialog() -eq "OK"){[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::WriteLine($d.SelectedPath)}'
      : 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter="微信程序 (*.exe)|*.exe"; if($d.ShowDialog() -eq "OK"){[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::WriteLine($d.FileName)}';
    bin = 'powershell.exe'; args = ['-NoProfile', '-STA', '-NonInteractive', '-Command', script];
  } else if (platform === 'darwin') {
    bin = 'osascript'; args = ['-e', 'POSIX path of (choose folder with prompt "选择文件夹")'];
  } else { bin = 'zenity'; args = ['--file-selection', '--directory', '--title=选择文件夹']; }
  try {
    const out = await runner(bin, args, { shell: false, windowsHide: true, timeout: 300000, maxBuffer: 16384 });
    const path = String(out.stdout || '').trim();
    if (/[\r\n\0]/.test(path) || path.length > 4096) throw new Error('选择路径无效');
    return path;
  } catch (error) {
    if (error.code === 1) return '';
    throw new Error('系统文件选择器不可用，请直接填写完整路径');
  }
}
