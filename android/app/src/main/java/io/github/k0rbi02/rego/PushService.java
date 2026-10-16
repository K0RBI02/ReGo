package io.github.k0rbi02.rego;

import android.content.Context;
import android.content.SharedPreferences;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.net.HttpURLConnection;
import java.net.URL;

/** Firebase nudge from the ReGo server: the text comes from there afterwards, not through Google. */
public class PushService extends FirebaseMessagingService {
    @Override public void onMessageReceived(RemoteMessage m) {
        PollWorker.fetchAndShow(getApplicationContext());
    }

    @Override public void onNewToken(String token) {
        SharedPreferences sp = getSharedPreferences("rego", Context.MODE_PRIVATE);
        sp.edit().putString("fcm", token).apply();
        String device = sp.getString("device", ""), api = sp.getString("api", "");
        if (device.isEmpty() || api.isEmpty() || !sp.getBoolean("push", false)) return;
        new Thread(() -> {
            try {
                HttpURLConnection h = (HttpURLConnection) new URL(api + "/api/push/native").openConnection();
                h.setRequestMethod("PUT"); h.setDoOutput(true);
                h.setRequestProperty("x-device", device); h.setRequestProperty("content-type", "application/json");
                h.setConnectTimeout(10000); h.setReadTimeout(10000);
                h.getOutputStream().write(("{\"token\":\"" + token + "\"}").getBytes("UTF-8"));
                h.getResponseCode();
            } catch (Exception ignored) { }
        }).start();
    }
}
