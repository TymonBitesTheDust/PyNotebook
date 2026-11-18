package com.pynotebook.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Hosts the notebook web app in a WebView. The web app and the Python runtime
 * (Pyodide) are served from the APK's assets at https://appassets.androidplatform.net,
 * so everything works offline. Extra Python packages are fetched from the Pyodide CDN
 * on first use and cached on the device.
 */
public class MainActivity extends Activity {
    static final String TAG = "PyNotebook";
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final String CDN = "https://cdn.jsdelivr.net/pyodide/v@PYODIDE_VERSION@/full/";
    static final Charset UTF8 = Charset.forName("UTF-8");
    static final int MAX_FILE = 100 * 1024 * 1024;

    FrameLayout root;
    WebView web;
    WebMessagePort port;
    boolean portSentForLoad = false;
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService io = Executors.newCachedThreadPool();
    final Map<String, BlockingQueue<String>> stdin = new ConcurrentHashMap<String, BlockingQueue<String>>();
    final Map<String, Object> downloadLocks = new ConcurrentHashMap<String, Object>();
    final Map<Integer, Pending> pending = new HashMap<Integer, Pending>();
    int nextRequest = 7000;
    Intent launchIntent;
    File packageDir;

    static class Pending {
        int callId;
        String kind;
        String text;
        String base64;
        String name;
        Pending(int callId, String kind) { this.callId = callId; this.kind = kind; }
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        packageDir = new File(getFilesDir(), "pyodide-packages");
        packageDir.mkdirs();
        root = new FrameLayout(this);
        root.setBackgroundColor(isNight() ? 0xFF0F1819 : 0xFFF3F6F5);
        setContentView(root);
        setupWindow();
        createWebView();
        if (isViewIntent(getIntent())) launchIntent = getIntent();
    }

