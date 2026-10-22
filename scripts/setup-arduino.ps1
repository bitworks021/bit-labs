$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $projectRoot ".tools"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())

try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/arduino/arduino-cli/releases/latest"
    $archive = $release.assets | Where-Object { $_.name -match "_Windows_64bit\.zip$" } | Select-Object -First 1
    $checksums = $release.assets | Where-Object { $_.name -match "checksums\.txt$" } | Select-Object -First 1

    if (-not $archive -or -not $checksums) {
        throw "The latest Arduino CLI release does not contain the expected Windows archive and checksum."
    }

    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $archivePath = Join-Path $temporaryDirectory $archive.name
    $checksumPath = Join-Path $temporaryDirectory $checksums.name
    Invoke-WebRequest -Uri $archive.browser_download_url -OutFile $archivePath
    Invoke-WebRequest -Uri $checksums.browser_download_url -OutFile $checksumPath

    $checksumLine = Get-Content $checksumPath | Where-Object { $_ -match "\s+$([regex]::Escape($archive.name))$" } | Select-Object -First 1
    if (-not $checksumLine) {
        throw "The published checksum for $($archive.name) was not found."
    }

    $expectedHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Arduino CLI archive checksum verification failed."
    }

    Expand-Archive -Path $archivePath -DestinationPath $temporaryDirectory
    $executable = Get-ChildItem -Path $temporaryDirectory -Filter "arduino-cli.exe" -File -Recurse | Select-Object -First 1
    if (-not $executable) {
        throw "The downloaded archive does not contain arduino-cli.exe."
    }

    New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
    Copy-Item -Path $executable.FullName -Destination (Join-Path $toolsDirectory "arduino-cli.exe") -Force
    Write-Output "Installed Arduino CLI $($release.tag_name) in .tools."
}
finally {
    if (Test-Path $temporaryDirectory) {
        Remove-Item -Path $temporaryDirectory -Recurse -Force
    }
}
