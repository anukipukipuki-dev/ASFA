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
2. **Superficie y escala**. Hay dos métodos:
   - **«No sé sus medidas»** (pupitres, cabinas). Es el más habitual:
     1. Marca las 4 esquinas de **cualquier cosa rectangular** que esté en la misma
        superficie donde irá el equipo: una pantalla existente, un panel, una tapa o una
        etiqueta. No hace falta saber cuánto mide.
     2. Traza una **cota conocida**: dos puntos cuya distancia real sepas. Por ejemplo, la
        diagonal de una pantalla existente en pulgadas, una hoja A4, una tarjeta o 1 U de rack.
     3. La app calcula el tamaño real del rectángulo y, con él, los milímetros de toda esa
        superficie. Cómo lo calcula según lo que le des:
        - **Formato conocido** (por ejemplo, la pantalla es 4:3): basta una cota.
        - **Dos o más cotas en direcciones distintas** (ancho y alto, o diagonal y alto):
          ancho y alto exactos, sin suponer nada de la cámara. Con 3 o más cotas comprueba
          además la coherencia entre ellas.
        - **Una sola cota sin formato**: deduce la proporción de la perspectiva (puntos de
          fuga, o la focal del EXIF de la foto). Avisa si la superficie se ve demasiado de
          frente para hacerlo con fiabilidad.
   - **«Sé sus medidas»** (armarios, racks): marca un rectángulo y escribe su ancho y alto.
     Hay preajustes para rack 19", hoja A4 y pantalla por diagonal y formato.
   - **Zona disponible**: marca el hueco donde quieres el equipo. La app te dice cuánto mide
     y si el equipo cabe. Puedes indicar también la **profundidad disponible**.
   - **📏 Medir** (tecla M): regla para medir cualquier distancia sobre la superficie
     calibrada. Sirve para comprobar la calibración con algo que conozcas.
   - Todo debe estar en **la misma superficie** (el mismo plano). En un pupitre con varias
     caras inclinadas, calibra la cara donde irá el equipo.
3. **Equipos**: añade la foto del equipo. **No tiene que estar hecha de frente**: puede tener su
   propia perspectiva, distinta de la foto base. En el editor:
   - Introduce el **ancho, alto y fondo reales** (mm).
   - Quita el fondo con la opción automática, la varita o el pincel.
   - **Orientación de la foto**: gira 90° o refleja en espejo si hace falta.
   - **Cara frontal**: ajusta sus 4 esquinas. La detección automática busca el cuadrilátero
     del recorte; si la foto muestra también un lateral, corrige las esquinas para que solo
     abarquen el frente. La app **endereza** esa cara (le quita la perspectiva de su foto) y
     la vuelve a proyectar con la perspectiva de la foto base.
   - **Laterales (opcional)**: si la foto deja ver un lado o la cara superior, márcalos con
     4 clics. Se enderezan y se usan en 3D en lugar de un color plano. El lateral marcado
     sirve para los dos lados opuestos.
   - La app avisa si la proporción de la foto no cuadra con las medidas.
4. **Coloca** el equipo arrastrándolo (o con las flechas: 1 mm, Mayús: 10 mm). El tamaño
   **no se estira a mano**: lo fija la medida real.
   - Montaje: *empotrado/enrasado* (marco y junta), *sobre superficie* (laterales y sombra
     proyectada) o *rehundido* (paredes interiores del hueco).
   - Rejilla de ajuste: por ejemplo, 44,45 mm para encajar por U en un rack.
   - **Orientación en 3D** respecto a la superficie:
     - **Giro**: dentro del plano.
     - **Inclinación**: positiva, la parte de arriba sale hacia ti (pantalla inclinada
       hacia el maquinista).
     - **Orientación**: positiva, el lado derecho sale hacia fuera.

     El equipo gira sobre la arista que queda apoyada, sin atravesar el panel, y se
     recalculan los laterales, la sombra y la perspectiva. Se aplica a los equipos que
     sobresalen de la superficie.
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
| M | Regla (medir en mm) |
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
