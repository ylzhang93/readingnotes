# setup.ps1 — one-time setup for texnote-reader (run with: powershell -ExecutionPolicy Bypass -File setup.ps1)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "== 1/3  config =="
if (-not (Test-Path "config.json")) {
    Copy-Item "config.example.json" "config.json"
    Write-Host "  created config.json from config.example.json"
    Write-Host "  >>> edit config.json and paste your API key into the `apiKey` field <<<"
} else {
    Write-Host "  config.json already exists (skipped)"
}

Write-Host "== 2/3  frontend libs (pdf.js + katex) =="
if (-not (Test-Path "public\vendor\pdf.min.js") -or -not (Test-Path "public\vendor\katex\katex.min.js")) {
    npm install
    New-Item -ItemType Directory -Force -Path "public\vendor" | Out-Null
    Copy-Item "node_modules\pdfjs-dist\build\pdf.min.js","node_modules\pdfjs-dist\build\pdf.worker.min.js" -Destination "public\vendor" -Force
    if (Test-Path "node_modules\pdfjs-dist\cmaps") { Copy-Item "node_modules\pdfjs-dist\cmaps" -Destination "public\vendor" -Recurse -Force }
    if (Test-Path "node_modules\pdfjs-dist\standard_fonts") { Copy-Item "node_modules\pdfjs-dist\standard_fonts" -Destination "public\vendor" -Recurse -Force }
    New-Item -ItemType Directory -Force -Path "public\vendor\katex" | Out-Null
    Copy-Item "node_modules\katex\dist\katex.min.js","node_modules\katex\dist\katex.min.css" -Destination "public\vendor\katex" -Force
    if (Test-Path "node_modules\katex\dist\fonts") { Copy-Item "node_modules\katex\dist\fonts" -Destination "public\vendor\katex" -Recurse -Force }
    Write-Host "  vendor files copied"
} else {
    Write-Host "  vendor files already present (skipped)"
}

Write-Host "== 3/3  readingnote.sty (LaTeX package) =="
$texmflocal = $null
try { $texmflocal = (& kpsewhich -var-value TEXMFLOCAL 2>$null | Select-Object -First 1) } catch { $texmflocal = $null }
if (-not $texmflocal -or $texmflocal.Trim() -eq '') { $texmflocal = "c:\texlive\texmf-local" }
$dst = Join-Path $texmflocal.Trim() "tex\latex\local\readingnote"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "readingnote\readingnote.sty" -Destination $dst -Force
try { texhash | Out-Null } catch { Write-Host "  (texhash not run automatically — run `texhash` yourself)" }
Write-Host "  installed readingnote.sty -> $dst"

Write-Host ""
Write-Host "Done. Start with:  node server.js"
Write-Host "Then open:        http://127.0.0.1:8910"
