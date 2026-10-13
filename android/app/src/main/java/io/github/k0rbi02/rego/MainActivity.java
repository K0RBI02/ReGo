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
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
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
import androidx.webkit.WebViewAssetLoader;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** ReGo als App: die Oberfläche steckt in der App, nur die Daten kommen vom ReGo-Server. */
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

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setBackgroundColor(Color.parseColor("#E4F4D0"));
        web.addJavascriptInterface(new Bridge(), "RegoNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath() == null ? "/" : u.getPath();
                // Seitenadressen ohne Dateiendung (/Meldungen, /Ticket …) zeigen auf die Startseite
                if (!path.contains(".")) {
                    return loader.shouldInterceptRequest(Uri.parse("https://" + HOST + "/index.html"));
                }
                return loader.shouldInterceptRequest(u);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* keine App dafür */ }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)) { cb.invoke(origin, true, false); return; }
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
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (web.canGoBack()) web.goBack(); else { setEnabled(false); getOnBackPressedDispatcher().onBackPressed(); }
            }
        });
        // Meldungen weiter abholen, wenn sie schon einmal eingeschaltet wurden
        SharedPreferences sp = getSharedPreferences("rego", MODE_PRIVATE);
        if (sp.getBoolean("push", false)) PollWorker.schedule(this);
        if (b == null) web.loadUrl("https://" + HOST + startPath(getIntent()));
        else web.restoreState(b);
    }

    private String startPath(Intent i) {
        String p = i != null ? i.getStringExtra("path") : null;
        return p != null && p.startsWith("/") ? p : "/";
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        String p = i.getStringExtra("path");
        if (p != null && p.startsWith("/")) web.loadUrl("https://" + HOST + p);
    }

    @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }
    @Override protected void onResume() { super.onResume(); web.onResume(); PollWorker.clearBadge(this); }
    @Override protected void onPause() { web.onPause(); super.onPause(); }
    @Override protected void onDestroy() { if (web != null) { web.destroy(); } super.onDestroy(); }

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
            if (ok || Build.VERSION.SDK_INT < 33) finishPush(true); else pushResult(false);
        }
    }

    private void finishPush(boolean ok) {
        getSharedPreferences("rego", MODE_PRIVATE).edit().putBoolean("push", ok).apply();
        if (ok) PollWorker.schedule(this);
        pushResult(ok);
    }

    private void pushResult(boolean ok) {
        runOnUiThread(() -> web.evaluateJavascript("window.__rgPushDone&&window.__rgPushDone(" + ok + ")", null));
    }

    /** Was die Oberfläche von der App aus aufrufen kann (window.RegoNative). */
    class Bridge {
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
        @JavascriptInterface public void setBars(String color) {
            runOnUiThread(() -> {
                try {
                    int c = Color.parseColor(color);
                    getWindow().setStatusBarColor(c); getWindow().setNavigationBarColor(c);
                    boolean light = (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) > 150;
                    int f = getWindow().getDecorView().getSystemUiVisibility();
                    f = light ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                    if (Build.VERSION.SDK_INT >= 26) f = light ? (f | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
                    getWindow().getDecorView().setSystemUiVisibility(f);
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
        @JavascriptInterface public void saveFile(String name, String mime, String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, "Download");
                Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                try (OutputStream o = getContentResolver().openOutputStream(u)) { o.write(data); }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, name + " im Ordner „Download“ gespeichert", Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Speichern fehlgeschlagen", Toast.LENGTH_LONG).show());
            }
        }
    }
}
