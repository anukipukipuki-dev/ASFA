# Mic Control — interruptor real del micrófono para Android

App Android mínima con un botón para **apagar y encender el micrófono de todo el
dispositivo**, de forma que quede deshabilitado y no se pueda usar hasta que
vuelvas a pulsar el botón.

## Qué es posible y qué no (importante)

- **Sin root**, una app normal **no puede** apagar el micrófono a nivel de
  hardware para todo el sistema. Android lo impide a propósito. Cualquier app que
  diga lo contrario solo silencia su propio audio, no el del sistema.
- La forma más potente que existe **sin rootear** es convertir esta app en
  **Device Owner** mediante **un único comando `adb`** desde un PC. Como Device
  Owner, la app aplica la restricción del sistema `DISALLOW_UNMUTE_MICROPHONE`,
  que **silencia el micro globalmente y bloquea su reactivación** hasta que tú la
  quites desde el botón. Eso es un interruptor real.

## Cómo obtener el APK (sin instalar Android Studio)

El repositorio incluye un workflow de GitHub Actions. Cada push a la rama
`claude/low-level-microphone-control-oec1ok` compila el APK en la nube:

1. En GitHub, pestaña **Actions** → workflow **Build APK** → última ejecución.
2. Descarga el artefacto **`mic-control-debug-apk`**.
3. Descomprímelo y pasa el `.apk` al teléfono; instálalo (permite "orígenes
   desconocidos" si lo pide).

También puedes lanzarlo a mano con **Run workflow** (`workflow_dispatch`).

> Alternativa: abre el proyecto en **Android Studio** (gratis) y pulsa *Run*.

## Activar el interruptor real (una sola vez, por USB, sin root)

1. En el teléfono: **Ajustes → Acerca del teléfono** → toca 7 veces en "Número de
   compilación" para activar **Opciones de desarrollador**.
2. En **Opciones de desarrollador**, activa **Depuración por USB**.
3. Conecta el teléfono al PC (con `adb` instalado — viene en las *Android platform-tools*).
4. Ejecuta:

   ```
   adb shell dpm set-device-owner com.asfa.miccontrol/.MicAdminReceiver
   ```

   > Requisito de Android: no debe haber **otras cuentas de usuario** configuradas
   > en el teléfono (ni perfiles de trabajo). Si falla, quítalas y reintenta.

5. Abre la app y usa el botón: **Apagar micrófono** aplica la restricción global;
   **Encender micrófono** la retira.

Si la app todavía no es Device Owner, el botón muestra estas instrucciones y te
deja copiar el comando o abrir los ajustes de la app.

## Quitar el modo Device Owner (si quieres revertir)

```
adb shell dpm remove-active-admin com.asfa.miccontrol/.MicAdminReceiver
```

## Estructura del proyecto

```
app/src/main/
  AndroidManifest.xml
  java/com/asfa/miccontrol/
    MainActivity.kt       # UI: botón + estado
    MicController.kt       # lógica de apagar/encender (restricción del sistema)
    MicAdminReceiver.kt    # receptor de Device Admin / Device Owner
  res/                     # layout, textos, icono, tema
.github/workflows/build-apk.yml   # compila el APK en la nube
```

## Notas técnicas

- `minSdk = 24` (Android 7.0), `targetSdk = 34`.
- El switch global usa `DevicePolicyManager.addUserRestriction(..., DISALLOW_UNMUTE_MICROPHONE)`.
- `AudioManager.isMicrophoneMute` se usa para aplicar el mute de inmediato.
