package com.asfa.miccontrol

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton

class MainActivity : AppCompatActivity() {

    private val adbCommand = "adb shell dpm set-device-owner com.asfa.miccontrol/.MicAdminReceiver"

    private lateinit var controller: MicController
    private lateinit var statusText: TextView
    private lateinit var toggleButton: MaterialButton
    private lateinit var ownerHint: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        controller = MicController(this)
        statusText = findViewById(R.id.statusText)
        toggleButton = findViewById(R.id.toggleButton)
        ownerHint = findViewById(R.id.ownerHint)

        toggleButton.setOnClickListener { onToggleClicked() }
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
    }

    private fun onToggleClicked() {
        if (!controller.isDeviceOwner()) {
            showSetupDialog()
            return
        }
        try {
            if (controller.isMicDisabled()) {
                controller.enableMic()
            } else {
                controller.disableMic()
            }
        } catch (e: SecurityException) {
            showSetupDialog()
        }
        refreshUi()
    }

    private fun refreshUi() {
        val isOwner = controller.isDeviceOwner()
        if (!isOwner) {
            statusText.setText(R.string.status_unknown)
            toggleButton.setText(R.string.btn_turn_off)
            ownerHint.text = getString(R.string.not_owner_title)
            return
        }

        ownerHint.text = ""
        if (controller.isMicDisabled()) {
            statusText.setText(R.string.status_disabled)
            toggleButton.setText(R.string.btn_turn_on)
        } else {
            statusText.setText(R.string.status_enabled)
            toggleButton.setText(R.string.btn_turn_off)
        }
    }

    private fun showSetupDialog() {
        AlertDialog.Builder(this)
            .setTitle(R.string.not_owner_title)
            .setMessage(R.string.not_owner_body)
            .setPositiveButton(R.string.copy_command) { _, _ -> copyCommand() }
            .setNeutralButton(R.string.open_settings) { _, _ -> openAppSettings() }
            .setNegativeButton(R.string.dismiss, null)
            .show()
    }

    private fun copyCommand() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("adb command", adbCommand))
        Toast.makeText(this, R.string.command_copied, Toast.LENGTH_SHORT).show()
    }

    private fun openAppSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", packageName, null)
        }
        startActivity(intent)
    }
}
