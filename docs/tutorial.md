# Sajaru Design — Tutorial guiado

### De la foto del cliente a la playera lista para vender

Bienvenido a **Sajaru Design**, la suite de escritorio de la agencia. Este tutorial es un recorrido de punta a punta: vas a agarrar unas fotos que te pasó un cliente por WhatsApp y las vas a llevar hasta un mockup 3D listo para cerrar la venta, pasando por quitar fondo, vectorizar, preparar el archivo para sublimar y armar un video 360°.

No hace falta que sepas nada técnico. Seguí los pasos con la app abierta al lado y andá haciendo clic donde te indica. Cada capítulo arranca con un **objetivo**, tiene **pasos numerados** y cierra con un **tip**.

> **Antes de empezar.** Vas a necesitar unas cuantas imágenes de prueba (logos de clientes, una foto de una persona, lo que tengas a mano). Guardalas en una carpeta que encuentres fácil, así las arrastrás sin buscar.

---

## Índice

1. [Primer arranque](#capitulo-1--primer-arranque)
2. [Quitar el fondo de varios logos a la vez](#capitulo-2--quitar-el-fondo-de-varios-logos-a-la-vez)
3. [Vectorizar un logo](#capitulo-3--vectorizar-un-logo)
4. [Preparar el archivo para sublimar](#capitulo-4--preparar-el-archivo-para-sublimar)
5. [Mockup 3D + video 360 para el cliente](#capitulo-5--mockup-3d--video-360-para-el-cliente)
6. [Cierre](#capitulo-6--cierre)

---

## Capítulo 1 — Primer arranque

**Objetivo:** conocer la pantalla principal, entender cómo están ordenadas las herramientas y saber la diferencia entre trabajar en modo **Estándar** (local, gratis) y **IA Premium** (paga, para los casos difíciles).

### Pasos

1. Abrí **Sajaru Design**. Arriba a la izquierda vas a ver el nombre de la app. Esa barra de arriba te acompaña siempre: tiene el **buscador** (dice *"Buscar app, proyecto…"*) y, a la derecha, el botón de **tema** (sol/luna) para cambiar entre claro y oscuro.

2. Justo debajo hay dos pestañas: **App** y **Proyectos**.
   - **App** es la grilla de herramientas. Es donde vas a vivir.
   - **Proyectos** por ahora va a estar vacío (dice *"Aún no hay proyectos"*); se llena a medida que vayas guardando trabajo.

3. Mirá la grilla. Las herramientas están agrupadas por **categoría**:
   - **Diseño y recursos** — Crear diseño, Preparar sublimación, Editar imagen.
   - **Sublimado Playeras** — Quitar fondo, Aumentar resolución, Vectorizar, Mockup 3D.
   - **Sublimado Gorras** — Quitar fondo, Vectorizar, Curvar diseño, Mockup 3D.
   - **Sublimado Tazas y vasos** — Quitar fondo, Aumentar resolución, Ajustar al contorno, Mockup 3D.

4. Vas a notar que algunas tarjetas están apagadas y dicen **Próximamente**. Todavía no se pueden abrir; son las que están en camino. Las que están firmes se iluminan cuando les pasás el mouse por encima.

5. Si tenés muchas herramientas, escribí en el buscador (por ejemplo `fondo`) y la grilla se filtra al instante. Para volver a verlas todas, borrá lo que escribiste.

6. Cuando entres a cualquier herramienta, arriba a la izquierda vas a tener siempre un botón **Volver** para regresar a la grilla.

### Estándar vs. IA Premium

En Sajaru hay dos formas de procesar una imagen. Vas a poder elegir en cada herramienta:

- **Estándar** — Corre **en tu computadora**, es **gratis** y **privado** (la imagen no sale de tu máquina). Es lo que vas a usar el 90% del tiempo y para la mayoría de los logos alcanza y sobra.
- **IA Premium** — Usa **Recraft** (inteligencia artificial en la nube). **Es paga** y **requiere una API key configurada**, pero resuelve mejor los casos difíciles: pelo, bordes complicados, curvas muy limpias al vectorizar.

**¿Dónde ves el saldo?** Si tenés la IA Premium configurada, en la barra de arriba (a la derecha, con un ícono de destello ✨) aparece una **pastilla con tu saldo** en unidades (por ejemplo `1.500 u`). Hacé clic y se abre un panel con:
- **Saldo** total, mostrado en **unidades**, y su equivalente aproximado en **US$** y en **$ MXN**.
- **Esta sesión** — cuántas **Imágenes tratadas** llevás y cuánto **Gastado** en lo que va del rato.

> **Tip.** Si NO ves la pastilla de saldo, es porque todavía no hay una API key cargada: la app funciona igual, solo que en modo **Estándar** (local y gratis). Cuando el saldo se pone bajo, la pastilla se pone amarilla y te avisa *"Saldo bajo — recargá en recraft.ai."*. Como regla: probá siempre **Estándar** primero y reservá **Premium** para cuando el resultado local no te convenza al mirar de cerca.

---

## Capítulo 2 — Quitar el fondo de varios logos a la vez

**Objetivo:** el cliente te mandó cinco logos con fondo blanco (o feo) y los querés recortar todos de una. Vamos a procesarlos en lote, revisar uno por uno, retocar lo que haga falta y guardarlos todos en una carpeta.

### Pasos

1. En la grilla, entrá a **Quitar fondo** (categoría *Sublimado Playeras*).

2. Vas a ver una zona grande que dice **Arrastra tu imagen aquí** (y abajo, los formatos: *JPG · PNG · WEBP*). **Arrastrá varias imágenes a la vez** desde tu carpeta y soltalas ahí. (También podés hacer clic en la zona para elegirlas desde el explorador.)

3. Al cargar **2 o más imágenes**, aparece el **filmstrip**: una tira de miniaturas, una por cada foto. Cada miniatura muestra su estado (pendiente, procesando, lista o con error). Desde ahí podés:
   - Hacer clic en una miniatura para verla en grande.
   - Sacar una que se te coló (la ✕ arriba de la miniatura).
   - Sumar más con el botón **Agregar**.

4. Antes de procesar, elegí bien el **Tipo de imagen** (está en el panel de ajustes, a la derecha). Las opciones son:
   - **Auto** — que la app decida (buena opción por defecto).
   - **Logo** — para logos y arte plano.
   - **Persona** — para fotos de gente.
   - **Ilustración** — para dibujos e ilustración.

   Como son logos, poné **Logo**.

5. Fijate también en la sección **Calidad** (mismo panel). Ahí elegís entre **Estándar** y **Premium (IA)**. Dejalo en **Estándar** por ahora.

6. Hacé clic en **Procesar todas**. La app le va a quitar el fondo a todas las pendientes, una tras otra. Vas a ver cómo las miniaturas van pasando a "lista" (punto verde).

7. Cuando terminen, **revisá cada una** haciendo clic en su miniatura. Para chequear si el recorte quedó fiel al original, usá **Comparar**: **mantené presionado** ese botón y, mientras lo tengas apretado, vas a ver la foto original; al soltar, vuelve el recorte. Así detectás halos, pedazos comidos o restos de fondo.

### Retoques finos (cuando una no quedó perfecta)

En el panel de herramientas (a la izquierda del recorte) tenés un juego de pinceles. Los más importantes para el día a día:

- **Restaurar (pintar de vuelta lo borrado)** — el pincel más útil. Si el recorte se comió un pedazo del logo, pintá encima y **trae de vuelta los píxeles de la foto original** en esa zona. Ideal para recuperar detalles finos.
- **Varita (borrar color)** — borra un color de un clic. Perfecta para fondos parejos: clic en el fondo y desaparece. Con el control **Tolerancia** ajustás cuánto abarca, y con **Contiguo / Todo el color** decidís si borra solo la mancha que tocaste o **ese color en toda la imagen** (buenísimo para fondos partidos en parches).
- **Borrador** — borra a mano lo que sobre.
- **Restaurar todo** / **Deshacer** — si te pasaste, volvé atrás sin drama.

Todos los pinceles tienen su barra de opciones arriba con **Tamaño**, **Dureza del pincel** (borde duro o suave) y **Flujo**.

### Casos difíciles: la Selección inteligente (SAM)

Si un fondo es un lío (muchos colores, sombras, el sujeto pegado al fondo), usá la **Selección** inteligente:

1. Activá la herramienta de **Selección**.
2. Para recortar objetos puntuales, hacé clic sobre el sujeto (o arrastrá un recuadro): la app entiende qué es sujeto y qué es fondo. Podés alternar **Sumar** / **Quitar** para afinar.
3. Para fondos muy enredados, usá **Analizar todo**: la app analiza toda la imagen (tarda cerca de un minuto) y te deja elegir las regiones. Cuando marcaste lo que querés, tocá **Aplicar**.
4. Si te tira que quedaron restos de fondo, te ofrece **Quitar** o **Descartar** esos pedacitos.

> **Tip.** ¿Se te comió el pelo o un borde fino? No lo borres a mano: usá primero **Restaurar** para recuperar y, si es una foto de persona con pelo suelto, mirá la herramienta **Recuperar pelo**, que reconstruye mechones finos. Y recordá: si en **Estándar** un caso no sale, cambiá **Calidad** a **Premium (IA)** y volvé a procesar esa imagen; casi siempre resuelve los bordes imposibles (eso sí, consume saldo).

### Guardar todo

1. Cuando todas las recortadas te convenzan, hacé clic en **Guardar todas** (te muestra entre paréntesis cuántas hay listas, por ejemplo *Guardar todas (5)*).
2. Elegí una **carpeta destino** y la app guarda todos los recortes ahí, en PNG con transparencia.

### Pasar el recorte a la siguiente herramienta

Acá está la magia de Sajaru: no exportás y volvés a importar. Elegí la imagen que quieras seguir trabajando y usá el botón **Enviar a**. Se despliega un menú con los destinos:

- **Preparar sublimación**
- **Mockup 3D**
- **Vectorizar**

El recorte pasa **directo** a esa herramienta, ya cargado, sin tocar el disco. Para el próximo capítulo, elegí **Enviar a → Vectorizar** con uno de tus logos.

> **Tip.** "Enviar a" te ahorra guardar/abrir en cada paso y evita perder calidad por reexportar. Pensá el flujo como una cinta: recorte → vectorizar → sublimación → mockup.

---

## Capítulo 3 — Vectorizar un logo

**Objetivo:** convertir el logo recortado (que es una imagen de píxeles) en un **vector** nítido, que se puede agrandar a cualquier tamaño sin pixelarse. Indispensable para logos que van grandes en la espalda o chiquitos en un bolsillo.

### Pasos

1. Si venís del capítulo anterior con **Enviar a → Vectorizar**, el logo ya está cargado. Si entrás de cero a **Vectorizar**, arrastrá la imagen a la zona **Arrastra tu imagen aquí**.

2. La app vectoriza **sola** apenas cargás la imagen (no hay que apretar ningún botón "Vectorizar": se rehace solo cada vez que cambiás algo). Mientras trabaja vas a ver *"Vectorizando…"*.

3. Elegí el **Motor** en el panel derecho (Ajustes):
   - **Local** — Potrace por capas: gratis y privado. Anda bien para la mayoría de los logos.
   - **IA Premium** — Recraft (IA). Da curvas muy limpias pero consume saldo y necesita API key.

   Empezá con **Local**.

4. Ajustá el control **Colores** (un deslizador de 2 a 24). Menos colores = resultado más limpio y plano; más colores = más detalle. **Para logos planos, pocos colores suelen verse mejor.** Movelo y mirá cómo cambia el preview.

5. Del lado del preview tenés el panel de **Capas** (una por color). Podés mostrar/ocultar una capa, verla sola, o cambiarle el color haciendo clic en su cuadrito. **Ojo:** cambiar el color de una capa cambia **TODOS** los objetos de ese color en el diseño.

6. Si tu diseño trae fondo y querés el flujo clásico de vectorizado ("vectorizo todo y después borro lo que sobra"), activá **Conservar fondo**: el fondo y los blancos quedan como capas (el blanco es tinta imprimible en DTF).

### Moverte por el lienzo

Igual que en Figma o Illustrator:

- **Scroll** (dos dedos en el trackpad) = **desplazar** la imagen.
- **Pinch** o **⌘ + scroll** = **zoom hacia el cursor** (también están los botones − / + abajo).
- **Espacio + arrastrar** = manito para moverte, en cualquier modo.
- **Doble clic** en el vacío = ajustar a la ventana.

La **barra de estado** (abajo del lienzo) siempre muestra el zoom y qué hace la herramienta activa. Para revisar bordes antes de exportar: pinch para acercarte y scroll para recorrer el contorno.

### Seleccionar y editar objetos (clic)

¿Querés cambiar el color de **una** letra, **un** escudo o **el** gorro — sin tocar el resto de ese color? No uses la capa: **seleccionalo en el preview**.

1. **Clic sobre el objeto** → se **resalta en celeste** (eso es lo que está seleccionado, ni más ni menos).
2. **Shift+clic** suma más objetos a la selección (o quita uno ya seleccionado). **Escape** o clic en el vacío deselecciona.
3. En la **barra de acciones** que aparece arriba del lienzo: elegí el color y tocá **Recolorear**, o tocá **Borrar** (también con la tecla **Supr**).
4. Solo cambian los objetos **seleccionados** (las piezas conectadas que clickeaste), aunque haya veinte más del mismo color. Estilo Illustrator.

### Grupos: "esto son las letras, esto es el gorro"

Para no re-seleccionar lo mismo cada vez:

1. Seleccioná los objetos (clic + shift+clic) y tocá **Guardar como grupo**.
2. En el panel **Grupos** (a la derecha): escribí el nombre real ("Letras", "Gorro", "Barba", "Playera").
3. **Tocá el swatch del grupo** y se recolorea **todo el grupo de una**. Pasá el mouse por la fila y se resalta en el lienzo.
4. Los grupos sobreviven aunque cambies colores o re-traces. Eliminarlo no toca el diseño (es solo la selección guardada).

### Limpiar zonas y bordes (rectángulo)

Si quedaron manchitas o líneas raras en los bordes (típico cuando el fondo original tenía un color parecido):

1. Activá **Editar zona** y elegí el modo: **Emparejar** (tapa la zona con su color predominante), **Borrar** (quita el color predominante, útil para restos de fondo) o **Recolorear**.
2. **Arrastrá un rectángulo** sobre la zona — vale cualquier franja, aunque sea finita (2 px de alto). Con **espacio** te movés sin salir del modo.
3. Repetí en cada zona sucia. Cuando termines, tocá **Listo**.

### Deshacer (de verdad)

- **⌘Z** deshace **la última acción**, sea de capas, de objetos o de zona — de a un paso (recolorear un grupo entero = un paso). **⌘⇧Z** rehace. También tenés las flechas ↶ ↷ arriba.
- **Quitar ediciones (N)** borra TODAS las ediciones raster de una (las de capas quedan).
- **Restaurar** (en Capas) vuelve la paleta al estado inicial.

> Con motor **Local**, todas estas ediciones **quedan grabadas en el vector**: el SVG/PDF/EPS que exportás es exactamente lo que ves. Con **IA Premium** las curvas pagas no se re-trazan, así que la edición de objetos/zonas está deshabilitada (las capas sí se editan, sin gastar créditos).

### Exportar el vector

Arriba a la derecha está el botón **Exportar** — un solo menú con todo:

- **Guardar SVG** — vector real, escalable a cualquier tamaño (el formato estrella).
- **PDF** — vectorial, ideal para imprenta / plotter.
- **EPS** — vectorial, también para imprenta / plotter.
- **Guardar PNG** / **Copiar PNG** — si necesitás una versión en píxeles.

> **Tip.** Para que el logo quede impecable, subí el zoom del preview y revisá los bordes de las curvas antes de exportar. Si con **Local** las curvas te quedan "dentadas" en un logo con formas muy suaves, probá **IA Premium**: suele devolver curvas mucho más limpias. Y no te pases de **Colores**: un logo de 3 tintas no necesita 12.

---

## Capítulo 4 — Preparar el archivo para sublimar

**Objetivo:** dejar el diseño con el **tamaño físico exacto** (en pulgadas), a **300 DPI** y **en espejo**, que es como tiene que salir para el transfer de sublimación. Después lo exportás en el formato que use tu impresora.

### Pasos

1. Traé el diseño con **Enviar a → Preparar sublimación** (desde Quitar fondo o desde otra herramienta), o entrá a **Preparar sublimación** y arrastrá el archivo a **Arrastra tu diseño aquí**.

   > Lo ideal es un **PNG sin fondo**, ya vectorizado o en alta resolución.

2. En la sección **Tamaño físico**, poné las medidas reales de la estampa:
   - **Ancho (in)** — el ancho en pulgadas.
   - **Alto (in)** — el alto en pulgadas.

   También tenés **presets** para no calcular a mano, por ejemplo *Playera frente (11×14″)*, *Playera bolsillo (4×4″)*, *Taza 11oz*, *Gorra*, *Mousepad*. Hacé clic en el que corresponda y listo.

3. Verificá la salida a **300 DPI**. Es la resolución estándar de impresión para sublimado y en esta herramienta ya viene fija en 300 DPI, así que no tenés que tocar nada: solo asegurate de que la imagen que trajiste tenga resolución suficiente para el tamaño que elegiste.

4. Dejá tildado **Espejo (para transfer)**. En sublimación el diseño se imprime **invertido** para que quede derecho cuando lo transferís a la tela. En la barra de estado vas a ver *"· espejo ✓"* cuando está activo.

5. Elegí el **formato** de salida:
   - **PNG** — el de siempre.
   - **TIFF** — máxima calidad de impresión (recomendado si tu flujo/RIP lo acepta).

6. Hacé clic en **Guardar** y elegí dónde dejar el archivo. Ya está listo para mandar a imprimir.

> **Tip.** El **Espejo** es el error más común de quien arranca: si te olvidás de tildarlo, la estampa sale al revés en la tela (texto espejado). Chequealo siempre antes de **Guardar**. Y confirmá que el **Ancho/Alto** en pulgadas coincida con el área imprimible de tu playera/producto.

---

## Capítulo 5 — Mockup 3D + video 360 para el cliente

**Objetivo:** mostrarle al cliente cómo va a quedar la prenda **antes de producir**. Vamos a armar un mockup 3D realista, ubicar el diseño, ajustar la luz y exportar una **imagen** y un **video 360°** para mandar por WhatsApp y cerrar la venta.

### Pasos

1. Traé el diseño con **Enviar a → Mockup 3D** (desde Quitar fondo o Vectorizar). El diseño aparece solo en la lista de **Diseños**. Si entrás directo a **Mockup 3D**, en la lista de diseños hacé clic donde dice **Arrastrá o hacé clic para cargar tu diseño**, o usá el botón **Agregar**.

2. Elegí el **Producto** (botones): **Playera**, **Taza**, **Vaso** o **Gorra**. Para este ejemplo, **Playera**.

3. Elegí el **color de la prenda**. Tenés swatches con nombre — *Blanco, Negro, Marino, Gris, Rojo, Azul, Verde, Arena* — y, si el cliente quiere un color raro, un selector para elegir uno a medida.

4. Solo para la **Playera**, elegí la **Talla**: *Niño, CH, M, G, XL, XXL*. La prenda cambia de tamaño y **el estampado escala con ella** (M es la referencia).

5. Ubicá el diseño. Seleccioná el diseño en la lista y, en **Ubicación**, elegí dónde va. En playera tenés, entre otras: *Pecho centro, Escudo izq., Escudo der., Hombro izq., Hombro der., Pecho completo, Espalda, Espalda cuello*.
   - ¿Diseño en los dos hombros? Tildá **Hombros simétricos** y, al editar un hombro, se actualiza el otro solo.
   - Podés cargar **varios diseños** (por ejemplo, logo en el pecho y otro en la espalda): agregalos y ubicá cada uno.

6. Si el cliente quiere un **estampado que cubra toda la prenda**, tildá **Estampado all-over (sublimado full)**: el primer diseño se usa como textura que cubre toda la superficie, en vez de ir como una calca en un punto.

7. **Girá el modelo** con el mouse: **arrastrá** para rotarlo y usá la **rueda** para acercar/alejar. Así lo ves desde todos los ángulos. Si querés que gire solo, tildá **Giro automático**.

8. Ajustá la luz en **Iluminación** con el control **Brillo**, hasta que la prenda se vea natural (ni quemada ni apagada). Si vas a exportar en PNG para montar sobre otro fondo, tildá **Fondo transparente**.

### Exportar para el cliente

- **Imagen fija:** hacé clic en **Guardar PNG**. Te descarga el mockup como imagen; el botón te confirma con *"Guardado ✓"*.
- **Video 360°:** en la sección **Video 360°** elegí el formato — **MP4**, **GIF** o **Ambos** — y hacé clic en **Exportar giro 360°**. La app **gira el producto 360°** y arma el video. Vas a ver el progreso (*"Capturando giro…"* y después *"Codificando…"*). Cuando termina, lo tenés listo para mandar por WhatsApp.

> **Tip.** Para WhatsApp, el **MP4** pesa poco y se reproduce solo en el chat: es la mejor opción para enganchar al cliente. El **GIF** sirve si necesitás que se vea en previsualización sin abrir. Antes de exportar, dale un giro con el mouse y elegí el color que más le va a gustar al cliente; el video vende mucho más que una foto plana.

---

## Capítulo 6 — Cierre

**Objetivo:** repasar el flujo completo y saber cómo seguir.

Recorriste la cinta entera de la agencia:

1. **Primer arranque** — la grilla por categorías y la diferencia entre **Estándar** (local, gratis, privado) e **IA Premium** (Recraft, paga, para casos difíciles), con el saldo siempre a la vista.
2. **Quitar fondo** — varios logos de una con **Procesar todas**, retoques con **Restaurar** y **Varita**, chequeo con **Comparar**, y **Guardar todas**.
3. **Vectorizar** — el logo nítido a cualquier tamaño, paleta limpia y export a **SVG/PDF/EPS**.
4. **Preparar sublimación** — tamaño en pulgadas, **300 DPI** y **Espejo**, export a **PNG/TIFF**.
5. **Mockup 3D** — la prenda armada, el diseño ubicado, y una **imagen** + **video 360°** para cerrar la venta.

Y todo encadenado con **Enviar a**, sin exportar y reimportar en cada paso.

### Próximos pasos

- Probá el mismo flujo con otros productos: **Taza**, **Vaso** y **Gorra** también tienen su **Mockup 3D** (con sus propias ubicaciones: en tazas y vasos, *Frente / Atrás / Izquierda / Derecha*; en gorras, *Frente / Lateral izq. / Lateral der. / Atrás*).
- Explorá **Aumentar resolución** cuando el cliente te pase una foto chica o pixelada, antes de vectorizar o sublimar.
- Mirá **Crear diseño** y **Editar imagen** en *Diseño y recursos* para armar arte desde cero o hacer ajustes rápidos.

> **Tip final.** Trabajá siempre en **Estándar** primero: es gratis, privado y suficiente para la mayoría de los trabajos. Guardá el saldo de **IA Premium** para los pelos imposibles, los bordes rebeldes y las curvas que tienen que quedar impecables. Con esta rutina, pasás de la foto que te tiran por WhatsApp a la playera lista para vender en pocos minutos.
