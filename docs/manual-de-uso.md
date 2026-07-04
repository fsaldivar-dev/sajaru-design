# Manual de uso — Sajaru Design

Bienvenido/a a **Sajaru Design**, tu suite de escritorio para preparar diseños de **sublimado** y **DTF**. Este manual está pensado para que cualquier diseñador del equipo, sin importar su nivel técnico, pueda usar todas las herramientas de punta a punta.

> Consejo: leé la sección **[Qué es Sajaru Design](#1-qué-es-sajaru-design)** y **[Local vs IA Premium](#3-local-vs-ia-premium-y-el-saldo)** aunque sea rápido. Con esos dos conceptos entendés el 80% de la app.

---

## Índice

1. [Qué es Sajaru Design](#1-qué-es-sajaru-design)
2. [La ventana principal](#2-la-ventana-principal)
3. [Local vs IA Premium (y el saldo)](#3-local-vs-ia-premium-y-el-saldo)
4. [Herramientas](#4-herramientas)
   - [Crear diseño](#41-crear-diseño)
   - [Preparar sublimación](#42-preparar-sublimación)
   - [Editar imagen](#43-editar-imagen)
   - [Quitar fondo ⭐](#44-quitar-fondo-)
   - [Aumentar resolución](#45-aumentar-resolución)
   - [Vectorizar](#46-vectorizar)
   - [Mockup 3D ⭐](#47-mockup-3d-)
   - [Sublimado Gorras y Tazas/Vasos](#48-sublimado-gorras-y-tazas-y-vasos)
5. ["Enviar a" y flujos entre herramientas](#5-enviar-a-y-flujos-entre-herramientas)
6. [Atajos y consejos](#6-atajos-y-consejos)
7. [Preguntas frecuentes](#7-preguntas-frecuentes)

---

## 1. Qué es Sajaru Design

Sajaru Design es una aplicación de escritorio (corre en tu compu, no en el navegador) que reúne en un solo lugar todo lo que necesitás para llevar un diseño desde la idea hasta el archivo listo para imprimir o sublimar. Recortás fondos, subís resolución, vectorizás logos, generás mockups 3D para mostrarle al cliente y dejás el archivo con el tamaño y DPI correctos para el transfer.

**El modelo mental es simple: cada herramienta es una tarjeta (tile) en una grilla.** Entrás a la app, ves las tarjetas agrupadas por categoría, hacés clic en la que necesitás, trabajás adentro y volvés. No hay menús escondidos ni flujos raros: elegís la tarea, la resolvés, y si querés, pasás el resultado a otra herramienta con **"Enviar a"** (sin exportar ni volver a importar nada).

---

## 2. La ventana principal

Al abrir Sajaru Design vas a ver:

### La barra superior

- **Nombre de la app** (arriba a la izquierda).
- **Buscador** ("Buscar app, proyecto…"): escribí el nombre de una herramienta o categoría y la grilla se filtra al toque. Si no hay coincidencias, aparece "Sin resultados".
- **Indicador de saldo** de IA Premium (una pastilla con un ícono de destello ✦ y un número seguido de "u" de *unidades/créditos*). Ver [sección 3](#3-local-vs-ia-premium-y-el-saldo). *Solo aparece si cargaste una clave de API.*
- **Cambiar tema** (sol/luna): alterná entre tema claro y oscuro según tu gusto.

### Las tabs

Debajo de la barra superior hay dos pestañas:

- **App**: la grilla de herramientas (es lo que ves por defecto).
- **Proyectos**: tus trabajos guardados. Al principio está vacío ("Aún no hay proyectos"); se va llenando a medida que guardás trabajo desde las herramientas.

### La grilla por categorías

Las herramientas están agrupadas en secciones:

- **Diseño y recursos** — Crear diseño, Preparar sublimación, Editar imagen.
- **Sublimado Playeras** — Quitar fondo, Aumentar resolución, Vectorizar, Mockup 3D.
- **Sublimado Gorras** — Mockup 3D (y varias "Próximamente").
- **Sublimado Tazas y vasos** — Aumentar resolución, Mockup 3D (y varias "Próximamente").

Cada tarjeta tiene un ícono, el nombre de la herramienta y, cuando todavía no está disponible, una etiqueta **"Próximamente"** (esas tarjetas están atenuadas y no se pueden abrir).

> Tip: hacé clic en cualquier tarjeta activa para entrar. Para volver a la grilla, usá el botón de volver dentro de la herramienta.

---

## 3. Local vs IA Premium (y el saldo)

Casi todas las herramientas te dejan elegir con qué "motor" trabajar. Entender la diferencia te ahorra plata y tiempo.

### Local (gratis)

- **Es gratis y no consume créditos.**
- **Es privado**: tus imágenes NO se suben a ningún servidor, se procesan en tu propia compu.
- **Funciona sin internet.**
- La **primera vez** que usás un modelo de IA local (por ejemplo el de recorte fino o el de aumentar resolución), la app lo **descarga automáticamente**. Esa descarga inicial sí necesita internet y puede tardar un rato; después queda guardado y ya funciona offline.

### IA Premium (Recraft, paga)

- Usa el servicio en la nube **Recraft**, que da **mejor calidad en casos difíciles** (fondos complejos, pelo, logos con degradados, etc.).
- **Consume créditos** (se cobra por uso).
- Necesita internet.

### El saldo

La **pastilla de saldo** en la barra superior te muestra en todo momento cuántos créditos ("u" = unidades) te quedan. Al hacer clic se despliega el detalle:

- **Saldo** total en unidades, con su equivalente aproximado en **USD** y en **MXN (pesos mexicanos)**.
- **Esta sesión**: cuántas **imágenes tratadas** llevás y cuánto **gastaste** (en MXN y su equivalente en USD/unidades).
- Botón para **actualizar saldo** (ícono de refrescar).
- Si el saldo está **bajo** (por debajo de 200 u), la pastilla se pone en color ámbar y te avisa: "Saldo bajo — recargá en recraft.ai."

### La clave de API

Para usar IA Premium hay que **pegar la clave de API una sola vez**. Una vez configurada, el indicador de saldo aparece y las opciones Premium quedan habilitadas. Si no cargaste ninguna clave, la app funciona igual con todas las opciones **locales/gratis** (el indicador de saldo simplemente no se muestra).

> **Regla práctica**: probá siempre primero con **local**. Si el resultado no te convence en un caso difícil, recién ahí tirá de **Premium**.

---

## 4. Herramientas

### 4.1 Crear diseño

**Qué hace:** genera imágenes o vectores desde un texto (un *prompt*) usando IA Premium (Recraft). Ideal para partir de cero o conseguir un recurso rápido.

**Cómo se usa:**

1. Escribí el **prompt** (describí lo que querés: "logo minimalista de un zorro, líneas simples", etc.).
2. Elegí el **modelo/tipo de salida**:
   - **Imagen** (raster).
   - **Vector SVG** (ideal para logos y cosas que después vas a escalar).
3. Elegí el **estilo**: ilustración vectorial, digital o realista.
4. Elegí el **tamaño**.
5. Generá y esperá el resultado.

**Consume créditos** (es una función Premium).

**Tips:**
- Si vas a imprimir en grande o necesitás editar por capas, generá directo en **Vector SVG**.
- Sé específico en el prompt (colores, cantidad de elementos, fondo) para gastar menos intentos.

---

### 4.2 Preparar sublimación

**Qué hace:** deja el archivo **listo para el transfer**. Es el último paso antes de mandar a imprimir.

**Cómo se usa:**

1. Cargá la imagen (o llegá acá con **"Enviar a → Preparar sublimación"** desde otra herramienta).
2. Definí el **tamaño físico en pulgadas** (el tamaño real que va a tener el estampado).
3. La app trabaja a **300 DPI** (la resolución estándar para sublimación de calidad).
4. Activá el **espejo horizontal** cuando corresponda: la sublimación se imprime espejada porque el transfer se da vuelta al aplicarlo.
5. Exportá en **PNG** o **TIFF**.

**Formatos de salida:** PNG, TIFF.

**Tips:**
- El espejo horizontal es clave en sublimación: si el diseño tiene texto y sale al revés en la prenda, casi seguro te olvidaste de activarlo (o lo activaste de más).
- TIFF conserva más calidad para el taller de impresión; PNG es más liviano y versátil.

---

### 4.3 Editar imagen

**Qué hace:** un editor para **ajustes y retoques rápidos** de una imagen, sin salir de Sajaru.

**Cómo se usa:**

1. Cargá la imagen.
2. Aplicá los ajustes/retoques que necesites.
3. Guardá o pasá el resultado a otra herramienta con **"Enviar a"**.

**Tips:** usalo para arreglos puntuales antes de recortar o de armar el mockup. Para cambios grandes, combinalo con las otras herramientas vía "Enviar a".

---

### 4.4 Quitar fondo ⭐

*La herramienta estrella.* Recorta el fondo y deja el sujeto en **transparente**, listo para sublimar o para DTF.

#### Novedad: es MULTI-IMAGEN

Podés **arrastrar varias imágenes a la vez** y cada una se trata de forma **independiente** (su propio recorte y sus propios retoques):

- Cuando hay **2 o más**, abajo aparece un **"filmstrip"** (tira de miniaturas). Hacé **clic en una miniatura** para editar esa imagen.
- **"Procesar todas"**: aplica el recorte automático a todas de una.
- **"Guardar todas"**: elegís **una carpeta** y la app exporta todos los recortes juntos.

#### Flujo básico (una imagen)

1. **Arrastrá** la imagen (o varias) a la zona de carga.
2. Ajustá la configuración (ver abajo) y dejá que haga el **recorte automático**.
3. Si hace falta, **retocá la máscara** con las herramientas del editor.
4. **Guardá** (o usá **"Enviar a"**).

#### Configuración del recorte

- **Tipo de imagen**: **Auto**, **Logo**, **Persona** o **Ilustración**. Elegir el tipo correcto mejora mucho el resultado (por ejemplo, "Persona" cuida los bordes del pelo; "Logo" busca bordes limpios).
- **Calidad**:
  - **Estándar** (local): **gratis, privado, sin subir nada.**
  - **Premium** (IA Recraft): mejor en **casos difíciles**, es **paga**.
- **Detalle para fotos** (cuando corresponde):
  - **Máxima** = **BiRefNet** (más preciso, más lento).
  - **Rápida** = **U²-Net** (más veloz).

#### El editor de máscara (herramientas)

A la izquierda tenés la paleta de herramientas. A la derecha, el lienzo con tu imagen.

- **Mover / Zoom**: navegá por la imagen (mover y hacer zoom) sin pintar nada.
- **Borrar** (pincel): borrá zonas del recorte a mano.
- **Restaurar** (pincel): **trae de vuelta píxeles de la FOTO ORIGINAL**, incluso los que el recorte automático había quitado. Perfecto cuando la IA se comió una parte del sujeto.
- **Varita** (borrar color): borrá un color de **un solo clic**. Puede trabajar **conectado** (solo la mancha que tocaste) o **global** (ese color en toda la imagen).
- **Selección** (Select & Mask): refiná el recorte con un **pincel Sumar (+) / Quitar (−)**; el borde sigue la máscara y se actualiza al soltar.
- **Selección inteligente (SAM)**: segmentación asistida por IA. Modos **Rápido** y **Preciso**, más **"Analizar todo"**, que segmenta toda la imagen y **resalta las zonas** para que elijas.
- **Niveles** (pulir el borde del alfa): ajustá el borde como los "Niveles" de Photoshop — **Limpiar** (saca el halo), **Reforzar** (endurece el borde) y **Medios**. Con vista previa en vivo.
- **Recuperar pelo**: técnica de **canales/contraste** para **recuperar hebras finas** de cabello que el recorte normal se pierde.
- **Contorno sticker**: agrega un **borde de color tipo die-cut**, pensado para **DTF** (el clásico contorno de calcomanía).

#### El lienzo y la comparación

- **Fondo del lienzo**: elegí cómo ver el recorte — **Cuadriculado** (el clásico de transparencia), **Blanco**, **Negro** o **Máscara** (para ver el alfa en blanco y negro).
- **Comparar**: **mantené presionado** el botón para ver el **original** por debajo y chequear qué tan bien quedó el recorte.

#### Guardar y enviar

- **Vectorizar**: convertí el recorte a vector.
- **Copiar**: copiá el resultado al portapapeles.
- **"Enviar a"**: pasá el recorte a **Preparar sublimación**, **Mockup 3D** o **Vectorizar** sin exportar.
- **Guardar** (o **"Guardar todas"** en multi-imagen).

#### Sugerencias automáticas

La herramienta te tira **sugerencias** según lo que detecta (por ejemplo, te propone **vectorizar** si reconoce que es un logo).

**Tips:**
- Empezá con **Tipo de imagen = Auto** y **Calidad = Estándar**. Si el borde queda sucio o falta pelo, ahí subís a **Premium** o usás **Recuperar pelo** / **Niveles**.
- Para DTF, acordate del **Contorno sticker**: el DTF necesita **alfa binario** (bordes definidos, sin semitransparencias), y esta herramienta te lo deja listo.
- Usá **Restaurar** cuando el recorte automático se comió una parte del sujeto: pintás encima y vuelve la foto original.

---

### 4.5 Aumentar resolución

**Qué hace:** sube la resolución de una imagen para que se vea nítida al imprimir en tamaños grandes.

**Cómo se usa:**

1. Cargá la imagen.
2. Elegí el **motor**:
   - **Clásico** (nítido, **gratis**).
   - **IA local** (**Real-ESRGAN**, gratis, más calidad).
   - **Premium** (Recraft, paga).
3. Elegí el **factor**: de **1x a 4x**.
4. Procesá y guardá.

**Tips:**
- Para fotos y diseños con detalle fino, la **IA local (Real-ESRGAN)** suele dar el mejor equilibrio calidad/costo.
- No abuses del 4x si no lo necesitás: subí solo hasta el tamaño físico real que vas a imprimir.

---

### 4.6 Vectorizar

**Qué hace:** convierte una imagen **raster** (píxeles) en **vector** (curvas), ideal para logos y para escalar sin perder calidad.

**Cómo se usa:**

1. Cargá la imagen (o llegá con **"Enviar a → Vectorizar"**).
2. Elegí el **motor**:
   - **Local** (**Potrace por capas**, gratis).
   - **Premium** (Recraft, paga).
3. Ajustá:
   - **Cantidad de colores** de la paleta (hasta 24).
   - **Reducción de ruido**.
   - **Conservar fondo**: vectoriza TODO (fondo incluido) para el flujo "vectorizo todo y después elimino lo que sobra". Los blancos quedan como capa imprimible (tinta blanca DTF).
4. **Editá la paleta en vivo** (panel **Capas**): cambiar el color de una capa cambia **todos** los objetos de ese color; también podés ocultar capas o bajarlas por separado.
5. **Editar UN objeto** (estilo Illustrator): hacé **clic directo sobre el objeto** en el lienzo (una letra, el gorro, un escudo). Aparece un menú con el color detectado y dos acciones — **Recolorear** (con el color que elijas) o **Borrar** (→ transparente). Solo afecta a **ese** objeto, aunque haya otros del mismo color.
6. **Editar zona** (rectángulo): arrastrá un área y elegí **Fundir** (todo al color predominante, para tapar suciedad), **Borrar** (quita el color predominante de la zona) o **Recolorear** (cambia el predominante de la zona).
7. Exportá. Las ediciones de objeto/zona **quedan en el vector** (el SVG/PDF/EPS exporta exactamente lo que ves).

**Formatos de salida:** **SVG**, **PDF**, **EPS** o **PNG**. También podés **bajar las capas por color** (una por cada color de la paleta).

**Tips:**
- Menos colores = vector más limpio y liviano. Empezá bajo y subí solo si perdés detalle importante.
- ¿Capa (todos) o clic (uno)? Para recolorear **todo un color** usá la capa; para **un solo elemento** (una letra, un parche) hacé clic sobre él.
- Si el logo está sobre un fondo sólido, el vector queda mucho más prolijo que partiendo de una foto con fondo complejo (combinalo con **Quitar fondo** primero).
- ¿Necesitás separar por tintas o capas? Bajá las **capas por color**.

---

### 4.7 Mockup 3D ⭐

*La otra herramienta estrella.* Muestra tu diseño **sobre un producto 3D real** para presentárselo al cliente antes de producir.

#### Productos disponibles

- **Playera**
- **Taza**
- **Vaso**
- **Gorra**

#### Cómo se usa

1. Elegí el **producto**.
2. Cargá tu diseño (o llegá con **"Enviar a → Mockup 3D"**, por ejemplo desde Quitar fondo).
3. Configurá el mockup (ver opciones abajo).
4. **Girá y hacé zoom con el mouse** para encontrar el mejor ángulo.
5. Exportá para el cliente.

#### Opciones

- **Color del producto**: elegí el color de la prenda/objeto.
- **Talla** (solo playera): **Niño, CH, M, G, XL, XXL**.
- **Varios diseños a la vez**: podés colocar más de un diseño.
- **Ubicaciones**: dónde va cada diseño — **pecho centro, escudos, hombros** (con opción **"hombros simétricos"**), **pecho completo, espalda**, etc.
- **Iluminación (brillo)**: ajustá cuánta luz recibe la escena.
- **Estampado all-over**: sublimado **full-print** que **envuelve toda la prenda**.
- **Giro automático**: la cámara gira sola (ideal para presentaciones y para el video 360°).
- **Fondo transparente**: exportá el mockup sin fondo.

#### Exportar

- **Guardar PNG**: una imagen fija del mockup.
- **Video 360°**: un giro completo del producto para mandarle al cliente. Elegís el formato: **MP4**, **GIF** o **Ambos**.

**Formatos de salida:** PNG (imagen), MP4 / GIF (video 360°).

**Tips:**
- Para catálogos o WhatsApp, el **Video 360°** vende muchísimo más que una foto plana. Activá **Giro automático** y exportá.
- Usá **"hombros simétricos"** cuando pongas escudos en ambos hombros para que queden espejados y prolijos.
- **Estampado all-over** es la opción correcta cuando el diseño cubre toda la prenda (sublimado full-print), no solo un estampado localizado.
- Si vas a montar el mockup sobre otro fondo, activá **Fondo transparente**.

---

### 4.8 Sublimado Gorras y Tazas y vasos

Estas categorías comparten el **Mockup 3D** (Gorra, y Taza/Vaso respectivamente) y algunas herramientas ya disponibles:

- **Sublimado Gorras**: **Mockup 3D** disponible. Otras herramientas (Quitar fondo, Vectorizar, Curvar diseño) figuran como **"Próximamente"**.
- **Sublimado Tazas y vasos**: **Aumentar resolución** y **Mockup 3D** disponibles. Otras (Quitar fondo, Ajustar al contorno) figuran como **"Próximamente"**.

> Las tarjetas marcadas **"Próximamente"** están atenuadas y todavía no se pueden abrir. Mientras tanto, podés usar las herramientas de **Sublimado Playeras** (como Quitar fondo o Vectorizar), que sirven igual para cualquier producto, y después mandar el resultado al **Mockup 3D** de la gorra, taza o vaso con **"Enviar a"**.

---

## 5. "Enviar a" y flujos entre herramientas

**"Enviar a"** es el pegamento de Sajaru: pasás el resultado de una herramienta directamente a otra **sin exportar ni volver a importar**. Buscá el botón **"Enviar a"** (con un ícono de avión de papel) y elegí el destino en el menú.

Flujos típicos:

- **Quitar fondo → Preparar sublimación**: recortás el sujeto y lo dejás listo para el transfer (tamaño en pulgadas, 300 DPI, espejo).
- **Quitar fondo → Mockup 3D**: recortás y lo ves puesto sobre la playera/taza/gorra al instante.
- **Quitar fondo → Vectorizar**: recortás un logo y lo convertís a vector limpio.
- **Crear diseño → Quitar fondo / Mockup 3D**: generás con IA y seguís trabajando el resultado.
- **Aumentar resolución → Preparar sublimación**: subís la calidad y preparás el archivo final.

Un flujo completo de ejemplo:

> **Crear diseño** (genero el arte) → **Quitar fondo** (lo recorto) → **Aumentar resolución** (lo subo a tamaño de impresión) → **Mockup 3D** (se lo muestro al cliente) → **Preparar sublimación** (dejo el archivo listo para el taller).

---

## 6. Atajos y consejos

### En los editores (Quitar fondo, etc.)

- **Zoom**: usá el **scroll del mouse** para acercar y alejar.
- **Panear (mover el lienzo)**: mantené la **barra espaciadora** presionada y arrastrá.
- **Deshacer**: **Cmd + Z** (Mac) / **Ctrl + Z** (Windows).
- **Comparar con el original** (Quitar fondo): **mantené presionado** el botón **"Comparar"**.

### Consejos generales

- **Probá primero con Local.** Es gratis y privado; dejá **Premium** para los casos que realmente lo pidan.
- **La primera vez** que usás un modelo de IA local, esperá la descarga inicial (necesita internet una sola vez).
- **Elegí bien el "Tipo de imagen"** en Quitar fondo (Auto/Logo/Persona/Ilustración): cambia mucho el resultado.
- **No te olvides del espejo horizontal** en Preparar sublimación.
- **Para DTF**, usá el **Contorno sticker** de Quitar fondo (bordes binarios, sin semitransparencia).
- **Aprovechá "Enviar a"** para no andar exportando e importando archivos entre pasos.
- **Cambiá el fondo del lienzo** (Cuadriculado/Blanco/Negro/Máscara) para revisar el recorte contra distintos colores y detectar halos.
- **Vigilá el saldo**: si la pastilla se pone ámbar, estás por debajo de 200 créditos.

---

## 7. Preguntas frecuentes

**¿Necesito internet para usar Sajaru Design?**
No para lo básico. Todas las opciones **Local** funcionan offline. Solo necesitás internet para **IA Premium (Recraft)** y para la **descarga inicial** de cada modelo de IA local (una sola vez por modelo).

**¿Se suben mis imágenes a algún lado?**
Con **Local**, no: todo se procesa en tu compu. Con **Premium**, se usa el servicio en la nube de Recraft.

**¿Dónde cargo la clave de API?**
Se pega **una sola vez**. Una vez configurada, aparece el indicador de saldo y se habilitan las opciones Premium.

**¿Cómo recorto varias imágenes juntas?**
En **Quitar fondo**, arrastrá varias, usá el **filmstrip** de abajo para editarlas una por una y después **"Procesar todas"** y **"Guardar todas"** (elegís una carpeta).

**El texto de mi sublimado sale al revés en la prenda. ¿Qué pasó?**
Revisá el **espejo horizontal** en **Preparar sublimación**: en sublimación el diseño se imprime espejado a propósito. Si ya venía espejado, puede que lo hayas duplicado.

**¿Cuál es la mejor forma de mostrarle el diseño al cliente?**
El **Video 360°** de **Mockup 3D** (con **Giro automático**). Exportalo en MP4 o GIF y mandáselo.

**Perdí una parte del sujeto al recortar. ¿Se puede recuperar?**
Sí. En Quitar fondo usá **Restaurar**: pinta de vuelta píxeles de la **foto original**, incluso los que el recorte automático había quitado.

---

*Sajaru Design — hecho para que el equipo produzca más rápido y con mejor calidad. Ante la duda, probá: casi todo es reversible con Cmd/Ctrl + Z.*
