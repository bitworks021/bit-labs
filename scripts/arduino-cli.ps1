param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectRoot ".tools\arduino-cli.exe"
$config = Join-Path $projectRoot "arduino-cli.yaml"

if (-not (Test-Path $executable)) {
    Write-Error "Arduino CLI is not installed. Run 'npm run arduino:setup' first."
    exit 1
}

& $executable --config-file $config @Arguments
exit $LASTEXITCODE
