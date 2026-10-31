package com.dropoff.shell;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Native shell for the Drop Off apps. The UI is the same web build that runs in the browser, bundled
 * under assets/www; it talks to the Supabase backend configured in assets/www/config.js.
 * The shell adds what a browser tab can't: device GPS for riders, the photo picker, the hardware back
 * button, and opening maps / payment pages / phone links in the right external app.
 */
public class MainActivity extends Activity {
    private static final int PICK_IMAGE = 41;
    private static final int LOCATION_REQUEST = 42;
    private WebView web;
    private ValueCallback<Uri[]> pendingUpload;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        applyBarColors();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);       // keeps the signed-in session (supabase-js uses localStorage)
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setGeolocationEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }
            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openOutside(Uri.parse(url));
            }
            // The bundled app is served on https://dropoff.local/ (a secure origin, so WebAssembly, IndexedDB
            // and fetch behave exactly as in a browser). Nothing on that host ever touches the network.
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!APP_HOST.equals(u.getHost())) return null;
                String p = u.getPath() == null || "/".equals(u.getPath()) ? "/index.html" : u.getPath();
                try {
                    // gzip files are packaged as *.gz.bin because aapt would otherwise unpack them
                    InputStream in = getAssets().open("www" + p + (p.endsWith(".gz") ? ".bin" : ""));
                    String mime = mimeOf(p);
                    WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text/") || mime.endsWith("javascript") ? "utf-8" : null, in);
                    Map<String, String> h = new HashMap<>();
                    h.put("Cache-Control", "no-cache");
                    r.setResponseHeaders(h);
                    return r;
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingUpload != null) pendingUpload.onReceiveValue(null);
                pendingUpload = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType(params != null && params.getAcceptTypes() != null && String.join(",", params.getAcceptTypes()).contains("pdf") ? "*/*" : "image/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a file"), PICK_IMAGE);
                } catch (Exception e) {
                    pendingUpload = null;
                    return false;
                }
                return true;
            }

            // Riders share their live position while online or on a job; ask Android for permission first.
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocation()) { callback.invoke(origin, true, false); return; }
                pendingGeo = callback;
                pendingGeoOrigin = origin;
                requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, LOCATION_REQUEST);
            }
        });
        setContentView(web);
        if (state != null) web.restoreState(state);
        else web.loadUrl("https://" + APP_HOST + "/index.html");
    }

    private static final String APP_HOST = "dropoff.local";

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".gz")) return "application/gzip";
        return "application/octet-stream";
    }

    /** The bundled app stays in the WebView; maps, payment pages, phone and SMS links open in their own apps. */
    private boolean openOutside(Uri uri) {
        if (uri == null || "file".equals(uri.getScheme()) || APP_HOST.equals(uri.getHost())) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
        return true;
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == LOCATION_REQUEST && pendingGeo != null) {
            pendingGeo.invoke(pendingGeoOrigin, hasLocation(), false);
            pendingGeo = null;
            pendingGeoOrigin = null;
        }
    }

    private void applyBarColors() {
        String hex = "#0D2B23";
        try {
            ActivityInfo info = getPackageManager().getActivityInfo(getComponentName(), PackageManager.GET_META_DATA);
            if (info.metaData != null && info.metaData.getString("statusColor") != null) hex = info.metaData.getString("statusColor");
        } catch (Exception ignored) { }
        int c = Color.parseColor(hex);
        Window w = getWindow();
        w.setStatusBarColor(c);
        w.setNavigationBarColor(c);
        boolean light = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000 > 160;
        if (light && Build.VERSION.SDK_INT >= 26) w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_IMAGE && pendingUpload != null) {
            Uri uri = (result == RESULT_OK && data != null) ? data.getData() : null;
            pendingUpload.onReceiveValue(uri == null ? null : new Uri[] { uri });
            pendingUpload = null;
        }
    }

    @Override
    public void onBackPressed() {
        // Let the web app pop its own navigation stack first; leave the app only when it has nowhere to go back to.
        web.evaluateJavascript("(window.DO && DO.androidBack && DO.androidBack()) ? 1 : 0", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if ("1".equals(handled)) return;
                if (web.canGoBack()) web.goBack(); // e.g. from the recipient page back to the app
                else exitApp();
            }
        });
    }

    private void exitApp() { super.onBackPressed(); }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); web.onResume(); }
}
