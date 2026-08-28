# 运动量验收脚本 — 对录屏视频计算模型区域帧间差曲线（与 MinikoMew 基线同管线）
# 用法: pwsh -File acceptance-motion-curve.ps1 -VideoPath <录屏.mp4> [-CropRightPct 60] [-CropLeftPct 25]
# 输出: 每 10s 的 AVG/MAX 帧间差表。参考值: 视频基线 AVG 5-6 / 峰值 15-20 / 永不归零。
# 改前基线录屏建议先录一份存为 before.mp4，改后录 after.mp4，两表并排对比。
param(
  [Parameter(Mandatory=$true)][string]$VideoPath,
  [double]$CropRightPct = 60,
  [double]$SkipLeftPct = 25
)
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:TEMP "live2d-acceptance-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $work | Out-Null
Push-Location $work
try {
  & ffmpeg -y -v error -i $VideoPath -vf "crop=iw*$($CropRightPct/100):ih:iw*$($SkipLeftPct/100):0,tblend=all_mode=difference,signalstats,metadata=print:file=motion.csv" -an -f null NUL
  $pts = $null; $samples = @{}
  foreach ($line in Get-Content "$work\motion.csv") {
    if ($line -match 'pts_time:(\d+\.?\d*)') { $pts = [double]$Matches[1] }
    elseif ($line -match 'lavfi\.signalstats\.YAVG=(\d+\.?\d*)') { if ($pts -ne $null) { $samples[$pts] = [double]$Matches[1] } }
  }
  Write-Output "FRAMES: $($samples.Count)"
  Write-Output "SEC  AVG_YDIFF  MAX_YDIFF"
  $bucketed = $samples.GetEnumerator() | Group-Object { [math]::Floor($_.Key/10)*10 } | Sort-Object { [double]$_.Name }
  foreach ($b in $bucketed) {
    $vals = $b.Group | ForEach-Object { $_.Value }
    "{0,4}  {1:N4}     {2:N4}" -f $b.Name, ($vals | Measure-Object -Average).Average, ($vals | Measure-Object -Maximum).Maximum
  }
  $all = $samples.Values
  Write-Output ("TOTAL  AVG {0:N4}  MAX {1:N4}  MIN10sAVG {2:N4}" -f ($all | Measure-Object -Average).Average, ($all | Measure-Object -Maximum).Maximum, ($bucketed | ForEach-Object { ($_.Group | ForEach-Object { $_.Value } | Measure-Object -Average).Average } | Measure-Object -Minimum).Minimum)
} finally { Pop-Location; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
