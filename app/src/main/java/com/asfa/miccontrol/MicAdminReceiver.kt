package com.asfa.miccontrol

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context

/**
 * Device Admin receiver.
 *
 * The app becomes Device Owner via a single one-time adb command (no root):
 *
 *     adb shell dpm set-device-owner com.asfa.miccontrol/.MicAdminReceiver
 *
 * Once it is Device Owner, [MicController] can apply the system-wide
 * DISALLOW_UNMUTE_MICROPHONE restriction, which mutes the microphone for the
 * whole device and prevents anything from un-muting it until the restriction
 * is cleared from the app.
 */
class MicAdminReceiver : DeviceAdminReceiver() {

    companion object {
        /** The ComponentName other classes use when talking to DevicePolicyManager. */
        fun componentName(context: Context): ComponentName =
            ComponentName(context.applicationContext, MicAdminReceiver::class.java)
    }
}
