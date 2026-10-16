package io.github.k0rbi02.rego;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;

/** Fetches the notifications from the ReGo server every ~15 minutes and shows them (Android does not allow more often). Firebase triggers the same immediately. */
public class PollWorker extends Worker {
    static final String NAME = "rego-poll";
    // Notification channels by kind of incident: anyone who wants platform changes quiet or construction not at all sets that per channel in the Android settings
    static final String CH_DELAY = "rego-verspaetung", CH_CANCEL = "rego-ausfall", CH_WORK = "rego-baustelle", CH_PLATFORM = "rego-gleis";
    private static final String OLD_CHANNEL = "rego-meldungen";          // until 0.5.1: a single channel for everything
    // Tag on the notification so that it can later be rewritten to "behoben"
    private static final String X_KIND = "rego_kind", X_LINE = "rego_line";

    public PollWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    static void schedule(Context c) {
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest r = new PeriodicWorkRequest.Builder(PollWorker.class, 15, TimeUnit.MINUTES).setConstraints(net).build();
        androidx.work.WorkManager.getInstance(c).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, r);
    }
    static void cancel(Context c) { androidx.work.WorkManager.getInstance(c).cancelUniqueWork(NAME); }
    static void clearBadge(Context c) { /* notifications stay until they are swiped away */ }

    /** Channel for the kind of incident ("kind" from the server); test notifications and unknown kinds go through "Verspätungen". */
    static String channelFor(String kind) {
        if ("cancelled".equals(kind) || "replacement".equals(kind)) return CH_CANCEL;
        if ("construction".equals(kind)) return CH_WORK;
        if ("platform".equals(kind)) return CH_PLATFORM;
        return CH_DELAY;
    }

    private static void makeChannel(NotificationManager m, String id, String name, String info, int importance) {
        NotificationChannel ch = new NotificationChannel(id, name, importance);
        ch.setDescription(info);
        m.createNotificationChannel(ch);
    }

    private static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager m = c.getSystemService(NotificationManager.class);
        if (m == null) return;
        m.deleteNotificationChannel(OLD_CHANNEL);                         // if there is nothing to delete, nothing happens
        makeChannel(m, CH_DELAY, "Verspätungen", "Dein Zug ist später dran", NotificationManager.IMPORTANCE_HIGH);
        makeChannel(m, CH_CANCEL, "Ausfälle und Ersatzverkehr", "Fahrten fallen aus oder es fährt ein Bus statt der Bahn", NotificationManager.IMPORTANCE_HIGH);
        makeChannel(m, CH_WORK, "Baustellen", "Hinweise auf Bauarbeiten, die länger dauern", NotificationManager.IMPORTANCE_DEFAULT);
        makeChannel(m, CH_PLATFORM, "Gleiswechsel", "Kurz vor der Abfahrt: dein Zug fährt von einem anderen Gleis (leise)", NotificationManager.IMPORTANCE_LOW);
    }

    @NonNull @Override public Result doWork() { return fetchAndShow(getApplicationContext()); }

    static Result fetchAndShow(Context c) {
        SharedPreferences sp = c.getSharedPreferences("rego", Context.MODE_PRIVATE);
        String device = sp.getString("device", ""), api = sp.getString("api", "");
        if (device.isEmpty() || api.isEmpty() || !sp.getBoolean("push", false)) return Result.success();
        try {
            HttpURLConnection h = (HttpURLConnection) new URL(api + "/api/notifications").openConnection();
            h.setRequestProperty("x-device", device);
            h.setConnectTimeout(10000); h.setReadTimeout(15000);
            int code = h.getResponseCode();
            if (code == 403) return Result.success();                     // server demands an invitation code (profile was deleted): the app asks for it on the next open
            if (code != 200) return Result.retry();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(h.getInputStream(), "UTF-8"))) { String l; while ((l = r.readLine()) != null) sb.append(l); }
            JSONArray list = new JSONObject(sb.toString()).optJSONArray("notifications");
            if (list == null) return Result.success();
            channels(c);
            NotificationManagerCompat nm = NotificationManagerCompat.from(c);
            if (!nm.areNotificationsEnabled()) return Result.success();
            for (int i = 0; i < list.length(); i++) {
                JSONObject n = list.getJSONObject(i);
                String tag = n.optString("tag", "rego-" + n.optLong("ts", System.currentTimeMillis()));
                if (n.optBoolean("clear", false)) { resolve(c, nm, tag); continue; }
                String kind = n.optString("kind", "");
                Intent in = new Intent(c, MainActivity.class).putExtra("path", n.optString("url", "/")).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pi = PendingIntent.getActivity(c, tag.hashCode(), in, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                boolean upd = n.optBoolean("update", false);
                NotificationCompat.Builder b = new NotificationCompat.Builder(c, channelFor(kind))
                        .setSmallIcon(R.drawable.ic_stat)
                        .setContentTitle(n.optString("title", "ReGo"))
                        .setContentText(n.optString("body", ""))
                        .setStyle(new NotificationCompat.BigTextStyle().bigText(n.optString("body", "")))
                        .setContentIntent(pi).setAutoCancel(true)
                        .setOnlyAlertOnce(upd).setSilent(upd);
                b.getExtras().putString(X_KIND, kind);
                b.getExtras().putString(X_LINE, n.optString("line", ""));
                try { nm.notify(tag, 1, b.build()); } catch (SecurityException ignored) { }
            }
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    /**
     * The incident is over. A delay, a replacement transport or a construction site that is still in the notification shade is briefly rewritten to "behoben"
     * (silently, gone after a few seconds) so that nobody suddenly stares at nothing. Cancellations and platform changes simply disappear.
     * If the user has already swiped the notification away, nothing happens.
     */
    private static void resolve(Context c, NotificationManagerCompat nm, String tag) {
        String kind = "", line = "";
        boolean found = false;
        try {
            NotificationManager sys = c.getSystemService(NotificationManager.class);
            if (sys != null) {
                for (StatusBarNotification s : sys.getActiveNotifications()) {
                    if (s.getId() == 1 && tag.equals(s.getTag())) {
                        Bundle x = s.getNotification().extras;
                        if (x != null) { kind = x.getString(X_KIND, ""); line = x.getString(X_LINE, ""); }
                        found = true;
                    }
                }
            }
        } catch (Exception ignored) { }
        if (!found) return;
        String what = "delay".equals(kind) ? "Die Verspätung" : "replacement".equals(kind) ? "Der Ersatzverkehr" : "construction".equals(kind) ? "Die Baustelle" : null;
        if (what == null) { nm.cancel(tag, 1); return; }
        Intent in = new Intent(c, MainActivity.class).putExtra("path", "/Meldungen").setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, tag.hashCode(), in, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channelFor(kind))
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(line.isEmpty() ? "Behoben" : line + " · behoben")
                .setContentText(what + " ist vorbei.")
                .setContentIntent(pi).setAutoCancel(true)
                .setOnlyAlertOnce(true).setSilent(true)
                .setTimeoutAfter(6000);
        try { nm.notify(tag, 1, b.build()); } catch (SecurityException ignored) { }
    }
}
