# Cross-compiles usage-core for every supported host into the VS Code adapter's
# bin/ folder, named usage-core-<platform>-<arch>[.exe] to match the extension's
# resolveCorePath(). Run from anywhere; paths are resolved relative to this script.
#
#   pwsh scripts/build-core.ps1
#
# Requires the Go toolchain on PATH. Pure-Go build (CGO disabled) so no C
# toolchain is needed for cross-compilation.

$ErrorActionPreference = "Stop"

$root    = Split-Path -Parent $PSScriptRoot
$coreDir = Join-Path $root "core"
$outDir  = Join-Path $root "adapters\vscode\bin"

New-Item -ItemType Directory -Force $outDir | Out-Null

# VS Code's process.platform / process.arch values map directly to these names.
$targets = @(
    @{ Platform = "win32";  Arch = "x64";   GOOS = "windows"; GOARCH = "amd64"; Ext = ".exe" },
    @{ Platform = "win32";  Arch = "arm64"; GOOS = "windows"; GOARCH = "arm64"; Ext = ".exe" },
    @{ Platform = "darwin"; Arch = "x64";   GOOS = "darwin";  GOARCH = "amd64"; Ext = "" },
    @{ Platform = "darwin"; Arch = "arm64"; GOOS = "darwin";  GOARCH = "arm64"; Ext = "" },
    @{ Platform = "linux";  Arch = "x64";   GOOS = "linux";   GOARCH = "amd64"; Ext = "" },
    @{ Platform = "linux";  Arch = "arm64"; GOOS = "linux";   GOARCH = "arm64"; Ext = "" }
)

Push-Location $coreDir
try {
    foreach ($t in $targets) {
        $name = "usage-core-$($t.Platform)-$($t.Arch)$($t.Ext)"
        $out  = Join-Path $outDir $name
        Write-Host "Building $name ..."
        $env:GOOS = $t.GOOS
        $env:GOARCH = $t.GOARCH
        $env:CGO_ENABLED = "0"
        go build -trimpath -ldflags "-s -w" -o $out .
        if ($LASTEXITCODE -ne 0) { throw "build failed for $name" }
    }
}
finally {
    Pop-Location
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
}

Write-Host "`nDone. Binaries in $outDir :"
Get-ChildItem $outDir -Filter "usage-core-*" | ForEach-Object {
    "{0,-32} {1,8:N0} KB" -f $_.Name, ($_.Length / 1KB)
}
