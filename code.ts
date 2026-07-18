type ExportFile = {
  name: string
  html: string
}

type UIMessage =
  | { type: 'refresh-selection' }
  | { type: 'export-frames'; frameIds: string[]; fontFallback?: string }
  | { type: 'update-font-fallback'; fontFallback?: string }
  | { type: 'cancel' }

type Matrix = [[number, number, number], [number, number, number]]

type ImageAsset = {
  cssVariable: string
  dataUrl: string
  hash: string
  mimeType: string
}

type RenderContext = {
  fontFallback: string
  imageAssets: Map<string, ImageAsset>
}

const SVG_EXPORT_SETTINGS: ExportSettingsSVGString = {
  format: 'SVG_STRING',
  svgIdAttribute: true,
  svgOutlineText: true,
  svgSimplifyStroke: false,
  colorProfile: 'DOCUMENT',
}

const DEFAULT_FONT_FALLBACK =
  '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica Neue, sans-serif'
const FONT_FALLBACK_STORAGE_KEY = 'html-exporter-font-fallback'

figma.showUI(__html__, { width: 420, height: 480, themeColors: true })

figma.on('selectionchange', () => {
  postSelection()
})

figma.ui.onmessage = async (msg: UIMessage) => {
  if (msg.type === 'refresh-selection') {
    postSelection()
    return
  }

  if (msg.type === 'cancel') {
    figma.closePlugin()
    return
  }

  if (msg.type === 'export-frames') {
    await exportFrames(msg.frameIds, msg.fontFallback)
    await saveFontFallback(msg.fontFallback)
    return
  }

  if (msg.type === 'update-font-fallback') {
    await saveFontFallback(msg.fontFallback)
  }
}

initializePlugin()

async function initializePlugin() {
  postSelection()
  await postSettings()
}

async function postSettings() {
  figma.ui.postMessage({
    type: 'settings-update',
    fontFallback: await loadFontFallback(),
  })
}

function postSelection() {
  const frames = figma.currentPage.selection.filter(isFrameNode).map((frame) => ({
    id: frame.id,
    name: frame.name,
    width: Math.round(frame.width),
    height: Math.round(frame.height),
    childCount: frame.children.length,
  }))

  figma.ui.postMessage({
    type: 'selection-update',
    frames,
    ignoredCount: figma.currentPage.selection.length - frames.length,
  })
}

async function exportFrames(frameIds: string[], fontFallbackInput?: string) {
  try {
    const frames = await resolveFrames(frameIds)
    const files: ExportFile[] = []
    const usedNames = new Set<string>()
    const fontFallback = normalizeFontFallback(fontFallbackInput)

    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      figma.ui.postMessage({
        type: 'export-progress',
        current: index + 1,
        total: frames.length,
        name: frame.name,
      })

      files.push({
        name: uniqueFileName(frame.name, usedNames),
        html: await renderFrameDocument(frame, fontFallback),
      })
    }

    figma.ui.postMessage({ type: 'export-result', files })
  } catch (error) {
    figma.ui.postMessage({
      type: 'export-error',
      message: errorMessage(error),
    })
  }
}

async function loadFontFallback() {
  const value = await figma.clientStorage.getAsync(FONT_FALLBACK_STORAGE_KEY).catch(() => undefined)
  return normalizeFontFallback(typeof value === 'string' ? value : undefined)
}

async function saveFontFallback(fontFallbackInput?: string) {
  await figma.clientStorage
    .setAsync(FONT_FALLBACK_STORAGE_KEY, normalizeFontFallback(fontFallbackInput))
    .catch(() => undefined)
}

async function resolveFrames(frameIds: string[]) {
  const frames: FrameNode[] = []

  for (const id of frameIds) {
    const node = await figma.getNodeByIdAsync(id)
    if (node && isFrameNode(node)) {
      frames.push(node)
    }
  }

  if (frames.length === 0) {
    throw new Error('Select at least one Frame before exporting.')
  }

  return frames
}

