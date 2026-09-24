# Mashawerr API Auto Commit & Push Script
param(
    [string]$Message = ""
)

$apiDir = $PSScriptRoot
Set-Location $apiDir

# Check status
$status = git status --porcelain
if (-not $status) {
    Write-Host "[INFO] No changes detected in $apiDir." -ForegroundColor Cyan
    exit 0
}

# Verify JS syntax on modified files
$modifiedJs = git status --porcelain | Where-Object { $_ -match '\.js$' } | ForEach-Object { ($_.Substring(3)).Trim() }
$hasError = $false
foreach ($file in $modifiedJs) {
    if (Test-Path $file) {
        $check = node -c "$file" 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Syntax error in $file : $check" -ForegroundColor Red
            $hasError = $true
        }
    }
}

if ($hasError) {
    Write-Host "[ABORT] Push aborted due to JS syntax errors. Fix errors before pushing to production!" -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($Message)) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Message = "Auto update backend: $timestamp"
}

Write-Host "[1/3] Adding changes..." -ForegroundColor Yellow
git add -A

Write-Host "[2/3] Committing changes: '$Message'..." -ForegroundColor Yellow
git commit -m "$Message"

Write-Host "[3/3] Pushing to origin main..." -ForegroundColor Yellow
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "[SUCCESS] Backend changes pushed to GitHub successfully! Render is deploying..." -ForegroundColor Green
} else {
    Write-Host "[ERROR] Git push failed." -ForegroundColor Red
}