    void setupWindow() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            w.setStatusBarColor(Color.TRANSPARENT);
            w.setNavigationBarColor(Color.TRANSPARENT);
            root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                    return WindowInsets.CONSUMED;
                }
            });
        } else {
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }
        applySystemBars(isNight(), isNight() ? 0xFF0F1819 : 0xFFF3F6F5);
    }

    void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(isNight() ? 0xFF0F1819 : 0xFFF3F6F5);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " PyNotebookApp/" + versionName());
        WebView.setWebContentsDebuggingEnabled(BuildFlags.DEBUG);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(ORIGIN + "/app/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!isViewIntent(intent)) return;
        final Intent it = intent;
        io.execute(new Runnable() {
            public void run() {
                try {
                    JSONObject file = readIntentFile(it);
                    JSONObject ev = new JSONObject();
                    ev.put("event", "openIntent");
                    ev.put("file", file);
                    send(ev);
                } catch (Exception e) {
                    toast("Couldn't open the file: " + e.getMessage());
                }
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        sendEvent("pause");
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        try {
            JSONObject ev = new JSONObject();
            ev.put("event", "uiMode");
            ev.put("dark", isNight());
            send(ev);
        } catch (JSONException ignored) {
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (port != null) sendEvent("back");
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        for (BlockingQueue<String> q : stdin.values()) q.offer("{\"text\":null}");
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        io.shutdownNow();
        super.onDestroy();
    }

    boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    String versionName() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName;
        } catch (Exception e) {
            return "1";
        }
    }

    @SuppressWarnings("deprecation")
    void applySystemBars(boolean dark, int color) {
        Window w = getWindow();
        root.setBackgroundColor(color);
        if (web != null) web.setBackgroundColor(color);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else {
            w.setStatusBarColor(color);
            int flags = w.getDecorView().getSystemUiVisibility();
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) {
                w.setNavigationBarColor(color);
                if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            w.getDecorView().setSystemUiVisibility(flags);
        }
    }

    // ------------------------------------------------------------------ messaging with the page

    void sendEvent(String name) {
        try {
            JSONObject ev = new JSONObject();
            ev.put("event", name);
            send(ev);
        } catch (JSONException ignored) {
        }
    }

    void send(final JSONObject obj) {
        main.post(new Runnable() {
            public void run() {
                if (port != null) {
                    try {
                        port.postMessage(new WebMessage(obj.toString()));
                    } catch (Exception e) {
                        Log.w(TAG, "postMessage failed", e);
                    }
                }
            }
        });
    }

    void reply(int id, Object result) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("result", result == null ? JSONObject.NULL : result);
            send(o);
        } catch (JSONException ignored) {
        }
    }

    void replyError(int id, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("error", message == null ? "error" : message);
            send(o);
        } catch (JSONException ignored) {
        }
    }

    void openPort() {
        if (web == null) return;
        if (port != null) {
            try {
                port.close();
            } catch (Exception ignored) {
            }
        }
        WebMessagePort[] ports = web.createWebMessageChannel();
        port = ports[0];
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort p, WebMessage message) {
                handleMessage(message.getData());
            }
        }, main);
        web.postWebMessage(new WebMessage("pynotebook:port", new WebMessagePort[]{ports[1]}), Uri.parse(ORIGIN));
    }

    void handleMessage(String data) {
        final int id;
        final String method;
        final JSONArray args;
        try {
            JSONObject m = new JSONObject(data);
            id = m.getInt("id");
            method = m.getString("method");
            args = m.optJSONArray("args") != null ? m.optJSONArray("args") : new JSONArray();
        } catch (JSONException e) {
            return;
        }
        try {
            dispatch(id, method, args);
        } catch (Exception e) {
            replyError(id, e.getMessage());
        }
    }

    static String str(JSONArray a, int i) {
        return a.isNull(i) ? null : a.optString(i, null);
    }

    void dispatch(final int id, String method, final JSONArray args) throws Exception {
        if ("info".equals(method)) {
            JSONObject o = new JSONObject();
            o.put("platform", "android");
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("version", versionName());
            o.put("dark", isNight());
            reply(id, o);
        } else if ("openDocument".equals(method)) {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startForResult(i, new Pending(id, "open"));
        } else if ("pickFiles".equals(method)) {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            startForResult(i, new Pending(id, "pick"));
        } else if ("createDocument".equals(method)) {
            String name = str(args, 0);
            String mime = str(args, 1);
            if (name == null) name = "untitled";
            String lower = name.toLowerCase(Locale.ROOT);
            if (mime == null || lower.endsWith(".ipynb") || lower.endsWith(".py")) mime = "application/octet-stream";
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mime);
            i.putExtra(Intent.EXTRA_TITLE, name);
            Pending p = new Pending(id, "create");
            p.text = str(args, 2);
            p.base64 = str(args, 3);
            p.name = name;
            startForResult(i, p);
        } else if ("readDocument".equals(method)) {
            final String uri = str(args, 0);
            io.execute(new Runnable() {
                public void run() {
                    try {
                        Uri u = Uri.parse(uri);
                        JSONObject o = new JSONObject();
                        o.put("uri", uri);
                        o.put("name", displayName(u));
                        o.put("text", readText(u));
                        o.put("writable", true);
                        o.put("persistent", true);
                        reply(id, o);
                    } catch (Exception e) {
                        replyError(id, e.getMessage());
                    }
                }
            });
        } else if ("writeDocument".equals(method)) {
            final String uri = str(args, 0);
            final String text = str(args, 1);
            io.execute(new Runnable() {
                public void run() {
                    try {
                        writeBytes(Uri.parse(uri), text == null ? new byte[0] : text.getBytes(UTF8));
                        reply(id, true);
                    } catch (Exception e) {
                        replyError(id, "readonly: " + e.getMessage());
                    }
                }
            });
        } else if ("pendingIntent".equals(method)) {
            final Intent it = launchIntent;
            launchIntent = null;
            if (it == null) {
                reply(id, null);
                return;
            }
            io.execute(new Runnable() {
                public void run() {
                    try {
                        reply(id, readIntentFile(it));
                    } catch (Exception e) {
                        replyError(id, e.getMessage());
                    }
                }
            });
        } else if ("openUrl".equals(method)) {
            openExternal(Uri.parse(str(args, 0)));
            reply(id, true);
        } else if ("listCache".equals(method)) {
            JSONArray out = new JSONArray();
            File[] files = packageDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.getName().endsWith(".part")) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", f.getName());
                    o.put("size", f.length());
                    out.put(o);
                }
            }
            reply(id, out);
        } else if ("clearCache".equals(method)) {
            File[] files = packageDir.listFiles();
            if (files != null) for (File f : files) f.delete();
            reply(id, true);
        } else if ("setTheme".equals(method)) {
            boolean dark = args.optBoolean(0, false);
            int color = dark ? 0xFF0F1819 : 0xFFF3F6F5;
            try {
                String c = str(args, 1);
                if (c != null) color = Color.parseColor(c);
            } catch (IllegalArgumentException ignored) {
            }
            applySystemBars(dark, color);
            reply(id, true);
        } else if ("stdinReply".equals(method)) {
            String key = str(args, 0);
            JSONObject o = new JSONObject();
            o.put("text", args.isNull(1) ? JSONObject.NULL : args.optString(1, ""));
            queueFor(key).offer(o.toString());
            reply(id, true);
        } else if ("toast".equals(method)) {
            toast(str(args, 0));
            reply(id, true);
        } else if ("exit".equals(method)) {
            reply(id, true);
            finish();
        } else {
            replyError(id, "Unknown method " + method);
        }
    }

    void toast(final String msg) {
        main.post(new Runnable() {
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    void openExternal(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            toast("No app can open this link.");
        }
    }

    // ------------------------------------------------------------------ files (Storage Access Framework)

    @SuppressWarnings("deprecation")
    void startForResult(Intent i, Pending p) {
        int code = nextRequest++;
        pending.put(code, p);
        try {
            startActivityForResult(i, code);
        } catch (ActivityNotFoundException e) {
            pending.remove(code);
            replyError(p.callId, "No file picker is available on this device.");
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, final Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        final Pending p = pending.remove(requestCode);
        if (p == null) return;
        if (resultCode != RESULT_OK || data == null) {
            reply(p.callId, null);
            return;
        }
        final int flags = data.getFlags();
        io.execute(new Runnable() {
            public void run() {
                try {
                    if ("open".equals(p.kind)) {
                        Uri u = data.getData();
                        boolean persisted = persist(u, flags);
                        JSONObject o = new JSONObject();
                        o.put("uri", u.toString());
                        o.put("name", displayName(u));
                        o.put("text", readText(u));
                        o.put("writable", (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0);
                        o.put("persistent", persisted);
                        reply(p.callId, o);
                    } else if ("pick".equals(p.kind)) {
                        JSONArray out = new JSONArray();
                        ClipData clip = data.getClipData();
                        if (clip != null) {
                            for (int k = 0; k < clip.getItemCount(); k++) out.put(fileAsBase64(clip.getItemAt(k).getUri()));
                        } else if (data.getData() != null) {
                            out.put(fileAsBase64(data.getData()));
                        }
                        reply(p.callId, out);
                    } else if ("create".equals(p.kind)) {
                        Uri u = data.getData();
                        byte[] bytes = p.base64 != null ? Base64.decode(p.base64, Base64.DEFAULT)
                                : (p.text == null ? new byte[0] : p.text.getBytes(UTF8));
                        writeBytes(u, bytes);
                        persist(u, flags);
                        JSONObject o = new JSONObject();
                        o.put("uri", u.toString());
                        String n = displayName(u);
                        o.put("name", n != null ? n : p.name);
                        reply(p.callId, o);
                    }
                } catch (Exception e) {
                    replyError(p.callId, e.getMessage());
                }
            }
        });
    }

    /** Keeps access to a picked file across restarts (for the recent list). */
    boolean persist(Uri u, int flags) {
        if ((flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0) return false;
        int f = flags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (f == 0) f = Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            getContentResolver().takePersistableUriPermission(u, f);
            return true;
        } catch (Exception e) {
            try {
                getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                return true;
            } catch (Exception e2) {
                return false;
            }
        }
    }

    boolean isViewIntent(Intent i) {
        return i != null && (Intent.ACTION_VIEW.equals(i.getAction()) || Intent.ACTION_EDIT.equals(i.getAction())) && i.getData() != null;
    }

    JSONObject readIntentFile(Intent it) throws Exception {
        Uri u = it.getData();
        boolean persisted = persist(u, it.getFlags());
        JSONObject o = new JSONObject();
        o.put("uri", u.toString());
        o.put("name", displayName(u));
        o.put("text", readText(u));
        o.put("writable", (it.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0 || "file".equals(u.getScheme()));
        o.put("persistent", persisted);
        return o;
    }

    String displayName(Uri u) {
        String name = null;
        Cursor c = null;
        try {
            c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        if (name == null) {
            name = u.getLastPathSegment();
            if (name != null && name.contains("/")) name = name.substring(name.lastIndexOf('/') + 1);
        }
        return name == null ? "untitled" : name;
    }

    byte[] readBytes(Uri u) throws IOException {
        InputStream in = getContentResolver().openInputStream(u);
        if (in == null) throw new IOException("Can't read the file");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_FILE) throw new IOException("The file is larger than 100 MB");
            }
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    String readText(Uri u) throws IOException {
        byte[] b = readBytes(u);
        int off = (b.length >= 3 && (b[0] & 0xFF) == 0xEF && (b[1] & 0xFF) == 0xBB && (b[2] & 0xFF) == 0xBF) ? 3 : 0;
        return new String(b, off, b.length - off, UTF8);
    }

    JSONObject fileAsBase64(Uri u) throws Exception {
        byte[] b = readBytes(u);
        JSONObject o = new JSONObject();
        o.put("name", displayName(u));
        o.put("size", b.length);
        o.put("base64", Base64.encodeToString(b, Base64.NO_WRAP));
        return o;
    }

    void writeBytes(Uri u, byte[] bytes) throws IOException {
        OutputStream out;
        try {
            out = getContentResolver().openOutputStream(u, "wt");
        } catch (Exception e) {
            out = getContentResolver().openOutputStream(u, "w");
        }
        if (out == null) throw new IOException("Can't write the file");
        try {
            out.write(bytes);
            out.flush();
        } finally {
            out.close();
        }
    }

    // ------------------------------------------------------------------ local web server (request interception)

    BlockingQueue<String> queueFor(String key) {
        if (key == null) key = "";
        BlockingQueue<String> q = stdin.get(key);
        if (q == null) {
            BlockingQueue<String> fresh = new ArrayBlockingQueue<String>(1);
            BlockingQueue<String> prev = ((ConcurrentHashMap<String, BlockingQueue<String>>) stdin).putIfAbsent(key, fresh);
            q = prev != null ? prev : fresh;
        }
        return q;
    }

    static Map<String, String> headers() {
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cross-Origin-Opener-Policy", "same-origin");
        h.put("Cross-Origin-Embedder-Policy", "credentialless");
        h.put("Cross-Origin-Resource-Policy", "cross-origin");
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-cache");
        return h;
    }

    static String mimeFor(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json") || n.endsWith(".ipynb") || n.endsWith(".map")) return "application/json";
        if (n.endsWith(".wasm")) return "application/wasm";
        if (n.endsWith(".zip") || n.endsWith(".whl")) return "application/zip";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".woff")) return "font/woff";
        if (n.endsWith(".ttf")) return "font/ttf";
        if (n.endsWith(".txt") || n.endsWith(".py")) return "text/plain";
        return "application/octet-stream";
    }

    static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
    }

    static WebResourceResponse response(int status, String reason, String mime, InputStream data) {
        return new WebResourceResponse(mime, isText(mime) ? "utf-8" : null, status, reason, headers(), data);
    }

    static WebResourceResponse error(int status, String reason, String message) {
        return response(status, reason, "text/plain", new ByteArrayInputStream(message.getBytes(UTF8)));
    }

    static boolean safePath(String p) {
        if (p == null || p.isEmpty()) return false;
        for (String seg : p.split("/")) {
            if (seg.equals("..") || seg.equals(".")) return false;
        }
        return !p.startsWith("/") && !p.contains("\\");
    }

    WebResourceResponse asset(String path) {
        if (!safePath(path)) return error(404, "Not Found", "not found");
        try {
            InputStream in = getAssets().open(path);
            return response(200, "OK", mimeFor(path), in);
        } catch (FileNotFoundException e) {
            return null;
        } catch (IOException e) {
            return error(500, "Server Error", String.valueOf(e.getMessage()));
        }
    }

    WebResourceResponse pyodideFile(String name) {
        if (!safePath(name) || name.contains("/")) return error(404, "Not Found", "not found");
        WebResourceResponse r = asset("pyodide/" + name);
        if (r != null) return r;
        File f = new File(packageDir, name);
        try {
            if (!f.exists()) download(name, f);
            return response(200, "OK", mimeFor(name), new FileInputStream(f));
        } catch (Exception e) {
            Log.w(TAG, "package download failed: " + name, e);
            return error(503, "Service Unavailable", "Couldn't download " + name + " (" + e.getMessage() + ")");
        }
    }

    void download(String name, File dest) throws IOException {
        Object lock = downloadLocks.get(name);
        if (lock == null) {
            Object fresh = new Object();
            Object prev = ((ConcurrentHashMap<String, Object>) downloadLocks).putIfAbsent(name, fresh);
            lock = prev != null ? prev : fresh;
        }
        synchronized (lock) {
            if (dest.exists()) return;
            File part = new File(dest.getPath() + ".part");
            HttpURLConnection c = (HttpURLConnection) new URL(CDN + name).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(true);
            try {
                int code = c.getResponseCode();
                if (code != 200) throw new IOException("HTTP " + code);
                InputStream in = c.getInputStream();
                OutputStream out = new FileOutputStream(part);
                try {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                } finally {
                    out.close();
                    in.close();
                }
                if (part.length() == 0) throw new IOException("empty download");
                if (!part.renameTo(dest)) throw new IOException("couldn't store the download");
            } finally {
                c.disconnect();
                if (part.exists()) part.delete();
            }
        }
    }

    WebResourceResponse stdinRequest(Uri u) {
        String key = u.getQueryParameter("id");
        if (key == null) return error(400, "Bad Request", "missing id");
        BlockingQueue<String> q = queueFor(key);
        String answer;
        try {
            answer = q.poll(6, TimeUnit.HOURS);
        } catch (InterruptedException e) {
            answer = null;
        }
        stdin.remove(key);
        if (answer == null) answer = "{\"text\":null}";
        return response(200, "OK", "application/json", new ByteArrayInputStream(answer.getBytes(UTF8)));
    }

    class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath() == null ? "/" : u.getPath();
            if (path.equals("/") || path.equals("/app") || path.equals("/app/")) path = "/app/index.html";
            if (path.startsWith("/app/")) {
                WebResourceResponse r = asset("web/" + path.substring(5));
                return r != null ? r : error(404, "Not Found", "not found: " + path);
            }
            if (path.startsWith("/pyodide/")) return pyodideFile(path.substring(9));
            if (path.equals("/__stdin")) return stdinRequest(u);
            return error(404, "Not Found", "not found: " + path);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openExternal(u);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            portSentForLoad = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (url != null && url.startsWith(ORIGIN) && !portSentForLoad) {
                portSentForLoad = true;
                openPort();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.w(TAG, "WebView renderer gone; recreating");
            if (web == view) {
                root.removeView(web);
                web.destroy();
                web = null;
                port = null;
                createWebView();
                toast("The notebook page ran out of memory and was reloaded. Your last edits are kept as a draft.");
            }
            return true;
        }
    }
}