async function renderFrameDocument(frame: FrameNode, fontFallback: string) {
  await loadFonts(frame)
  const context = createRenderContext(fontFallback)

  const children = await Promise.all(
    frame.children
      .filter((child) => child.visible)
      .map((child) => safeRenderSceneNode(child, frame.absoluteTransform, context)),
  )
  const frameBackground = await paintStyles(frame.fills, 'background', frame, context)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(frame.name)}</title>
  <style>
    * { box-sizing: border-box; }
${imageAssetStyleBlock(context)}
    html, body { margin: 0; min-height: 100%; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f3f4f6;
      font-family: Inter, Arial, sans-serif;
    }
    .figma-frame {
      position: relative;
      width: ${formatNumber(frame.width)}px;
      height: ${formatNumber(frame.height)}px;
      overflow: hidden;
      ${frameBackground}
      ${cornerRadius(frame)}
      ${effectsStyle(frame)}
    }
    .figma-node {
      position: absolute;
      transform-origin: 0 0;
      background-repeat: no-repeat;
    }
    .figma-text {
      white-space: pre-wrap;
      overflow-wrap: break-word;
    }
    .figma-vector {
      overflow: visible;
      line-height: 0;
      color: inherit;
    }
    .figma-vector > svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <main class="figma-frame" data-name="${escapeAttribute(frame.name)}">
${indent(children.join('\n'), 4)}
  </main>
