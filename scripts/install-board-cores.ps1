$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectRoot ".tools\arduino-cli.exe"
$config = Join-Path $projectRoot "arduino-cli.yaml"

if (-not (Test-Path $executable)) {
    throw "Arduino CLI is not installed. Run 'npm run arduino:setup' first."
}

& $executable --config-file $config core update-index
if ($LASTEXITCODE -ne 0) {
    throw "Arduino CLI could not update the board package indexes."
}

$cores = @("arduino:avr", "esp32:esp32", "esp8266:esp8266")
foreach ($core in $cores) {
    & $executable --config-file $config core install $core
    if ($LASTEXITCODE -ne 0) {
        throw "Arduino CLI could not install board core $core."
    }
}

& $executable --config-file $config core upgrade @cores
if ($LASTEXITCODE -ne 0) {
    throw "Arduino CLI could not upgrade the supported board cores."
}
