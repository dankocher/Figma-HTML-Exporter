type ExportFile = {
  name: string
  html: string
}

type UIMessage =
  | { type: 'refresh-selection' }
  | { type: 'export-frames'; frameIds: string[] }
  | { type: 'cancel' }

const FRAME_EXPORT_SETTINGS: ExportSettingsImage = {
  format: 'PNG',
  constraint: { type: 'SCALE', value: 1 },
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
  const imageBytes = await frame.exportAsync(FRAME_EXPORT_SETTINGS)
  const imageUrl = bytesToDataUrl(imageBytes, 'image/png')
  const width = formatNumber(frame.width)
  const height = formatNumber(frame.height)

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
    }
    .figma-frame {
      display: block;
      width: ${width}px;
      height: ${height}px;
      max-width: 100vw;
      max-height: 100vh;
      object-fit: contain;
    }
  </style>
</head>
<body>
  <img class="figma-frame" src="${imageUrl}" width="${width}" height="${height}" alt="${escapeAttribute(frame.name)}">
</body>
</html>
`
}

function isFrameNode(node: BaseNode): node is FrameNode {
  return node.type === 'FRAME'
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${figma.base64Encode(bytes)}`
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