</body>
</html>
`
}

function createRenderContext(fontFallback: string): RenderContext {
  return {
    fontFallback,
    imageAssets: new Map(),
  }
}

async function renderSceneNode(node: SceneNode, parentMatrix: Matrix, context: RenderContext): Promise<string> {
  if (!isMeasurable(node)) {
    return ''
  }

  if (node.type === 'TEXT') {
    return renderTextNode(node, parentMatrix, context)
  }

  if (isVectorLike(node)) {
    return renderSvgNode(node, parentMatrix)
  }

  if (isContainerNode(node)) {
    const children = await Promise.all(
      node.children
        .filter((child) => child.visible)
        .map((child) => safeRenderSceneNode(child, node.absoluteTransform, context)),
    )

    return `<div class="figma-node" data-name="${escapeAttribute(node.name)}" style="${await visualStyle(node, parentMatrix, context)}">${children.join('\n')}</div>`
  }

  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
    return `<div class="figma-node" data-name="${escapeAttribute(node.name)}" style="${await visualStyle(node, parentMatrix, context)}"></div>`
  }

  return renderSvgNode(node, parentMatrix)
}

async function renderTextNode(node: TextNode, parentMatrix: Matrix, context: RenderContext) {
  const style = textContainerStyle(node, parentMatrix)
  const contentStyle = await textBlockStyle(node, context.fontFallback)
  const text = await renderTextContent(node, contentStyle, context)

  return `<div class="figma-node figma-text" data-name="${escapeAttribute(node.name)}" style="${style}"><div style="${contentStyle}">${text}</div></div>`
}

async function safeRenderSceneNode(node: SceneNode, parentMatrix: Matrix, context: RenderContext) {
  try {
    return await renderSceneNode(node, parentMatrix, context)
  } catch (error) {
    return `<!-- Skipped ${escapeHtml(node.type)} "${escapeHtml(node.name)}": ${escapeHtml(errorMessage(error))} -->`
  }
}

async function renderSvgNode(node: SceneNode, parentMatrix: Matrix) {
  const svg = await node.exportAsync(SVG_EXPORT_SETTINGS).catch((error: unknown) => {
    throw new Error(`Could not export "${node.name}" as SVG: ${errorMessage(error)}`)
  })

  return `<div class="figma-node figma-vector" data-name="${escapeAttribute(node.name)}" style="${baseStyle(node, parentMatrix)} ${blendStyle(node)} ${effectsStyle(node)}">${normalizeSvg(svg, node.id)}</div>`
}

async function visualStyle(node: SceneNode, parentMatrix: Matrix, context: RenderContext) {
  return [
    baseStyle(node, parentMatrix),
    await nodePaintStyle(node, context),
    await strokeStyle(node),
    cornerRadius(node),
    blendStyle(node),
    effectsStyle(node),
    clipStyle(node),
  ].join(' ')
}

function baseStyle(node: SceneNode, parentMatrix: Matrix) {
  const matrix = relativeMatrix(parentMatrix, node.absoluteTransform)

  return [
    `width: ${formatNumber(node.width)}px;`,
    `height: ${formatNumber(node.height)}px;`,
    `transform: matrix(${formatNumber(matrix[0][0])}, ${formatNumber(matrix[1][0])}, ${formatNumber(matrix[0][1])}, ${formatNumber(matrix[1][1])}, ${formatNumber(matrix[0][2])}, ${formatNumber(matrix[1][2])});`,
    `opacity: ${formatNumber(nodeOpacity(node))};`,
  ].join(' ')
}

function textContainerStyle(node: TextNode, parentMatrix: Matrix) {
  return [
    baseStyle(node, parentMatrix),
    blendStyle(node),
    effectsStyle(node),
    clipStyle(node),
    `display: flex;`,
    `flex-direction: column;`,
    `justify-content: ${verticalAlign(node.textAlignVertical)};`,
    `background: transparent;`,
  ].join(' ')
}

async function nodePaintStyle(node: SceneNode, context: RenderContext) {
  if ('fills' in node) {
    return paintStyles(node.fills, 'background', node, context)
  }

  return 'background: transparent;'
}

async function paintStyles(
  paints: ReadonlyArray<Paint> | symbol,
  property: 'background' | 'color' = 'background',
  consumer?: SceneNode,
  context?: RenderContext,
) {
  if (typeof paints === 'symbol') {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  const visiblePaints = paints.filter((paint) => paint.visible !== false)
  if (visiblePaints.length === 0) {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  const layers = await Promise.all(visiblePaints.map((paint) => paintToCss(paint, property, consumer, context)))
  const values = layers.filter(Boolean)

  if (values.length === 0) {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  if (property === 'color') {
    return `color: ${values[0]};`
  }

  return `background: ${values.reverse().join(', ')}; ${backgroundSizing(visiblePaints)}`
}

async function paintToCss(
  paint: Paint,
  property: 'background' | 'color',
  consumer?: SceneNode,
  context?: RenderContext,
) {
  if (paint.type === 'SOLID') {
    const color = await resolvePaintColor(paint, consumer)
    return rgba(color, paint.opacity ?? 1)
  }

  if (property === 'color') {
    return ''
  }

  if (paint.type === 'IMAGE' && paint.imageHash) {
    const cssVariable = context ? await registerImageAsset(context, paint.imageHash) : ''
    return cssVariable ? `var(${cssVariable})` : ''
  }

  if (paint.type === 'GRADIENT_LINEAR') {
    return linearGradient(paint)
  }

  if (paint.type === 'GRADIENT_RADIAL') {
    return radialGradient(paint)
  }

  return ''
}

async function registerImageAsset(context: RenderContext, imageHash: string) {
  const existing = context.imageAssets.get(imageHash)
  if (existing) {
    return existing.cssVariable
  }

  const image = figma.getImageByHash(imageHash)
  if (!image) {
    return ''
  }

  const bytes = await image.getBytesAsync().catch(() => null)
  if (!bytes) {
    return ''
  }

  const mimeType = imageMimeType(bytes)
  const asset: ImageAsset = {
    cssVariable: imageCssVariableName(imageHash, context),
    dataUrl: bytesToDataUrl(bytes, mimeType),
    hash: imageHash,
    mimeType,
  }

  context.imageAssets.set(imageHash, asset)
  return asset.cssVariable
}

function imageAssetStyleBlock(context: RenderContext) {
  if (context.imageAssets.size === 0) {
    return ''
  }

  const declarations = Array.from(context.imageAssets.values()).map(
    (asset) => `${asset.cssVariable}: url("${asset.dataUrl}"); /* ${asset.hash} ${asset.mimeType} */`,
  )

  return `    :root {\n${indent(declarations.join('\n'), 6)}\n    }\n`
}

function imageCssVariableName(imageHash: string, context: RenderContext) {
  const base = `--figma-image-${sanitizeDomId(imageHash) || 'asset'}`
  const usedNames = new Set(Array.from(context.imageAssets.values()).map((asset) => asset.cssVariable))
  let name = base
  let index = 2

  while (usedNames.has(name)) {
    name = `${base}-${index}`
    index += 1
  }

  return name
}

function backgroundSizing(paints: ReadonlyArray<Paint>) {
  const imagePaint = paints.find((paint) => paint.type === 'IMAGE')

  if (!imagePaint || imagePaint.type !== 'IMAGE') {
    return ''
  }

  if (imagePaint.scaleMode === 'FIT') {
    return 'background-size: contain; background-position: center;'
  }

  if (imagePaint.scaleMode === 'TILE') {
    return `background-size: ${formatNumber((imagePaint.scalingFactor ?? 1) * 100)}%; background-repeat: repeat;`
  }

  return 'background-size: cover; background-position: center;'
}

function linearGradient(paint: GradientPaint) {
  const angle = gradientAngle(paint.gradientTransform)
  return `linear-gradient(${formatNumber(angle)}deg, ${gradientStops(paint.gradientStops)})`
}

function radialGradient(paint: GradientPaint) {
  return `radial-gradient(circle, ${gradientStops(paint.gradientStops)})`
}

function gradientStops(stops: ReadonlyArray<ColorStop>) {
  return stops
    .map((stop) => `${rgba(stop.color, stop.color.a ?? 1)} ${formatNumber(stop.position * 100)}%`)
    .join(', ')
}

function gradientAngle(transform: Transform) {
  const radians = Math.atan2(transform[1][0], transform[0][0])
  return 90 + (radians * 180) / Math.PI
}

async function resolvePaintColor(paint: SolidPaint, consumer?: SceneNode) {
  if (consumer && paint.boundVariables?.color) {
    const color = await resolveColorVariable(paint.boundVariables.color, consumer)
    if (color) {
      return color
    }
  }

  return paint.color
}

async function resolveColorVariable(alias: VariableAlias, consumer: SceneNode) {
  const variable = await figma.variables.getVariableByIdAsync(alias.id).catch(() => null)
  if (!variable) {
    return null
  }

  const resolved = variable.resolveForConsumer(consumer)
  if (resolved.resolvedType !== 'COLOR' || !isColorValue(resolved.value)) {
    return null
  }

  return resolved.value
}

function isColorValue(value: VariableValue): value is RGB | RGBA {
  return typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value
}

function strokeWeights(node: SceneNode) {
  if (hasIndividualStrokes(node)) {
    return {
      top: node.strokeTopWeight,
      right: node.strokeRightWeight,
      bottom: node.strokeBottomWeight,
      left: node.strokeLeftWeight,
    }
  }

  const weight = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : 0

  return {
    top: weight,
    right: weight,
    bottom: weight,
    left: weight,
  }
}

function sideBorderStyle(side: 'top' | 'right' | 'bottom' | 'left', weight: number, style: string, color: string) {
  return weight > 0 ? `border-${side}: ${formatNumber(weight)}px ${style} ${color};` : `border-${side}: 0;`
}

function strokeBorderStyle(node: SceneNode) {
  if ('dashPattern' in node && node.dashPattern.length > 0) {
    return node.dashPattern.length === 2 && node.dashPattern[0] <= 1 ? 'dotted' : 'dashed'
  }

  return 'solid'
}

async function strokeStyle(node: SceneNode) {
  if (!('strokes' in node) || typeof node.strokes === 'symbol') {
    return ''
  }

  const stroke = node.strokes.find((paint) => paint.visible !== false && paint.type === 'SOLID')
  if (!stroke || stroke.type !== 'SOLID') {
    return ''
  }

  const color = await resolvePaintColor(stroke, node)
  const strokeColor = rgba(color, stroke.opacity ?? 1)
  const style = strokeBorderStyle(node)
  const weights = strokeWeights(node)

  if (weights.top === weights.right && weights.right === weights.bottom && weights.bottom === weights.left) {
    return weights.top > 0 ? `border: ${formatNumber(weights.top)}px ${style} ${strokeColor};` : ''
  }

  return [
    sideBorderStyle('top', weights.top, style, strokeColor),
    sideBorderStyle('right', weights.right, style, strokeColor),
    sideBorderStyle('bottom', weights.bottom, style, strokeColor),
    sideBorderStyle('left', weights.left, style, strokeColor),
  ].join(' ')
}

function hasIndividualStrokes(node: SceneNode): node is SceneNode & IndividualStrokesMixin {
  return (
    'strokeTopWeight' in node &&
    'strokeRightWeight' in node &&
    'strokeBottomWeight' in node &&
    'strokeLeftWeight' in node
  )
}

function hasIndependentCornerRadius(node: SceneNode): node is SceneNode & RectangleCornerMixin {
  return (
    'topLeftRadius' in node &&
    'topRightRadius' in node &&
    'bottomRightRadius' in node &&
    'bottomLeftRadius' in node
  )
}

function cornerRadius(node: SceneNode) {
  if (node.type === 'ELLIPSE') {
    return 'border-radius: 50%;'
  }

  if (hasIndependentCornerRadius(node)) {
    return `border-radius: ${formatNumber(node.topLeftRadius)}px ${formatNumber(node.topRightRadius)}px ${formatNumber(node.bottomRightRadius)}px ${formatNumber(node.bottomLeftRadius)}px;`
  }

  if (!('cornerRadius' in node) || typeof node.cornerRadius !== 'number') {
    return ''
  }

  return `border-radius: ${formatNumber(node.cornerRadius)}px;`
}

function blendStyle(node: SceneNode) {
  const styles: string[] = []

  if ('blendMode' in node && node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL') {
    styles.push(`mix-blend-mode: ${blendModeToCss(node.blendMode)};`)
  }

  return styles.join(' ')
}

function effectsStyle(node: SceneNode) {
  if (!('effects' in node) || typeof node.effects === 'symbol') {
    return ''
  }

  const shadows = node.effects
    .filter(isShadowEffect)
    .map((effect) => {
      const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : ''
      return `${inset}${formatNumber(effect.offset.x)}px ${formatNumber(effect.offset.y)}px ${formatNumber(effect.radius)}px ${formatNumber(effect.spread ?? 0)}px ${rgba(effect.color, effect.color.a ?? 1)}`
    })

  return shadows.length > 0 ? `box-shadow: ${shadows.join(', ')};` : ''
}

function clipStyle(node: SceneNode) {
  if ('clipsContent' in node && node.clipsContent) {
    return 'overflow: hidden;'
  }

  return 'overflow: visible;'
}

function nodeOpacity(node: SceneNode) {
  return 'opacity' in node && typeof node.opacity === 'number' ? node.opacity : 1
}

function isShadowEffect(effect: Effect): effect is DropShadowEffect | InnerShadowEffect {
  return effect.visible !== false && (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW')
}

async function textBlockStyle(node: TextNode, fontFallback: string) {
  const css: { [key: string]: string } = await node.getCSSAsync().catch(() => ({}))

  return [
    cssFontFamilyStyle(css['font-family'], fontFallback),
    cssToInlineStyle(css, [
      'font-size',
      'font-style',
      'font-weight',
      'font-variant',
      'font-feature-settings',
      'line-height',
      'letter-spacing',
      'text-align',
      'text-decoration',
      'text-transform',
      'color',
    ]),
    `text-align: ${node.textAlignHorizontal.toLowerCase()};`,
    `margin: 0;`,
    `padding: 0;`,
    `width: 100%;`,
  ].join(' ')
}

async function renderTextContent(node: TextNode, contentStyle: string, context: RenderContext) {
  const boundaries = node.getStyledTextSegments([
    'fontName',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'fills',
    'letterSpacing',
    'lineHeight',
    'textCase',
    'textDecoration',
  ])

  if (boundaries.length === 0) {
    return escapeHtml(applyTextCase(node.characters, node.textCase))
  }

  if (boundaries.length === 1) {
    const segment = boundaries[0]
    return `<span data-figma-css="${escapeAttribute(contentStyle)}">${escapeHtml(applyTextCase(segment.characters, segment.textCase))}</span>`
  }

  const renderedSegments = await Promise.all(
    boundaries.map(async (segment) => {
      const range = readTextRangeStyle(node, segment.start, segment.end)
      const style = [
        rangeTextStyle(range, context.fontFallback),
        await paintStyles(range.fills, 'color', node, context),
      ].join(' ')

      return `<span data-figma-font-size="${formatNumber(range.fontSize)}" data-figma-color="${escapeAttribute(await paintDebugColor(range.fills, node))}" style="${style}">${escapeHtml(applyTextCase(segment.characters, range.textCase))}</span>`
    }),
  )

  return renderedSegments.join('')
}

function readTextRangeStyle(node: TextNode, start: number, end: number) {
  const fontName = node.getRangeFontName(start, end)
  const fontSize = node.getRangeFontSize(start, end)
  const fontWeightValue = node.getRangeFontWeight(start, end)
  const fills = node.getRangeFills(start, end)
  const letterSpacing = node.getRangeLetterSpacing(start, end)
  const lineHeight = node.getRangeLineHeight(start, end)
  const textCase = node.getRangeTextCase(start, end)
  const textDecorationValue = node.getRangeTextDecoration(start, end)

  return {
    fontName,
    fontSize: typeof fontSize === 'symbol' ? 16 : fontSize,
    fontWeight: fontWeightValue,
    fills: normalizeMixed(fills),
    letterSpacing,
    lineHeight,
    textCase: normalizeMixed(textCase),
    textDecoration: textDecorationValue,
  }
}

function normalizeMixed<T>(value: T | symbol): T | symbol {
  return typeof value === 'symbol' ? figma.mixed : value
}

function rangeTextStyle(range: ReturnType<typeof readTextRangeStyle>, fontFallback: string) {
  const fontName = range.fontName
  const fontFamily = typeof fontName === 'symbol' ? 'Inter' : fontName.family
  const fontStyle = typeof fontName === 'symbol' ? 'Regular' : fontName.style
  const fontSize = range.fontSize
  const lineHeight = typeof range.lineHeight === 'symbol' ? 'normal' : lineHeightValue(range.lineHeight, fontSize)
  const letterSpacing =
    typeof range.letterSpacing === 'symbol' ? 'normal' : letterSpacingValue(range.letterSpacing, fontSize)
  const fontWeightValue =
    typeof range.fontWeight === 'symbol' ? fontWeight(fontStyle) : range.fontWeight
  const decoration = typeof range.textDecoration === 'symbol' ? 'none' : textDecoration(range.textDecoration)

  return [
    `font-family: ${appendFontFallback(cssFontFamilyName(fontFamily), fontFallback)};`,
    `font-size: ${formatNumber(fontSize)}px;`,
    `font-weight: ${fontWeightValue};`,
    `font-style: ${fontStyle.toLowerCase().includes('italic') ? 'italic' : 'normal'};`,
    `line-height: ${lineHeight};`,
    `letter-spacing: ${letterSpacing};`,
    `text-decoration: ${decoration};`,
  ].join(' ')
}

async function paintDebugColor(paints: ReadonlyArray<Paint> | symbol, consumer: SceneNode) {
  if (typeof paints === 'symbol') {
    return 'mixed'
  }

  const paint = paints.find((item) => item.visible !== false)
  if (!paint || paint.type !== 'SOLID') {
    return paint?.type ?? 'none'
  }

  return rgba(await resolvePaintColor(paint, consumer), paint.opacity ?? 1)
}

async function loadFonts(node: SceneNode) {
  if (node.type === 'TEXT') {
    const fontNames = node.getRangeAllFontNames(0, node.characters.length)
    await Promise.all(fontNames.map((fontName) => figma.loadFontAsync(fontName)))
    return
  }

  if (isContainerNode(node)) {
    await Promise.all(node.children.map((child) => loadFonts(child)))
  }
}

function normalizeSvg(svg: string, nodeId: string) {
  const prefix = `svg-${sanitizeDomId(nodeId)}-`

  return prefixSvgIds(svg, prefix)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<svg\b[^>]*>/i, (tag) => tag.replace(/\s(width|height)="[^"]*"/gi, ''))
}

function cssToInlineStyle(css: { [key: string]: string }, properties: string[]) {
  return properties
    .flatMap((property) => {
      const value = css[property]
      return value ? [`${property}: ${value};`] : []
    })
    .join(' ')
}

function cssFontFamilyStyle(primaryFontFamily: string | undefined, fontFallback: string) {
  const primary = primaryFontFamily?.trim()

  if (!primary && !fontFallback) {
    return ''
  }

  return `font-family: ${appendFontFallback(primary ?? '', fontFallback)};`
}

function appendFontFallback(primaryFontFamily: string, fontFallback: string) {
  if (!primaryFontFamily) {
    return fontFallback
  }

  if (!fontFallback) {
    return primaryFontFamily
  }

  return `${primaryFontFamily}, ${fontFallback}`
}

function normalizeFontFallback(value: string | undefined) {
  const fallback = (value || DEFAULT_FONT_FALLBACK)
    .trim()
    .replace(/^font-family\s*:\s*/i, '')
    .replace(/;+\s*$/, '')

  return fallback || DEFAULT_FONT_FALLBACK
}

function cssFontFamilyName(value: string) {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : cssString(value)
}

function prefixSvgIds(svg: string, prefix: string) {
  const ids = Array.from(svg.matchAll(/\bid="([^"]+)"/g), (match) => match[1])
  let output = svg

  for (const id of ids) {
    const nextId = `${prefix}${id}`
    output = output
      .replace(new RegExp(`\\bid="${escapeRegExp(id)}"`, 'g'), `id="${nextId}"`)
      .replace(new RegExp(`url\\(#${escapeRegExp(id)}\\)`, 'g'), `url(#${nextId})`)
      .replace(new RegExp(`href="#${escapeRegExp(id)}"`, 'g'), `href="#${nextId}"`)
      .replace(new RegExp(`xlink:href="#${escapeRegExp(id)}"`, 'g'), `xlink:href="#${nextId}"`)
  }

  return output
}

