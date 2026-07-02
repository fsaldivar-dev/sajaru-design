/** Registry of background-removal ONNX models the sidecar can download + run. */
export interface ModelDef {
  id: string
  name: string
  url: string
  fileName: string
  /** Approx download size, for the UI/progress text. */
  sizeMB: number
  /** Square model input size (e.g. 1024). */
  inputSize: number
  /** Per-channel normalization applied to the pixel value. */
  mean: [number, number, number]
  std: [number, number, number]
  /**
   * Escala del píxel ANTES de aplicar mean/std:
   *  - false (default, BiRefNet/U²-Net/RMBG): `(px/255 - mean)/std` (mean/std en 0..1).
   *  - true  (SAM/MobileSAM): `(px - mean)/std` con px en 0..255 (mean/std en 0..255).
   * Se separa porque SAM NO usa la normalización ImageNet 0..1 del resto.
   */
  pixelScale255?: boolean
  /** Apply sigmoid to the raw output before using it as a matte. */
  sigmoid: boolean
  /** Min-max normalize the output map to [0,1] (saliency-style models). */
  normalizeOutput: boolean
  /**
   * Layout que pide el ONNX para la imagen de entrada (solo encoders SAM):
   *  - 'hwc'  (MobileSAM): tensor [H,W,3], SIN batch.
   *  - 'nchw' (SAM ViT-B): tensor [1,3,H,W], canal-planar.
   * Default (undefined) = 'hwc' por compat con MobileSAM. Lo usa core/sam.ts para
   * armar el tensor con el layout correcto; el resto del pipeline lo ignora.
   */
  encoderLayout?: 'hwc' | 'nchw'
  /** Nombre del input de imagen del encoder SAM (ej. 'input_image' | 'pixel_values'). */
  encoderInputName?: string
  /** Nombre del output de embedding del encoder SAM (puede haber outputs extra). */
  encoderOutputName?: string
  note?: string
}

// BiRefNet (MIT, uso comercial OK) reemplaza a rmbg-1.4 como default: gana
// benchmarks independientes y sus pesos son aptos para producto comercial.
// Usamos la variante "lite" (swin_tiny, ~213MB) por velocidad en CPU.
export const DEFAULT_MODEL = 'birefnet'

