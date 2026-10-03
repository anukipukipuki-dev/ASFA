package com.asfa.miccontrol

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.media.AudioManager
import android.os.UserManager

/**
 * Wraps the actual microphone enable/disable logic.
 *
 * The real, system-wide switch is the [UserManager.DISALLOW_UNMUTE_MICROPHONE]
 * restriction. It can only be set by a Device Owner (or Profile Owner). Setting
 * it mutes the microphone globally and blocks un-muting; clearing it restores
 * normal operation. We also toggle [AudioManager.isMicrophoneMute] so the change
 * takes effect immediately.
 */
class MicController(context: Context) {

    private val appContext = context.applicationContext
    private val dpm =
        appContext.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private val audio =
        appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val admin = MicAdminReceiver.componentName(appContext)

    /** True when this app holds Device Owner, i.e. the global switch is available. */
    fun isDeviceOwner(): Boolean = dpm.isDeviceOwnerApp(appContext.packageName)

    /** True when the microphone is currently disabled system-wide. */
    fun isMicDisabled(): Boolean {
        if (!isDeviceOwner()) return false
        val restrictions = dpm.getUserRestrictions(admin)
        return restrictions.getBoolean(UserManager.DISALLOW_UNMUTE_MICROPHONE, false)
    }

    /**
     * Disable the microphone for the whole device.
     * @throws SecurityException if the app is not Device Owner.
     */
    fun disableMic() {
        dpm.addUserRestriction(admin, UserManager.DISALLOW_UNMUTE_MICROPHONE)
        @Suppress("DEPRECATION")
        audio.isMicrophoneMute = true
    }

    /**
     * Re-enable the microphone.
     * @throws SecurityException if the app is not Device Owner.
     */
    fun enableMic() {
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_UNMUTE_MICROPHONE)
        @Suppress("DEPRECATION")
        audio.isMicrophoneMute = false
    }
}