function sanitizeDomId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isFrameNode(node: BaseNode): node is FrameNode {
  return node.type === 'FRAME'
}

function isContainerNode(node: SceneNode): node is SceneNode & ChildrenMixin {
  return 'children' in node
}

function isVectorLike(node: SceneNode) {
  return (
    node.type === 'VECTOR' ||
    node.type === 'BOOLEAN_OPERATION' ||
    node.type === 'STAR' ||
    node.type === 'POLYGON' ||
    node.type === 'LINE'
  )
}

function isMeasurable(node: SceneNode): node is SceneNode & LayoutMixin {
  return 'width' in node && 'height' in node && 'absoluteTransform' in node
}

function relativeMatrix(parent: Matrix, node: Matrix): Matrix {
  return multiplyMatrix(invertMatrix(parent), node)
}

function invertMatrix(matrix: Matrix): Matrix {
  const [a, c, e] = matrix[0]
  const [b, d, f] = matrix[1]
  const determinant = a * d - b * c

  if (determinant === 0) {
    return [
      [1, 0, 0],
      [0, 1, 0],
    ]
  }

  return [
    [d / determinant, -c / determinant, (c * f - d * e) / determinant],
    [-b / determinant, a / determinant, (b * e - a * f) / determinant],
  ]
}

function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return [
    [
      left[0][0] * right[0][0] + left[0][1] * right[1][0],
      left[0][0] * right[0][1] + left[0][1] * right[1][1],
      left[0][0] * right[0][2] + left[0][1] * right[1][2] + left[0][2],
    ],
    [
      left[1][0] * right[0][0] + left[1][1] * right[1][0],
      left[1][0] * right[0][1] + left[1][1] * right[1][1],
      left[1][0] * right[0][2] + left[1][1] * right[1][2] + left[1][2],
    ],
  ]
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${figma.base64Encode(bytes)}`
}

function imageMimeType(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg'
  }

  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }

  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }

  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'image/webp'
  }

  return 'application/octet-stream'
}

function rgba(color: RGB | RGBA, alpha = 1) {
  const red = Math.round(color.r * 255)
  const green = Math.round(color.g * 255)
  const blue = Math.round(color.b * 255)
  const colorAlpha = 'a' in color ? color.a : 1

  return `rgba(${red}, ${green}, ${blue}, ${formatNumber(colorAlpha * alpha)})`
}

function lineHeightValue(lineHeight: LineHeight, fontSize: number) {
  if (lineHeight.unit === 'PIXELS') {
    return `${formatNumber(lineHeight.value)}px`
  }

  if (lineHeight.unit === 'PERCENT') {
    return `${formatNumber((lineHeight.value / 100) * fontSize)}px`
  }

  return 'normal'
}

function letterSpacingValue(letterSpacing: LetterSpacing, fontSize: number) {
  if (letterSpacing.unit === 'PIXELS') {
    return `${formatNumber(letterSpacing.value)}px`
  }

  return `${formatNumber((letterSpacing.value / 100) * fontSize)}px`
}

function verticalAlign(value: TextNode['textAlignVertical']) {
  if (value === 'CENTER') {
    return 'center'
  }

  if (value === 'BOTTOM') {
    return 'flex-end'
  }

  return 'flex-start'
}

function textDecoration(value: TextDecoration) {
  if (value === 'UNDERLINE') {
    return 'underline'
  }

  if (value === 'STRIKETHROUGH') {
    return 'line-through'
  }

  return 'none'
}

function applyTextCase(value: string, textCase: TextCase | symbol) {
  if (typeof textCase === 'symbol' || textCase === 'ORIGINAL') {
    return value
  }

  if (textCase === 'UPPER') {
    return value.toUpperCase()
  }

  if (textCase === 'LOWER') {
    return value.toLowerCase()
  }

  if (textCase === 'TITLE') {
    return value.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
  }

  return value
}

function fontWeight(style: string) {
  const normalized = style.toLowerCase()

  if (normalized.includes('thin')) return 100
  if (normalized.includes('extra light') || normalized.includes('extralight')) return 200
  if (normalized.includes('light')) return 300
  if (normalized.includes('medium')) return 500
  if (normalized.includes('semi bold') || normalized.includes('semibold')) return 600
  if (normalized.includes('extra bold') || normalized.includes('extrabold')) return 800
  if (normalized.includes('bold')) return 700
  if (normalized.includes('black')) return 900

  return 400
}

function blendModeToCss(blendMode: BlendMode) {
  const modes: Record<string, string> = {
    DARKEN: 'darken',
    MULTIPLY: 'multiply',
    COLOR_BURN: 'color-burn',
    LIGHTEN: 'lighten',
    SCREEN: 'screen',
    COLOR_DODGE: 'color-dodge',
    OVERLAY: 'overlay',
    SOFT_LIGHT: 'soft-light',
    HARD_LIGHT: 'hard-light',
    DIFFERENCE: 'difference',
    EXCLUSION: 'exclusion',
    HUE: 'hue',
    SATURATION: 'saturation',
    COLOR: 'color',
    LUMINOSITY: 'luminosity',
  }

  return modes[blendMode] ?? 'normal'
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch (_jsonError) {
    return String(error)
  }
}

function uniqueFileName(name: string, usedNames: Set<string>) {
  const baseName = sanitizeFileName(name) || 'frame'
  let fileName = `${baseName}.html`
  let index = 2

  while (usedNames.has(fileName.toLowerCase())) {
    fileName = `${baseName}-${index}.html`
    index += 1
  }

  usedNames.add(fileName.toLowerCase())
  return fileName
}

function sanitizeFileName(name: string) {
  return name
    .trim()
    .split('')
    .map((character) => (isInvalidFileNameCharacter(character) ? '-' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 120)
}

function isInvalidFileNameCharacter(character: string) {
  return character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character)
}

function formatNumber(value: number) {
  return Number(value.toFixed(3)).toString()
}

function cssString(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, '&#096;')
}

function indent(value: string, spaces: number) {
  const padding = ' '.repeat(spaces)
  return value
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => `${padding}${line}`)
    .join('\n')
}
