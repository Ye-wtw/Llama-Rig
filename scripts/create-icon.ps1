Add-Type -AssemblyName System.Drawing

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-RoundRectPath {
  param(
    [float] $X,
    [float] $Y,
    [float] $Width,
    [float] $Height,
    [float] $Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconPng {
  param(
    [string] $Path,
    [int] $Size
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $scale = $Size / 256.0
  $rect = New-Object System.Drawing.RectangleF (12 * $scale), (12 * $scale), (232 * $scale), (232 * $scale)
  $bgPath = New-RoundRectPath $rect.X $rect.Y $rect.Width $rect.Height (46 * $scale)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 17, 22, 17)), ([System.Drawing.Color]::FromArgb(255, 80, 111, 81)), 135
  $graphics.FillPath($brush, $bgPath)

  $shine = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(42, 255, 255, 255)), ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)), 90
  $graphics.FillPath($shine, $bgPath)

  $accentPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 207, 235, 196)), (7 * $scale)
  $accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($accentPen, (70 * $scale), (184 * $scale), (188 * $scale), (70 * $scale))

  $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 216, 240, 207))
  $graphics.FillEllipse($dotBrush, (177 * $scale), (59 * $scale), (23 * $scale), (23 * $scale))

  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 245, 250, 241))
  $mutedBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 216, 235, 207))
  $llFont = New-Object System.Drawing.Font 'Segoe UI', (78 * $scale), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $cppFont = New-Object System.Drawing.Font 'Segoe UI', (33 * $scale), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)

  $graphics.DrawString('ll', $llFont, $textBrush, (54 * $scale), (57 * $scale))
  $graphics.DrawString('cpp', $cppFont, $mutedBrush, (88 * $scale), (143 * $scale))

  $graphics.Dispose()
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

function Write-PngIco {
  param(
    [string] $PngPath,
    [string] $IcoPath,
    [int] $Size
  )

  $bytes = [System.IO.File]::ReadAllBytes($PngPath)
  $stream = [System.IO.File]::Open($IcoPath, [System.IO.FileMode]::Create)
  $writer = New-Object System.IO.BinaryWriter $stream
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]1)
  $writer.Write([Byte]($(if ($Size -ge 256) { 0 } else { $Size })))
  $writer.Write([Byte]($(if ($Size -ge 256) { 0 } else { $Size })))
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$bytes.Length)
  $writer.Write([UInt32]22)
  $writer.Write($bytes)
  $writer.Dispose()
  $stream.Dispose()
}

$png256 = Join-Path $assets 'llama-cpp.png'
$png32 = Join-Path $assets 'llama-cpp-tray.png'
$ico = Join-Path $assets 'llama-cpp.ico'

New-IconPng -Path $png256 -Size 256
New-IconPng -Path $png32 -Size 32
Write-PngIco -PngPath $png256 -IcoPath $ico -Size 256

Write-Output "Created $png256"
Write-Output "Created $png32"
Write-Output "Created $ico"
