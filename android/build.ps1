# Builds the Drop Off APKs from the web prototype in ..\prototype.
#   Drop Off Business  (vendor app, standalone)      com.dropoff.business
#   Drop Off Rider     (rider/driver app, standalone) com.dropoff.rider
#   Drop Off           (every role, incl. ops)        com.dropoff.app
# Uses aapt2 + javac + d8 + zipalign + apksigner directly (no Gradle).
# Backends:
#   (default)          on-device: the database and backend run inside the app (devserver\build-local.mjs).
#                      Works on any phone with no server; each phone keeps its own data.
#   -Hosted            uses prototype\config.js (run scripts\gen-config.mjs for a hosted Supabase project).
#   -DevHost <ip>      uses the dev server on this PC over Wi-Fi (development only: allows plain http).
param([string[]]$Apps = @('business', 'rider', 'all'), [string]$Version = '2.1', [int]$VersionCode = 3, [string]$DevHost = '', [switch]$Hosted)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$tc = Join-Path $root 'toolchain'
$jdk = (Get-ChildItem (Join-Path $tc 'jdk') -Directory | Select-Object -First 1).FullName
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$sdk = Join-Path $tc 'sdk'
$bt = Join-Path $sdk 'build-tools\34.0.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
$proto = (Resolve-Path (Join-Path $root '..\prototype')).Path
$bld = Join-Path $root 'build'
$out = Join-Path $root 'out'
New-Item -ItemType Directory -Force $bld, $out | Out-Null

function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) failed with exit code $LASTEXITCODE" }
}

