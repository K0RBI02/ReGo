package io.github.k0rbi02.rego;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
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

/** Holt alle ~15 Minuten die Meldungen vom ReGo-Server und zeigt sie an (Android erlaubt nicht öfter). */
public class PollWorker extends Worker {
    static final String CH = "rego-meldungen", NAME = "rego-poll";

    public PollWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    static void schedule(Context c) {
        Constraints net = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest r = new PeriodicWorkRequest.Builder(PollWorker.class, 15, TimeUnit.MINUTES).setConstraints(net).build();
        androidx.work.WorkManager.getInstance(c).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, r);
    }
    static void cancel(Context c) { androidx.work.WorkManager.getInstance(c).cancelUniqueWork(NAME); }
    static void clearBadge(Context c) { /* Meldungen bleiben stehen, bis sie weggewischt werden */ }

    private static void channel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH, "Störungen auf deinen Strecken", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Verspätungen und Ausfälle auf deinen gespeicherten Strecken");
            c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    @NonNull @Override public Result doWork() {
        Context c = getApplicationContext();
        SharedPreferences sp = c.getSharedPreferences("rego", Context.MODE_PRIVATE);
        String device = sp.getString("device", ""), api = sp.getString("api", "");
        if (device.isEmpty() || api.isEmpty() || !sp.getBoolean("push", false)) return Result.success();
        try {
            HttpURLConnection h = (HttpURLConnection) new URL(api + "/api/notifications").openConnection();
            h.setRequestProperty("x-device", device);
            h.setConnectTimeout(10000); h.setReadTimeout(15000);
            if (h.getResponseCode() != 200) return Result.retry();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(h.getInputStream(), "UTF-8"))) { String l; while ((l = r.readLine()) != null) sb.append(l); }
            JSONArray list = new JSONObject(sb.toString()).optJSONArray("notifications");
            if (list == null) return Result.success();
            channel(c);
            NotificationManagerCompat nm = NotificationManagerCompat.from(c);
            if (!nm.areNotificationsEnabled()) return Result.success();
            for (int i = 0; i < list.length(); i++) {
                JSONObject n = list.getJSONObject(i);
                String tag = n.optString("tag", "rego-" + n.optLong("ts", System.currentTimeMillis()));
                if (n.optBoolean("clear", false)) { nm.cancel(tag, 1); continue; }
                Intent in = new Intent(c, MainActivity.class).putExtra("path", n.optString("url", "/")).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pi = PendingIntent.getActivity(c, tag.hashCode(), in, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                boolean upd = n.optBoolean("update", false);
                NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH)
                        .setSmallIcon(R.drawable.ic_stat)
                        .setContentTitle(n.optString("title", "ReGo"))
                        .setContentText(n.optString("body", ""))
                        .setStyle(new NotificationCompat.BigTextStyle().bigText(n.optString("body", "")))
                        .setContentIntent(pi).setAutoCancel(true)
                        .setOnlyAlertOnce(upd).setSilent(upd)
                        .setPriority(NotificationCompat.PRIORITY_HIGH);
                try { nm.notify(tag, 1, b.build()); } catch (SecurityException ignored) { }
            }
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }
}
