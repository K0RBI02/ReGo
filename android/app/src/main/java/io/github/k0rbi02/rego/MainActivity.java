package io.github.k0rbi02.rego;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** ReGo as an app: the UI is bundled in the app, only the data comes from the ReGo server. */
public class MainActivity extends AppCompatActivity {
    static final String HOST = "appassets.androidplatform.net";
    private WebView web;
    private WebViewAssetLoader loader;
    private ValueCallback<Uri[]> fileCb;
    private PermissionRequest pendingWebPerm;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;
    private boolean pendingPush;
    private static final int RC_PERM = 11, RC_FILE = 12, RC_NOTIF = 13, RC_GEO = 14;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        setupWebView();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (web != null && web.canGoBack()) web.goBack(); else { setEnabled(false); getOnBackPressedDispatcher().onBackPressed(); }
            }
        });
        // keep fetching notifications if they were switched on once
        SharedPreferences sp = getSharedPreferences("rego", MODE_PRIVATE);
        if (sp.getBoolean("push", false)) PollWorker.schedule(this);
        // After rotation, dark-mode change or the like restore the old state; if that fails, start normally
        if (b == null || web.restoreState(b) == null) web.loadUrl("https://" + HOST + startPath(getIntent()));
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);                 // fixed font size: the system font-size setting would otherwise shift the layout
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.window_bg));
        web.addJavascriptInterface(new Bridge(), "RegoNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath() == null ? "/" : u.getPath();
                // Page addresses without a file extension (/Meldungen, /Ticket …) point to the start page
                if (!path.contains(".")) {
                    return loader.shouldInterceptRequest(Uri.parse("https://" + HOST + "/index.html"));
                }
                return loader.shouldInterceptRequest(u);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* no app for it */ }
                return true;
            }
            // The web process was killed (low memory or crash). Without this method the whole app would crash with it.
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                if (v != web) return true;
                ViewGroup parent = (ViewGroup) web.getParent();
                if (parent != null) parent.removeView(web);
                web.destroy();
                web = null;
                setupWebView();
                web.loadUrl("https://" + HOST + "/");
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                // "Approximate" is enough (ReGo rounds the location to about a kilometer anyway)
                if (hasPerm(Manifest.permission.ACCESS_FINE_LOCATION) || hasPerm(Manifest.permission.ACCESS_COARSE_LOCATION)) { cb.invoke(origin, true, false); return; }
                pendingGeo = cb; pendingGeoOrigin = origin;
                ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, RC_GEO);
            }
            @Override public void onPermissionRequest(PermissionRequest req) {
                runOnUiThread(() -> {
                    boolean cam = false;
                    for (String r : req.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) cam = true;
                    if (!cam) { req.deny(); return; }
                    if (hasPerm(Manifest.permission.CAMERA)) { req.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}); return; }
                    pendingWebPerm = req;
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.CAMERA}, RC_PERM);
                });
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(p.createIntent(), RC_FILE); } catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
    }

    private String startPath(Intent i) {
        String p = i != null ? i.getStringExtra("path") : null;
        return p != null && p.startsWith("/") ? p : "/";
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        String p = i.getStringExtra("path");
        if (p == null || !p.startsWith("/") || web == null) return;
        final String url = "https://" + HOST + p;
        // If the UI is already running, it switches the page itself (so the same page with a different suffix works too, e.g. "#neu" or another incident); otherwise it loads normally
        web.evaluateJavascript("(function(){try{if(window.REGO&&window.REGO.navigate){window.REGO.navigate(" + JSONObject.quote(p) + ");return 1}}catch(e){}return 0})()",
                v -> { if (!"1".equals(v) && web != null) web.loadUrl(url); });
    }

    @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); if (web != null) web.saveState(o); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); PollWorker.clearBadge(this); }
    @Override protected void onPause() { if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        if (web != null) {
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private boolean hasPerm(String p) { return ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED; }

    @Override protected void onActivityResult(int rc, int res, Intent data) {
        super.onActivityResult(rc, res, data);
        if (rc == RC_FILE && fileCb != null) {
            Uri[] r = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    List<Uri> l = new ArrayList<>();
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) l.add(data.getClipData().getItemAt(i).getUri());
                    r = l.toArray(new Uri[0]);
                } else if (data.getData() != null) r = new Uri[]{data.getData()};
            }
            fileCb.onReceiveValue(r); fileCb = null;
        }
    }

    @Override public void onRequestPermissionsResult(int rc, String[] perms, int[] results) {
        super.onRequestPermissionsResult(rc, perms, results);
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (rc == RC_PERM && pendingWebPerm != null) {
            if (ok) pendingWebPerm.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}); else pendingWebPerm.deny();
            pendingWebPerm = null;
        } else if (rc == RC_GEO && pendingGeo != null) {
            boolean any = false; for (int r : results) if (r == PackageManager.PERMISSION_GRANTED) any = true;
            pendingGeo.invoke(pendingGeoOrigin, any, false); pendingGeo = null;
        } else if (rc == RC_NOTIF && pendingPush) {
            pendingPush = false;
            if (ok || Build.VERSION.SDK_INT < 33) finishPush(true); else pushResult(false, "");
        }
    }

    private void finishPush(boolean ok) {
        getSharedPreferences("rego", MODE_PRIVATE).edit().putBoolean("push", ok).apply();
        if (!ok) { pushResult(false, ""); return; }
        PollWorker.schedule(this);          // polling every ~15 min stays as a fallback
        try {                               // get the Firebase token (only if the app was built with Firebase)
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
                String tok = t.isSuccessful() && t.getResult() != null ? t.getResult() : "";
                getSharedPreferences("rego", MODE_PRIVATE).edit().putString("fcm", tok).apply();
                pushResult(true, tok);
            });
        } catch (Throwable e) { pushResult(true, ""); }
    }

    private void pushResult(boolean ok, String token) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript("window.__rgPushDone&&window.__rgPushDone(" + (ok ? "'" + token.replace("'", "") + "'" : "false") + ")", null); });
    }

    /** CSS color from the UI ("#rrggbb", "rgb(247, 247, 247)", "rgba(…)") to an Android color; null if unreadable. */
    static Integer cssColor(String s) {
        if (s == null) return null;
        String v = s.trim().toLowerCase(Locale.ROOT);
        try {
            if (v.startsWith("rgb")) {
                String[] p = v.substring(v.indexOf('(') + 1, v.indexOf(')')).trim().split("[,\\s/]+");
                return Color.rgb(Math.round(Float.parseFloat(p[0])), Math.round(Float.parseFloat(p[1])), Math.round(Float.parseFloat(p[2])));
            }
            return Color.parseColor(v);
        } catch (Exception e) { return null; }
    }

    /** Light background: then the status bar and navigation bar get dark icons. */
    static boolean isLight(int c) { return (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) > 150; }

    /** What the UI can call from the app (window.RegoNative). */
    class Bridge {
        /** Version number of the app for the line under "Strecken". */
        @JavascriptInterface public String appVersion() {
            try {
                String v = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                return v == null ? "" : v;
            } catch (Exception e) { return ""; }
        }
        @JavascriptInterface public void setBrightness(float v) {
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = v < 0 ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE : Math.min(1f, v);
                getWindow().setAttributes(lp);
            });
        }
        @JavascriptInterface public void keepScreenOn(boolean on) {
            runOnUiThread(() -> { if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); });
        }
        @JavascriptInterface public void setBars(String color) { setBarColors(color, color); }
        /** Color the status bar at the top and the navigation bar at the bottom separately (detail page: green card on top, white sheet below). */
        @JavascriptInterface public void setBarColors(String top, String bottom) {
            Integer t = cssColor(top), b = cssColor(bottom);
            if (t == null || b == null) return;
            final int ct = t, cb = b;
            runOnUiThread(() -> {
                try {
                    getWindow().setStatusBarColor(ct); getWindow().setNavigationBarColor(cb);
                    WindowInsetsControllerCompat ic = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                    ic.setAppearanceLightStatusBars(isLight(ct));
                    ic.setAppearanceLightNavigationBars(isLight(cb));
                } catch (Exception ignored) { }
            });
        }
        @JavascriptInterface public void enablePush(String device, String api) {
            getSharedPreferences("rego", MODE_PRIVATE).edit().putString("device", device).putString("api", api).apply();
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && !hasPerm(Manifest.permission.POST_NOTIFICATIONS)) {
                    pendingPush = true;
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, RC_NOTIF);
                } else finishPush(true);
            });
        }
        @JavascriptInterface public void disablePush() {
            getSharedPreferences("rego", MODE_PRIVATE).edit().putBoolean("push", false).apply();
            PollWorker.cancel(MainActivity.this);
        }
        /** Saves a file into the "Download" folder. true = saved, false = failed (the page, e.g. the error report, says so as well). */
        @JavascriptInterface public boolean saveFile(String name, String mime, String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, "Download");
                Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                try (OutputStream o = getContentResolver().openOutputStream(u)) { o.write(data); }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, name + " im Ordner „Download“ gespeichert", Toast.LENGTH_LONG).show());
                return true;
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Speichern fehlgeschlagen", Toast.LENGTH_LONG).show());
                return false;
            }
        }
    }
}
