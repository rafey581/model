package com.snookerx.game;

import android.app.Activity;
import android.content.pm.ActivityInfo;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Turns the app's screen for the game: sideways for a match, upright for the lobby.
 *
 * The page asks through `SnookerXOrientation.set({ to })` (see hudMenu.ts). An app may set
 * its own orientation at any time, so no permission and no fullscreen request is needed,
 * which is what the browser's own orientation lock cannot do inside the app.
 */
@CapacitorPlugin(name = "SnookerXOrientation")
public class ScreenOrientationPlugin extends Plugin {

    @PluginMethod
    public void set(PluginCall call) {
        String to = call.getString("to", "free");
        final int orientation;
        switch (to) {
            case "landscape":
                // Either way round, whichever the phone is held closest to.
                orientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
                break;
            case "portrait":
                orientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
                break;
            default:
                orientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
                break;
        }
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        activity.runOnUiThread(() -> {
            activity.setRequestedOrientation(orientation);
            call.resolve();
        });
    }
}
