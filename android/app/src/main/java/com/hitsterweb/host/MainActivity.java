package com.hitsterweb.host;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import java.util.List;

/**
 * HitsterWeb Host: shows the HitsterWeb host screen and lets it play / pause / skip / seek Spotify.
 */
public class MainActivity extends Activity {

    private static final String SPOTIFY = "com.spotify.music";
    private static final int FILE_REQUEST = 7;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("hitsterweb", MODE_PRIVATE);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.addJavascriptInterface(new Bridge(), "HitsterAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                Uri server = Uri.parse(serverUrl());
                boolean sameServer = url.getHost() != null && url.getHost().equals(server.getHost())
                        && url.getPort() == server.getPort();
                if (sameServer) return false;
                // Exportify and other sites open in the normal browser (so the CSV download works).
                try { startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) askForServer("Couldn't open HitsterWeb. Check the address and your internet connection.");
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // Lets the "Upload playlist file" button open the file picker.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("*/*");
                    startActivityForResult(pick, FILE_REQUEST);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (serverUrl().isEmpty()) askForServer(null);
        else web.loadUrl(serverUrl());
    }

    private String serverUrl() {
        return prefs.getString("url", "");
    }

    private void askForServer(String problem) {
        runOnUiThread(() -> {
            final EditText input = new EditText(this);
            input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
            input.setText(serverUrl().isEmpty() ? "https://" : serverUrl());
            new AlertDialog.Builder(this)
                    .setTitle("HitsterWeb address")
                    .setMessage((problem != null ? problem + "\n\n" : "")
                            + "Type your HitsterWeb link, for example https://yourname.github.io/HitsterWeb/")
                    .setView(input)
                    .setCancelable(false)
                    .setPositiveButton("Connect", (d, w) -> {
                        String url = input.getText().toString().trim();
                        if (!url.startsWith("http")) url = "https://" + url;
                        if (!url.endsWith("/") && !url.endsWith(".html")) url = url + "/";
                        prefs.edit().putString("url", url).apply();
                        web.loadUrl(url);
                    })
                    .show();
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ---------------- Spotify control ----------------

    private boolean hasAccess() {
        String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return enabled != null && enabled.contains(getPackageName());
    }

    /** Finds Spotify's player (needs Notification access). Returns null if not available. */
    private MediaController spotify() {
        if (!hasAccess()) return null;
        try {
            MediaSessionManager msm = (MediaSessionManager) getSystemService(Context.MEDIA_SESSION_SERVICE);
            List<MediaController> list = msm.getActiveSessions(new ComponentName(this, MediaAccessService.class));
            for (MediaController c : list) if (SPOTIFY.equals(c.getPackageName())) return c;
            return list.isEmpty() ? null : list.get(0);
        } catch (SecurityException e) {
            return null;
        }
    }

    /** Fallback without Notification access: send the same signal as headphone buttons. */
    private void mediaKey(int code) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        long now = SystemClock.uptimeMillis();
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0));
    }

    /** Everything the web page can call, as window.HitsterAndroid.xxx() */
    private class Bridge {
        @JavascriptInterface
        public String command(String cmd) {
            MediaController c = spotify();
            if (c != null) {
                MediaController.TransportControls t = c.getTransportControls();
                if (cmd.equals("play")) t.play();
                else if (cmd.equals("pause")) t.pause();
                else if (cmd.equals("next")) t.skipToNext();
                else if (cmd.startsWith("seek:")) t.seekTo(Long.parseLong(cmd.substring(5)));
                return "ok";
            }
            if (cmd.equals("play")) mediaKey(KeyEvent.KEYCODE_MEDIA_PLAY);
            else if (cmd.equals("pause")) mediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE);
            else if (cmd.equals("next")) mediaKey(KeyEvent.KEYCODE_MEDIA_NEXT);
            else return "noseek"; // jumping to the chorus needs Notification access
            return "ok-key";
        }

        @JavascriptInterface
        public boolean hasMediaAccess() {
            return hasAccess();
        }

        @JavascriptInterface
        public void openAccessSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        }

        @JavascriptInterface
        public void changeServer() {
            askForServer(null);
        }
    }
}