# Signing key for the demo builds (a real release would use a protected upload key).
$ks = Join-Path $root 'dropoff-demo.keystore'
if (-not (Test-Path $ks)) {
  Run 'keytool' @('-genkeypair', '-keystore', $ks, '-alias', 'dropoff', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-storepass', 'dropoff-demo', '-keypass', 'dropoff-demo', '-dname', 'CN=Drop Off Demo, O=Drop Off, C=UG')
}

# Compile the shared native shell once.
$classes = Join-Path $bld 'classes'; $dex = Join-Path $bld 'dex'
Remove-Item $classes, $dex -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $classes, $dex | Out-Null
Run 'javac' @('-source', '8', '-target', '8', '-bootclasspath', $androidJar, '-Xlint:-options', '-d', $classes, (Join-Path $root 'src\com\dropoff\shell\MainActivity.java'))
$classFiles = (Get-ChildItem $classes -Recurse -Filter *.class).FullName
Run (Join-Path $bt 'd8.bat') (@('--min-api', '26', '--lib', $androidJar, '--output', $dex) + $classFiles)

# Backend config bundled into every APK.
$cleartext = ''
$onDevice = -not $DevHost -and -not $Hosted
if ($onDevice) {
  Write-Output '== Building the on-device bundle (database + backend inside the app)'
  Push-Location (Join-Path $root '..\devserver')
  $bundle = Join-Path $bld 'on-device'
  try { Run (Join-Path $root '..\tools\node\node.exe') @('build-local.mjs', $bundle) } finally { Pop-Location }
  $proto = $bundle
  $configJs = Get-Content (Join-Path $proto 'config.js') -Raw
} elseif ($DevHost) {
  # the dev server's anon key is fixed; read it from the running server, or from the generated config when it's stopped
  try { $keys = Invoke-RestMethod "http://localhost:54321/dev/keys" -TimeoutSec 3 }
  catch { $keys = @{ anonKey = ([regex]::Match((Get-Content (Join-Path $proto 'config.js') -Raw), '"supabaseAnonKey":"([^"]+)"')).Groups[1].Value } }
  if (-not $keys.anonKey) { throw 'No dev anon key: start devserver\restart.ps1 once so it writes prototype\config.js.' }
  $configJs = "window.DO_CONFIG = { source: 'devserver-lan', supabaseUrl: 'http://$($DevHost):54321', supabaseAnonKey: '$($keys.anonKey)', appUrl: 'http://$($DevHost):3000' };"
  $cleartext = 'android:usesCleartextTraffic="true"'
  Write-Output "Dev build: the apps will use the dev server at http://$($DevHost):54321 (same Wi-Fi, firewall must allow ports 54321)."
} else {
  $configJs = Get-Content (Join-Path $proto 'config.js') -Raw
  if ($configJs -match 'localhost') { Write-Warning 'prototype\config.js points at localhost, which a phone cannot reach. Run scripts\gen-config.mjs for a hosted project, or build with -DevHost <this PC''s Wi-Fi IP>.' }
}

$defs = @{
  business = @{ pkg = 'com.dropoff.business'; name = 'Drop Off Business'; mode = 'vendor'; bg = '#FFB71B'; pin = '#0D2B23'; mark = '#FFB71B'; bar = '#F3F5F4'; file = 'DropOff-Business' }
  rider    = @{ pkg = 'com.dropoff.rider';    name = 'Drop Off Rider';    mode = 'rider';  bg = '#0D2B23'; pin = '#FFB71B'; mark = '#0D2B23'; bar = '#0B211B'; file = 'DropOff-Rider' }
  all      = @{ pkg = 'com.dropoff.app';      name = 'Drop Off';          mode = '';       bg = '#163A30'; pin = '#FFFFFF'; mark = '#163A30'; bar = '#0D2B23'; file = 'DropOff-All' }
}

foreach ($app in $Apps) {
  $d = $defs[$app]
  Write-Output "== Building $($d.name) ($($d.pkg))"
  $w = Join-Path $bld $app
  Remove-Item $w -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($sub in 'res\values', 'res\drawable', 'res\mipmap-anydpi-v26', 'assets\www') { New-Item -ItemType Directory -Force (Join-Path $w $sub) | Out-Null }

  Set-Content (Join-Path $w 'res\values\strings.xml') "<?xml version=`"1.0`" encoding=`"utf-8`"?><resources><string name=`"app_name`">$($d.name)</string></resources>" -Encoding utf8
  Set-Content (Join-Path $w 'res\values\colors.xml') "<?xml version=`"1.0`" encoding=`"utf-8`"?><resources><color name=`"ic_bg`">$($d.bg)</color></resources>" -Encoding utf8
  Set-Content (Join-Path $w 'res\drawable\ic_fg.xml') @"
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <group android:translateX="22" android:translateY="22" android:scaleX="2" android:scaleY="2">
    <path android:fillColor="$($d.pin)" android:pathData="M16 5.5c-4.3 0-7.8 3.3-7.8 7.6 0 5.5 7.8 12.4 7.8 12.4s7.8-6.9 7.8-12.4c0-4.3-3.5-7.6-7.8-7.6z"/>
    <path android:strokeColor="$($d.mark)" android:strokeWidth="2.4" android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="M12.6 11.6 16 15l3.4-3.4"/>
  </group>
</vector>
"@ -Encoding utf8
  Set-Content (Join-Path $w 'res\mipmap-anydpi-v26\ic_launcher.xml') @"
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_bg"/><foreground android:drawable="@drawable/ic_fg"/></adaptive-icon>
"@ -Encoding utf8
  Set-Content (Join-Path $w 'AndroidManifest.xml') @"
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="$($d.pkg)">
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
  <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
  <application android:label="@string/app_name" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher" android:allowBackup="true" android:hardwareAccelerated="true" $cleartext android:theme="@android:style/Theme.Material.Light.NoActionBar">
    <activity android:name="com.dropoff.shell.MainActivity" android:exported="true" android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|smallestScreenSize" android:windowSoftInputMode="adjustResize">
      <meta-data android:name="statusColor" android:value="$($d.bar)"/>
      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
    </activity>
  </application>
</manifest>
"@ -Encoding utf8

  # Bundle the web app offline.
  $www = Join-Path $w 'assets\www'
  Copy-Item (Join-Path $proto 'app.css') $www
  Copy-Item (Join-Path $proto 'js') $www -Recurse
  Copy-Item (Join-Path $proto 'lib') $www -Recurse
  if ($onDevice) { Copy-Item (Join-Path $proto 'local') $www -Recurse }
  # every app page ships, so in-app links (other roles, the recipient page) keep working; the entry page becomes index.html
  foreach ($pg in 'app.html', 'app-vendor.html', 'app-rider.html', 'track.html') { Copy-Item (Join-Path $proto $pg) $www }
  Copy-Item (Join-Path $proto $(if ($d.mode) { "app-$($d.mode).html" } else { 'app.html' })) (Join-Path $www 'index.html')
  Set-Content (Join-Path $www 'config.js') $configJs -Encoding utf8
  # aapt silently gunzips and renames *.gz assets; keep the exact bytes under *.gz.bin (MainActivity maps them back)
  Get-ChildItem $www -Recurse -File -Filter *.gz | ForEach-Object { Rename-Item -LiteralPath $_.FullName -NewName ($_.Name + '.bin') }

  $resZip = Join-Path $w 'res.zip'; $base = Join-Path $w 'base.apk'; $aligned = Join-Path $w 'aligned.apk'
  Run (Join-Path $bt 'aapt2.exe') @('compile', '--dir', (Join-Path $w 'res'), '-o', $resZip)
  Run (Join-Path $bt 'aapt2.exe') @('link', '-o', $base, '-I', $androidJar, '--manifest', (Join-Path $w 'AndroidManifest.xml'), '--min-sdk-version', '26', '--target-sdk-version', '34', '--version-code', "$VersionCode", '--version-name', $Version, $resZip)
  Copy-Item (Join-Path $dex 'classes.dex') $w
  # Add assets and dex with aapt (v1) using forward-slash entry names. aapt2 -A on Windows writes
  # backslash paths, which Android cannot resolve. resources.arsc stays stored (uncompressed).
  Push-Location $w
  try {
    $assetPaths = Get-ChildItem 'assets' -Recurse -File | ForEach-Object { (Resolve-Path -Relative $_.FullName).TrimStart('.', '\').Replace('\', '/') }
    Run (Join-Path $bt 'aapt.exe') (@('add', 'base.apk', 'classes.dex') + $assetPaths) | Out-Null
  } finally { Pop-Location }
  Run (Join-Path $bt 'zipalign.exe') @('-p', '-f', '4', $base, $aligned)
  $apk = Join-Path $out "$($d.file).apk"
  Run (Join-Path $bt 'apksigner.bat') @('sign', '--ks', $ks, '--ks-key-alias', 'dropoff', '--ks-pass', 'pass:dropoff-demo', '--key-pass', 'pass:dropoff-demo', '--out', $apk, $aligned)
  Run (Join-Path $bt 'apksigner.bat') @('verify', $apk)
  Write-Output ("   -> {0} ({1:N2} MB)" -f $apk, ((Get-Item $apk).Length / 1MB))
}
Remove-Item (Join-Path $out '*.idsig') -ErrorAction SilentlyContinue
Write-Output 'Done.'