export const MODELS: ModelDef[] = [
  {
    id: 'birefnet',
    name: 'BiRefNet (recomendado)',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx',
    fileName: 'birefnet-lite.onnx',
    sizeMB: 213,
    inputSize: 1024,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    sigmoid: true,
    normalizeOutput: false,
    note: 'Licencia MIT (apto comercial). Mejor calidad en bordes/sujetos. ~213MB.'
  },
  {
    id: 'rmbg-1.4',
    name: 'BRIA RMBG 1.4 (no comercial)',
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
    fileName: 'rmbg-1.4.onnx',
    sizeMB: 176,
    inputSize: 1024,
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    sigmoid: false,
    normalizeOutput: true,
    note: 'CC BY-NC: SÓLO uso NO comercial (requiere acuerdo con BRIA para vender). Preferí BiRefNet.'
  },
  {
    id: 'u2netp',
    name: 'U^2-Net (portable)',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    fileName: 'u2netp.onnx',
    sizeMB: 4.7,
    inputSize: 320,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    sigmoid: false,
    normalizeOutput: true
  },
  // ── MobileSAM (Apache-2.0) — segmentación promptable (click → objeto) ──
  // Dos ONNX: encoder (imagen → embedding) + decoder multimask (embedding +
  // prompt → máscaras). Los consume el módulo core/sam.ts, NO el pipeline de
  // quitar-fondo (su preproceso es distinto: HWC y normalización en 0..255).
  // ⚠️ mean/std de SAM van en escala 0..255: `(px - mean)/std`, NO la 0..1 de
  // ImageNet que usan BiRefNet/U²-Net (por eso pixelScale255 = true).
  {
    id: 'mobilesam-encoder',
    name: 'MobileSAM encoder',
    url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx',
    fileName: 'mobile-sam-encoder.onnx',
    sizeMB: 28,
    inputSize: 1024,
    mean: [123.675, 116.28, 103.53],
    std: [58.395, 57.12, 57.375],
    pixelScale255: true,
    sigmoid: false,
    normalizeOutput: false,
    note: 'Apache-2.0. Codifica la imagen a un embedding (1,256,64,64). Input HWC RGB float32 0..255 normalizado con mean/std en escala 0..255.'
  },
  {
    id: 'mobilesam-decoder',
    name: 'MobileSAM decoder (multimask)',
    url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_multi.onnx',
    fileName: 'mobile-sam-decoder.onnx',
    sizeMB: 16.5,
    inputSize: 1024,
    mean: [123.675, 116.28, 103.53],
    std: [58.395, 57.12, 57.375],
    pixelScale255: true,
    sigmoid: false,
    normalizeOutput: false,
    note: 'Apache-2.0. Decodifica embedding + prompt (puntos/box) → K máscaras (logits a tamaño original) + IoU. Elegir argmax(IoU), threshold > 0.'
  },
  // ── MODNet (Apache-2.0) — MATTING DE RETRATO (ruta "pelo" para personas) ──
  // Portrait matting fotográfico: su alfa ES el recorte (matte de retrato
  // completo, no un refinador). Recupera hebras/mechones que BiRefNet aplana en
  // silueta dura. Lo consume core/matting.ts, NO el pipeline genérico de
  // remove-bg: su preproceso es PROPIO y NO usa el `inputSize` cuadrado.
  // ⚠️ Receta validada (NO forzar 512×512 cuadrado → distorsiona/bandas):
  //   - input  'input'  [batch,3,H,W] dinámico, float32, RGB, NCHW planar.
  //   - output 'output' [batch,1,H,W] = alfa 0..1.
  //   - resize MANTENIENDO ASPECTO a max(W,H)→512, cada dim al múltiplo de 32 más
  //     cercano (mín 32) → tw×th; normalizar (x-127.5)/127.5 (= (px/255-0.5)/0.5,
  //     de ahí mean/std 0.5); alfa → ×255 → resize de vuelta a W×H original.
  // mean/std 0.5 + pixelScale255=false reproducen EXACTO (x-127.5)/127.5; el resto
  // de los campos están por compat del tipo (matting.ts usa su propio preproceso).
  {
    id: 'modnet',
    name: 'MODNet (matting de pelo, personas)',
    url: 'https://huggingface.co/DavG25/modnet-pretrained-models/resolve/main/models/modnet_photographic_portrait_matting.onnx',
    fileName: 'modnet-portrait.onnx',
    sizeMB: 26,
    inputSize: 512,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    sigmoid: false,
    normalizeOutput: false,
    note: 'Apache-2.0. Portrait matting: su alfa ES el recorte (con pelo). Lo usa core/matting.ts (preproceso propio: aspecto-preservado múltiplo de 32, NO 512 cuadrado). Ruta "Persona" de remove-bg --hair. ~26MB.'
  },
  // ── SAM ViT-B (Apache-2.0) — encoder de ALTA PRECISIÓN (modo "Preciso") ──
  // Mismo embedding (1,256,64,64) que MobileSAM ⇒ el decoder MobileSAM (canónico
  // SAM) lo consume SIN cambios: es un swap de encoder, path "grado Affinity".
  // ⚠️ Firma DISTINTA a MobileSAM (verificada cargando el ONNX):
  //    input  'pixel_values'  shape [batch,3,1024,1024]  → layout NCHW (canal-planar),
  //                                                          1024 FIJO (no dinámico).
  //    outputs ['image_embeddings','image_positional_embeddings'] → tomamos el
  //            primero POR NOMBRE (hay un output extra que ignoramos).
  // Normalización: idéntica a MobileSAM. El preprocessor de HF declara mean/std
  // ImageNet en 0..1 ([0.485,0.456,0.406]/[0.229,0.224,0.225]); ×255 da EXACTO los
  // mismos números de SAM en 0..255, así que reusamos mean/std 0..255 + pixelScale255.
  {
    id: 'sam-vitb-encoder',
    name: 'SAM ViT-B encoder (preciso)',
    url: 'https://huggingface.co/Xenova/sam-vit-base/resolve/main/onnx/vision_encoder.onnx',
    fileName: 'sam-vitb-encoder.onnx',
    sizeMB: 343,
    inputSize: 1024,
    mean: [123.675, 116.28, 103.53],
    std: [58.395, 57.12, 57.375],
    pixelScale255: true,
    sigmoid: false,
    normalizeOutput: false,
    encoderLayout: 'nchw',
    encoderInputName: 'pixel_values',
    encoderOutputName: 'image_embeddings',
    note: 'Apache-2.0. SAM ViT-B (grado Affinity): embedding (1,256,64,64) + image_positional_embeddings. Input NCHW [1,3,1024,1024] "pixel_values"; ~343MB; encode más lento que MobileSAM en CPU. Va con el decoder sam-vitb-decoder.'
  },
  // ── SAM ViT-B decoder (transformers, Apache-2.0) — pareja del encoder ViT-B ──
  // El decoder MobileSAM produce máscaras FRAGMENTADAS con un embedding ViT-B (está
  // distilado a su propio encoder). Verificado: ViT-B encoder + ESTE decoder = máscara
  // limpia y ajustada. Firma (verificada cargando el ONNX):
  //   inputs:  input_points [1,1,N,2] f32 (coords en espacio 1024), input_labels
  //            [1,1,N] INT64, image_embeddings [1,256,64,64], image_positional_embeddings
  //            [1,256,64,64].
  //   outputs: iou_scores [1,1,3], pred_masks [1,1,3,256,256] (LOGITS a 256, SIN
  //            upscale interno → se upscalean en core/sam.ts mapeando 256→original).
  // Labels SAM/transformers: 1=fg, 0=bg, 2/3=esquinas de box (sin punto de padding).
  {
    id: 'sam-vitb-decoder',
    name: 'SAM ViT-B decoder (preciso)',
    url: 'https://huggingface.co/Xenova/sam-vit-base/resolve/main/onnx/prompt_encoder_mask_decoder.onnx',
    fileName: 'sam-vitb-decoder.onnx',
    sizeMB: 16,
    inputSize: 1024,
    mean: [123.675, 116.28, 103.53],
    std: [58.395, 57.12, 57.375],
    pixelScale255: true,
    sigmoid: false,
    normalizeOutput: false,
    note: 'Apache-2.0. Decoder SAM ViT-B (transformers): embedding + positional + prompt → 3 máscaras (logits 256×256) + IoU. Pareja obligatoria del encoder sam-vitb (el decoder MobileSAM no sirve para ese embedding).'
  }
]

export function findModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id)
}
