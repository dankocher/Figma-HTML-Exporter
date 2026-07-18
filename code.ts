type ExportFile = {
  name: string
  html: string
}

type UIMessage =
  | { type: 'refresh-selection' }
  | { type: 'export-frames'; frameIds: string[] }
  | { type: 'cancel' }

type Matrix = [[number, number, number], [number, number, number]]

const FALLBACK_EXPORT_SETTINGS: ExportSettingsImage = {
  format: 'PNG',
  constraint: { type: 'SCALE', value: 1 },
}

figma.showUI(__html__, { width: 420, height: 560, themeColors: true })

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

      const html = await renderFrameDocument(frame)
      files.push({
        name: uniqueFileName(frame.name, usedNames),
        html,
      })
    }

    figma.ui.postMessage({ type: 'export-result', files })
  } catch (error) {
    figma.ui.postMessage({
      type: 'export-error',
      message: error instanceof Error ? error.message : 'Unexpected export error.',
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

  const rootMatrix = frame.absoluteTransform
  const body = await Promise.all(
    frame.children
      .filter((child) => child.visible)
      .map((child) => renderSceneNode(child, rootMatrix)),
  )

  const background = await paintStyles(frame.fills)
  const frameRadius = cornerRadius(frame)

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
      ${background}
      ${frameRadius}
    }
    .node {
      position: absolute;
      transform-origin: 0 0;
      white-space: pre-wrap;
      overflow-wrap: break-word;
    }
    img.node { display: block; object-fit: fill; }
  </style>
</head>
<body>
  <main class="figma-frame" aria-label="${escapeAttribute(frame.name)}">
${indent(body.join('\n'), 4)}
  </main>
</body>
</html>
`
}

async function renderSceneNode(node: SceneNode, rootMatrix: Matrix): Promise<string> {
  if (!isRenderableNode(node)) {
    return ''
  }

  if (node.type === 'TEXT') {
    return renderTextNode(node, rootMatrix)
  }

  if (isContainerNode(node)) {
    const children = await Promise.all(
      node.children
        .filter((child) => child.visible)
        .map((child) => renderSceneNode(child, node.absoluteTransform)),
    )

    return `<div class="node" data-name="${escapeAttribute(node.name)}" style="${await baseStyle(node, rootMatrix)} ${await paintStyles(node.fills)} ${strokeStyles(node)} ${cornerRadius(node)} overflow: hidden;">${children.join('\n')}</div>`
  }

  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
    return `<div class="node" data-name="${escapeAttribute(node.name)}" style="${await baseStyle(node, rootMatrix)} ${await paintStyles(node.fills)} ${strokeStyles(node)} ${cornerRadius(node)}"></div>`
  }

  return renderFallbackImage(node, rootMatrix)
}

async function renderTextNode(node: TextNode, rootMatrix: Matrix) {
  const style = [
    await baseStyle(node, rootMatrix),
    textStyles(node),
    await paintStyles(node.fills, 'color'),
  ].join(' ')

  return `<div class="node" data-name="${escapeAttribute(node.name)}" style="${style}">${escapeHtml(node.characters)}</div>`
}

async function renderFallbackImage(node: SceneNode, rootMatrix: Matrix) {
  const image = await node.exportAsync(FALLBACK_EXPORT_SETTINGS)
  const dataUrl = bytesToDataUrl(image, 'image/png')

  return `<img class="node" data-name="${escapeAttribute(node.name)}" alt="${escapeAttribute(node.name)}" src="${dataUrl}" style="${await baseStyle(node, rootMatrix)}">`
}

async function baseStyle(node: SceneNode, rootMatrix: Matrix) {
  const matrix = relativeMatrix(rootMatrix, node.absoluteTransform)
  const opacity = 'opacity' in node && typeof node.opacity === 'number' ? ` opacity: ${formatNumber(node.opacity)};` : ''

  return `width: ${formatNumber(node.width)}px; height: ${formatNumber(node.height)}px; transform: matrix(${formatNumber(matrix[0][0])}, ${formatNumber(matrix[1][0])}, ${formatNumber(matrix[0][1])}, ${formatNumber(matrix[1][1])}, ${formatNumber(matrix[0][2])}, ${formatNumber(matrix[1][2])});${opacity}`
}

function textStyles(node: TextNode) {
  const fontName = node.fontName
  const fontFamily = typeof fontName === 'symbol' ? 'Inter' : fontName.family
  const fontStyle = typeof fontName === 'symbol' ? 'Regular' : fontName.style
  const fontSize = typeof node.fontSize === 'symbol' ? 16 : node.fontSize
  const lineHeight = typeof node.lineHeight === 'symbol' ? 'normal' : lineHeightValue(node.lineHeight, fontSize)
  const letterSpacing = typeof node.letterSpacing === 'symbol' ? 'normal' : letterSpacingValue(node.letterSpacing, fontSize)
  const textAlignHorizontal = node.textAlignHorizontal.toLowerCase()
  const textAlignVertical = verticalAlign(node.textAlignVertical)

  return [
    `font-family: ${cssString(fontFamily)}, Arial, sans-serif;`,
    `font-size: ${formatNumber(fontSize)}px;`,
    `font-weight: ${fontWeight(fontStyle)};`,
    `font-style: ${fontStyle.toLowerCase().includes('italic') ? 'italic' : 'normal'};`,
    `line-height: ${lineHeight};`,
    `letter-spacing: ${letterSpacing};`,
    `text-align: ${textAlignHorizontal};`,
    `display: flex;`,
    `align-items: ${textAlignVertical};`,
  ].join(' ')
}

async function paintStyles(
  paints: ReadonlyArray<Paint> | PluginAPI['mixed'],
  property: 'background' | 'color' = 'background',
) {
  if (typeof paints === 'symbol') {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  const paint = paints.find((item) => item.visible !== false)

  if (!paint) {
    return property === 'color' ? 'color: #111827;' : 'background: transparent;'
  }

  if (paint.type === 'SOLID') {
    const value = rgba(paint.color, paint.opacity ?? 1)
    return property === 'color' ? `color: ${value};` : `background: ${value};`
  }

  if (property === 'background' && paint.type === 'IMAGE' && paint.imageHash) {
    const image = figma.getImageByHash(paint.imageHash)
    if (image) {
      const bytes = await image.getBytesAsync()
      return `background-image: url("${bytesToDataUrl(bytes, imageMimeType(bytes))}"); background-size: cover; background-position: center;`
    }
  }

  return property === 'color' ? 'color: #111827;' : 'background: transparent;'
}

function strokeStyles(node: SceneNode) {
  if (!('strokes' in node) || typeof node.strokes === 'symbol') {
    return ''
  }

  const stroke = node.strokes.find((item) => item.visible !== false && item.type === 'SOLID')
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

async function loadFonts(node: SceneNode) {
  if (node.type === 'TEXT') {
    const fontNames = new Map<string, FontName>()

    for (let index = 0; index < node.characters.length; index += 1) {
      const fontName = node.getRangeFontName(index, index + 1)
      if (typeof fontName !== 'symbol') {
        fontNames.set(`${fontName.family}-${fontName.style}`, fontName)
      }
    }

    await Promise.all(Array.from(fontNames.values()).map((fontName) => figma.loadFontAsync(fontName)))
    return
  }

  if (isContainerNode(node)) {
    await Promise.all(node.children.map((child) => loadFonts(child)))
  }
}

function isFrameNode(node: BaseNode): node is FrameNode {
  return node.type === 'FRAME'
}

function isContainerNode(node: SceneNode): node is SceneNode & ChildrenMixin & MinimalFillsMixin {
  return 'children' in node && 'fills' in node
}

function isRenderableNode(node: SceneNode) {
  return 'width' in node && 'height' in node && 'absoluteTransform' in node
}

function relativeMatrix(root: Matrix, node: Matrix): Matrix {
  const inverse = invertMatrix(root)
  return multiplyMatrix(inverse, node)
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

  return 'application/octet-stream'
}

function rgba(color: RGB, alpha: number) {
  const red = Math.round(color.r * 255)
  const green = Math.round(color.g * 255)
  const blue = Math.round(color.b * 255)

  return `rgba(${red}, ${green}, ${blue}, ${formatNumber(alpha)})`
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

function fontWeight(style: string) {
  const normalized = style.toLowerCase()

  if (normalized.includes('thin')) return 100
  if (normalized.includes('extra light') || normalized.includes('extralight')) return 200
  if (normalized.includes('light')) return 300
  if (normalized.includes('medium')) return 500
  if (normalized.includes('semi bold') || normalized.includes('semibold')) return 600
  if (normalized.includes('bold')) return 700
  if (normalized.includes('extra bold') || normalized.includes('extrabold')) return 800
  if (normalized.includes('black')) return 900

  return 400
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
