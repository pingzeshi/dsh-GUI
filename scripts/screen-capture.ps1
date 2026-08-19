# scripts/screen-capture.ps1 — 屏幕级截图（CopyFromScreen，规避 capturePage 合成器缺陷）
# 前置：DSH_SHOT_HOLD=1 启动 electron scripts/shot.js（窗口停留 splash 6s、error 8s）
# 用法：pwsh -File scripts/screen-capture.ps1
param(
  [string]$ElectronExe = 'node_modules\electron\dist\electron.exe',
  [string]$OutSplash = 'docs\art\screen-splash.png',
  [string]$OutError = 'docs\art\screen-error.png'
)

$env:DSH_SHOT_HOLD = '1'
$app = Start-Process -FilePath (Join-Path (Get-Location) $ElectronExe) -ArgumentList 'scripts/shot.js' -PassThru

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[Win32Shot]::SetProcessDPIAware() | Out-Null

function Save-WindowShot([string]$outFile) {
  $h = $app.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { Write-Host "no window handle"; return $false }
  $r = New-Object Win32Shot+RECT
  [Win32Shot]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
  if ($w -le 0 -or $hgt -le 0) { return $false }
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($w, $hgt)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hgt)))
  $bmp.Save((Join-Path (Get-Location) $outFile), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "saved $outFile ($w x $hgt)"
  return $true
}

$deadline = (Get-Date).AddSeconds(30)
$splashDone = $false
$last = ''
while ((Get-Date) -lt $deadline -and -not $app.HasExited) {
  $app.Refresh()
  $title = $app.MainWindowTitle
  if ($title -ne $last) { Write-Host ("title: [" + $title + "]"); $last = $title }
  if (-not $splashDone -and $title -eq 'DSH Desktop') {
    Start-Sleep -Milliseconds 2600 # 等逐字符入场（最后一位 delay .9s）+ 粒子收敛
    if (Save-WindowShot $OutSplash) { $splashDone = $true }
  }
  if ($splashDone -and $title -ne 'DSH Desktop' -and $title.StartsWith('DSH Desktop')) {
    Start-Sleep -Milliseconds 2600 # 等错误页入场/描边/抖动动画完成
    if (Save-WindowShot $OutError) { break }
  }
  Start-Sleep -Milliseconds 300
}
Write-Host "title at end: [$($app.MainWindowTitle)]"
if (-not $app.HasExited) { $app.Kill() }
