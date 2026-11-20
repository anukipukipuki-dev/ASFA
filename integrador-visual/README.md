# Integrador Visual — gemelo visual de integración de equipos

Aplicación web local para **ver cómo quedará un equipo nuevo** (pantalla, botonera,
equipo de rack 19", caja…) **integrado en una foto real** de la cabina, el pupitre,
un armario de la sala de máquinas o un rack, **antes de instalarlo**.

No inventa nada: la geometría y el tamaño salen de las **medidas reales** (ficha técnica
del equipo + una referencia medida en la foto). La IA de imagen no "dibuja" el equipo;
la app usa la foto real del equipo y la adapta en perspectiva, escala, luz, color, grano
y sombras.

## Cómo ejecutarla

No necesita instalación ni internet. Abre `index.html` con Chrome o Edge (doble clic).

Si el navegador bloquea algo al abrirla como archivo, sírvela en local:

```bash
cd integrador-visual
python -m http.server 8000
# y abre http://localhost:8000
```

## Flujo de trabajo

1. **Foto base**: carga la foto real (JPG). También puedes arrastrarla al lienzo.
2. **Superficie y escala**: pulsa *Marcar 4 esquinas* y haz clic en las esquinas de un
   rectángulo **real y medido** que esté en la superficie de montaje: el hueco del
   pupitre, la puerta del armario o los montantes del rack. Escribe su ancho y alto en mm.
   - Preajustes: rack 19" (482,6 mm × N U), rack interior (450 mm × N U) o una hoja A4
     pegada como referencia.
   - *Zona disponible*: si el hueco libre es distinto de la referencia, márcalo aparte.
     Puedes indicar también la **profundidad disponible** tras la superficie.
3. **Equipos**: añade la foto del equipo. En el editor:
   - Introduce **ancho, alto y fondo reales** (mm).
   - Quita el fondo: automático, varita o pincel.
   - Ajusta las **4 esquinas de la cara frontal**. Si la foto tiene perspectiva, se endereza.
   - La app avisa si la proporción de la foto no cuadra con las medidas.
4. **Coloca** el equipo arrastrándolo (o con las flechas: 1 mm, Mayús: 10 mm). El tamaño
   **no se estira a mano**: lo fija la medida real.
   - Montaje: *empotrado/enrasado* (marco y junta), *sobre superficie* (laterales y sombra
     proyectada) o *rehundido* (paredes interiores del hueco).
   - Rejilla de ajuste: por ejemplo, 44,45 mm para encajar por U en un rack.
5. **Realismo**: igualación automática con el entorno (exposición, dominante de color,
   nivel de negro), luz local de la foto, grano automático, desenfoque, reflejo de cristal
   para pantallas, y dirección e intensidad de la luz para las sombras.
   - **Primer plano**: pinta lo que debe quedar *delante* del equipo nuevo (palancas,
     cables, molduras).
6. **Comprobación de encaje** (panel superior derecho): indica si cabe, los márgenes por
   cada lado, cuánto sobresale si no cabe, si falta fondo y si hay solapes entre equipos.
   Es orientativa: no sustituye a una verificación dimensional.
7. **Exportar** a resolución completa:
   - JPEG
   - JPEG comparativo antes/después
   - Informe PDF (página con la simulación + página con antes/después, tabla de equipos y
     resultado de la comprobación)

**Guardar/Abrir proyecto** guarda todo (fotos, calibración, equipos y ajustes) en un
`.ivproj.json`.

## Atajos

| Tecla | Acción |
|---|---|
| V | Mover equipos |
| H o barra espaciadora | Desplazar vista |
| Rueda del ratón | Zoom |
| F | Ajustar a la ventana |
| C | Antes / después |
| G | Mostrar/ocultar ayudas |
| Flechas | Mover el equipo seleccionado (1 mm, Mayús: 10 mm) |
| Ctrl+S | Guardar proyecto |
| Esc | Cancelar marcado |

## Consejos para un resultado realista

- Haz la foto del equipo lo más **frontal** posible y con luz difusa. El fondo blanco o
  liso se quita automáticamente.
- Usa como referencia un rectángulo **grande** y lo más cerca posible del punto de montaje:
  cuanto mayor sea, más precisa será la perspectiva.
- Si el equipo sobresale mucho y los laterales no se ven naturales, ajusta la focal en
  *Cámara (avanzado)*.

## Estructura

```
integrador-visual/
├── index.html          interfaz
├── css/app.css
├── js/geometry.js      homografías, estimación de cámara, polígonos
├── js/imaging.js       recorte de fondo, rectificación, ajuste fotométrico, warp
├── js/app.js           lógica de la aplicación, comprobaciones y exportación
└── vendor/jspdf.umd.min.js   generación de PDF (MIT), incluido para uso sin internet
```

## Próximas mejoras posibles

- Importar modelos 3D (STEP/GLB) para equipos con volumen complejo.
- Módulo opcional en Python con IA generativa (inpainting por difusión) que solo armonice
  bordes y sombras sobre la imagen ya compuesta, sin alterar la geometría.
- Recorte de fondo con IA (segmentación) para fotos con fondos complicados.
