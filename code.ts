type ExportFile = {
  name: string
  html: string
}

type UIMessage =
  | { type: 'refresh-selection' }
  | { type: 'export-frames'; frameIds: string[] }
  | { type: 'cancel' }

type Matrix = [[number, number, number], [number, number, number]]

const SVG_EXPORT_SETTINGS: ExportSettingsSVGString = {
  format: 'SVG_STRING',
}

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
    await exportFrames(msg.frameIds)
  }
}

postSelection()

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

async function exportFrames(frameIds: string[]) {
  try {
    const frames = await resolveFrames(frameIds)
    const files: ExportFile[] = []
    const usedNames = new Set<string>()

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
        html: await renderFrameDocument(frame),
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

async function renderFrameDocument(frame: FrameNode) {
  await loadFonts(frame)

  const children = await Promise.all(
    frame.children
      .filter((child) => child.visible)
      .map((child) => safeRenderSceneNode(child, frame.absoluteTransform)),
  )
  const frameBackground = await paintStyles(frame.fills)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(frame.name)}</title>
  <style>
    * { box-sizing: border-box; }
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

async function renderSceneNode(node: SceneNode, parentMatrix: Matrix): Promise<string> {
  if (!isMeasurable(node)) {
    return ''
  }

  if (node.type === 'TEXT') {
    return renderTextNode(node, parentMatrix)
  }

  if (isVectorLike(node)) {
    return renderSvgNode(node, parentMatrix)
  }

  if (isContainerNode(node)) {
    const children = await Promise.all(
      node.children
        .filter((child) => child.visible)
        .map((child) => safeRenderSceneNode(child, node.absoluteTransform)),
    )

    return `<div class="figma-node" data-name="${escapeAttribute(node.name)}" style="${await visualStyle(node, parentMatrix)}">${children.join('\n')}</div>`
  }

  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
    return `<div class="figma-node" data-name="${escapeAttribute(node.name)}" style="${await visualStyle(node, parentMatrix)}"></div>`
  }

  return renderSvgNode(node, parentMatrix)
}

async function renderTextNode(node: TextNode, parentMatrix: Matrix) {
  const style = textContainerStyle(node, parentMatrix)
  const contentStyle = [
    textStyle(node),
    await paintStyles(node.fills, 'color'),
  ].join(' ')
  const text = await renderTextContent(node)

  return `<div class="figma-node figma-text" data-name="${escapeAttribute(node.name)}" style="${style}"><div style="${contentStyle}">${text}</div></div>`
}

async function safeRenderSceneNode(node: SceneNode, parentMatrix: Matrix) {
  try {
    return await renderSceneNode(node, parentMatrix)
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

async function visualStyle(node: SceneNode, parentMatrix: Matrix) {
  return [
    baseStyle(node, parentMatrix),
    await nodePaintStyle(node),
    strokeStyle(node),
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

async function nodePaintStyle(node: SceneNode) {
  if ('fills' in node) {
    return paintStyles(node.fills)
  }

  return 'background: transparent;'
}

async function paintStyles(
  paints: ReadonlyArray<Paint> | PluginAPI['mixed'],
  property: 'background' | 'color' = 'background',
) {
  if (typeof paints === 'symbol') {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  const visiblePaints = paints.filter((paint) => paint.visible !== false)
  if (visiblePaints.length === 0) {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  const layers = await Promise.all(visiblePaints.map((paint) => paintToCss(paint, property)))
  const values = layers.filter(Boolean)

  if (values.length === 0) {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  if (property === 'color') {
    return `color: ${values[0]};`
  }

  return `background: ${values.reverse().join(', ')}; ${backgroundSizing(visiblePaints)}`
}

async function paintToCss(paint: Paint, property: 'background' | 'color') {
  if (paint.type === 'SOLID') {
    return rgba(paint.color, paint.opacity ?? 1)
  }

  if (property === 'color') {
    return ''
  }

  if (paint.type === 'IMAGE' && paint.imageHash) {
    const image = figma.getImageByHash(paint.imageHash)
    if (!image) {
      return ''
    }

    const bytes = await image.getBytesAsync().catch(() => null)
    if (!bytes) {
      return ''
    }

    return `url("${bytesToDataUrl(bytes, imageMimeType(bytes))}")`
  }

  if (paint.type === 'GRADIENT_LINEAR') {
    return linearGradient(paint)
  }

  if (paint.type === 'GRADIENT_RADIAL') {
    return radialGradient(paint)
  }

  return ''
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

function strokeStyle(node: SceneNode) {
  if (!('strokes' in node) || typeof node.strokes === 'symbol') {
    return ''
  }

  const stroke = node.strokes.find((paint) => paint.visible !== false && paint.type === 'SOLID')
  if (!stroke || stroke.type !== 'SOLID') {
    return ''
  }

  const weight = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : 1
  return `border: ${formatNumber(weight)}px solid ${rgba(stroke.color, stroke.opacity ?? 1)};`
}

function cornerRadius(node: SceneNode) {
  if (node.type === 'ELLIPSE') {
    return 'border-radius: 50%;'
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

function textStyle(node: TextNode) {
  const fontName = node.fontName
  const fontFamily = typeof fontName === 'symbol' ? 'Inter' : fontName.family
  const fontStyle = typeof fontName === 'symbol' ? 'Regular' : fontName.style
  const fontSize = typeof node.fontSize === 'symbol' ? 16 : node.fontSize
  const fontWeightValue = typeof node.fontWeight === 'symbol' ? fontWeight(fontStyle) : node.fontWeight
  const lineHeight = typeof node.lineHeight === 'symbol' ? 'normal' : lineHeightValue(node.lineHeight, fontSize)
  const letterSpacing = typeof node.letterSpacing === 'symbol' ? 'normal' : letterSpacingValue(node.letterSpacing, fontSize)
  const decoration = typeof node.textDecoration === 'symbol' ? 'none' : textDecoration(node.textDecoration)

  return [
    `font-family: ${cssString(fontFamily)}, Arial, sans-serif;`,
    `font-size: ${formatNumber(fontSize)}px;`,
    `font-weight: ${fontWeightValue};`,
    `font-style: ${fontStyle.toLowerCase().includes('italic') ? 'italic' : 'normal'};`,
    `line-height: ${lineHeight};`,
    `letter-spacing: ${letterSpacing};`,
    `text-align: ${node.textAlignHorizontal.toLowerCase()};`,
    `text-decoration: ${decoration};`,
    `margin: 0;`,
    `padding: 0;`,
  ].join(' ')
}

async function renderTextContent(node: TextNode) {
  const segments = node.getStyledTextSegments([
    'fontName',
    'fontSize',
    'fontWeight',
    'fills',
    'letterSpacing',
    'lineHeight',
    'textCase',
    'textDecoration',
  ])

  if (segments.length <= 1) {
    return escapeHtml(applyTextCase(node.characters, node.textCase))
  }

  const renderedSegments = await Promise.all(
    segments.map(async (segment) => {
      const style = [
        segmentTextStyle(segment),
        await paintStyles(segment.fills, 'color'),
      ].join(' ')

      return `<span style="${style}">${escapeHtml(applyTextCase(segment.characters, segment.textCase))}</span>`
    }),
  )

  return renderedSegments.join('')
}

function segmentTextStyle(
  segment: Pick<
    StyledTextSegment,
    'fontName' | 'fontSize' | 'fontWeight' | 'letterSpacing' | 'lineHeight' | 'textDecoration'
  >,
) {
  const fontName = segment.fontName
  const fontFamily = typeof fontName === 'symbol' ? 'Inter' : fontName.family
  const fontStyle = typeof fontName === 'symbol' ? 'Regular' : fontName.style
  const fontSize = typeof segment.fontSize === 'symbol' ? 16 : segment.fontSize
  const lineHeight = typeof segment.lineHeight === 'symbol' ? 'normal' : lineHeightValue(segment.lineHeight, fontSize)
  const letterSpacing =
    typeof segment.letterSpacing === 'symbol' ? 'normal' : letterSpacingValue(segment.letterSpacing, fontSize)
  const fontWeightValue =
    typeof segment.fontWeight === 'symbol' ? fontWeight(fontStyle) : segment.fontWeight
  const decoration = typeof segment.textDecoration === 'symbol' ? 'none' : textDecoration(segment.textDecoration)

  return [
    `font-family: ${cssString(fontFamily)}, Arial, sans-serif;`,
    `font-size: ${formatNumber(fontSize)}px;`,
    `font-weight: ${fontWeightValue};`,
    `font-style: ${fontStyle.toLowerCase().includes('italic') ? 'italic' : 'normal'};`,
    `line-height: ${lineHeight};`,
    `letter-spacing: ${letterSpacing};`,
    `text-decoration: ${decoration};`,
  ].join(' ')
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
    .replace(/\s(width|height)="[^"]*"/gi, '')
    .replace(/<svg\b(?![^>]*\bpreserveAspectRatio=)/i, '<svg preserveAspectRatio="xMidYMid meet"')
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

function applyTextCase(value: string, textCase: TextCase | PluginAPI['mixed']) {
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
