package com.mathreader.boox;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

/**
 * ChatGPT 设备代码登录：复制一次性代码，并在系统浏览器打开官方授权页。
 * 页面检测到网关未登录时可直接调用，不依赖用户先点击链接。
 */
public class AuthorizationBridge {
    private static final String TAG = "AuthorizationBridge";
    // 只打开官方设备授权页，页面脚本不能借此打开其他地址。
    private static final String DEVICE_AUTHORIZATION_URL = "https://auth.openai.com/codex/device";

    private final Activity activity;

    public AuthorizationBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean openDeviceAuthorization(String url, String userCode) {
        if (!DEVICE_AUTHORIZATION_URL.equals(url)) {
            return false;
        }
        activity.runOnUiThread(() -> {
            try {
                if (userCode != null && !userCode.trim().isEmpty()) {
                    ClipboardManager clipboard =
                            (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clipboard != null) {
                        clipboard.setPrimaryClip(ClipData.newPlainText("ChatGPT device code", userCode.trim()));
                    }
                }
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                Log.w(TAG, "open device authorization failed", e);
                Toast.makeText(activity, "无法打开 ChatGPT 授权页", Toast.LENGTH_SHORT).show();
            }
        });
        return true;
    }
}
