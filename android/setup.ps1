# One-time toolchain setup for building the Drop Off APKs without Android Studio.
# Expects toolchain\jdk17.zip and toolchain\cmdline-tools.zip (downloaded beforehand).
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$tc = Join-Path $root 'toolchain'
$sdk = Join-Path $tc 'sdk'

if (-not (Test-Path (Join-Path $tc 'jdk'))) {
  Write-Output 'Extracting JDK 17...'
  Expand-Archive (Join-Path $tc 'jdk17.zip') (Join-Path $tc 'jdk') -Force
}
$jdk = (Get-ChildItem (Join-Path $tc 'jdk') -Directory | Select-Object -First 1).FullName
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

$latest = Join-Path $sdk 'cmdline-tools\latest'
if (-not (Test-Path $latest)) {
  Write-Output 'Extracting Android command-line tools...'
  $tmp = Join-Path $tc 'cmdline-tmp'
  Expand-Archive (Join-Path $tc 'cmdline-tools.zip') $tmp -Force
  New-Item -ItemType Directory -Force (Split-Path $latest) | Out-Null
  Move-Item (Join-Path $tmp 'cmdline-tools') $latest
  Remove-Item $tmp -Recurse -Force
}
$sdkm = Join-Path $latest 'bin\sdkmanager.bat'

Write-Output 'Accepting Android SDK licenses (approved by the user)...'
$yes = ('y' + [Environment]::NewLine) * 20
$yes | & $sdkm --sdk_root=$sdk --licenses | Out-Null

Write-Output 'Installing platform 34 and build-tools 34.0.0...'
& $sdkm --sdk_root=$sdk 'platforms;android-34' 'build-tools;34.0.0' 2>&1 | Select-String -Pattern 'Installing|done|Error|Warning' | ForEach-Object { $_.Line }

$ok = (Test-Path (Join-Path $sdk 'platforms\android-34\android.jar')) -and (Test-Path (Join-Path $sdk 'build-tools\34.0.0\aapt2.exe'))
Write-Output ("Toolchain ready: " + $ok)
