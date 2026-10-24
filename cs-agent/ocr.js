/**
 * `ocr_image`: 把一张图片里的文字读出来，供纯文本模型使用。
 *
 * 后端可切换，插件本身不绑定平台：
 *   vision     macOS 自带 Vision（无需安装，最快）
 *   tesseract  跨平台 CLI（macOS/Linux/Windows 都能装）
 *
 * 选不到后端时插件照常加载，只在真正调用时给出安装指引。
 *
 * @module @local/dsh-cs-agent/ocr
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { defaultPaths } from './paths.js'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Cordis function-plugin name. */
export const name = 'cs-agent-ocr'

/** Host services required to register the tool. */
export const inject = ['tools']

/** 识别超时：截图通常 1 秒内完成。 */
const OCR_TIMEOUT_MS = 30_000

/** 注册 `ocr_image`。 */
export function apply(ctx, config) {
  const paths = defaultPaths()
  const imageRoot = requireAbsolute(config?.imageRoot ?? path.join(paths.data, 'images'), 'imageRoot')
  const backend = resolveBackend(config)

  if (backend === undefined) {
    ctx.logger?.warn?.('cs-agent-ocr: no OCR backend found; ocr_image will fail until one is installed')
  } else {
    ctx.logger?.info?.(`cs-agent-ocr: using ${backend.kind} backend`)
  }

  ctx.tools.register({
    name: 'ocr_image',
    description:
      'Read the text inside a screenshot the customer sent. Use it when the conversation mentions an image path '
      + 'and you need the exact error text or UI wording. Returns plain text; it does not describe the picture.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute image path from the conversation, e.g. /Users/.../images/abc.png.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          backend: { type: 'string' },
          confident: { type: 'boolean' },
        },
        required: ['text', 'backend'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text.trim() === ''
          ? `ocr_image (${value.backend}): no text recognized in this image.`
          : value.text,
      }],
    },
    async execute(args) {
      const requested = requireText(args?.path, 'path')
      const resolved = path.resolve(requested)
      // 只允许读网关落盘目录下的图片，防止被诱导读任意文件。
      if (resolved !== imageRoot && !resolved.startsWith(`${imageRoot}${path.sep}`)) {
        throw new Error(`ocr_image: path must be inside ${imageRoot}`)
      }
      if (!existsSync(resolved)) throw new Error(`ocr_image: file not found: ${resolved}`)
      if (backend === undefined) {
        throw new Error(
          'ocr_image: no OCR backend available. Install one of:\n'
          + '  macOS:  the bundled Vision binary (config visionBinary) or `brew install tesseract`\n'
          + '  Linux:  apt install tesseract-ocr tesseract-ocr-chi-sim\n'
          + '  Windows: install Tesseract and set config.tesseractBinary',
        )
      }
      return backend.kind === 'vision' ? await viaVision(backend, resolved) : await viaTesseract(backend, resolved)
    },
  })
}

/** 选择后端：显式配置优先，否则 darwin 用 Vision，其余用 tesseract。 */
function resolveBackend(config) {
  const choice = config?.backend ?? 'auto'
  if (choice === 'vision') {
    return { kind: 'vision', binary: requireAbsolute(config.visionBinary, 'visionBinary') }
  }
  if (choice === 'tesseract') {
    return {
      kind: 'tesseract',
      binary: typeof config?.tesseractBinary === 'string' && config.tesseractBinary !== ''
        ? config.tesseractBinary
        : 'tesseract',
      languages: typeof config?.languages === 'string' && config.languages !== '' ? config.languages : 'chi_sim+eng',
    }
  }
  if (process.platform === 'darwin' && typeof config?.visionBinary === 'string' && existsSync(config.visionBinary)) {
    return { kind: 'vision', binary: config.visionBinary }
  }
  if (config?.tesseractBinary !== undefined) {
    return { kind: 'tesseract', binary: config.tesseractBinary, languages: config?.languages ?? 'chi_sim+eng' }
  }
  return undefined
}

/** macOS Vision：输出 JSON。 */
async function viaVision(backend, file) {
  const { stdout } = await run(backend.binary, [file], { timeout: OCR_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error('ocr_image: vision backend returned malformed output')
  }
  const text = typeof payload.text === 'string' ? payload.text : ''
  return {
    text,
    backend: 'vision',
    confident: typeof payload.confidence === 'number' ? payload.confidence >= 0.5 : undefined,
  }
}

/** Tesseract：纯文本输出。 */
async function viaTesseract(backend, file) {
  const { stdout } = await run(
    backend.binary,
    [file, 'stdout', '-l', backend.languages],
    { timeout: OCR_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  )
  return { text: stdout.trim(), backend: 'tesseract' }
}

/** 必填非空字符串。 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`cs-agent-ocr: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/** 必填绝对路径。 */
function requireAbsolute(value, field) {
  const text = requireText(value, field)
  if (!path.isAbsolute(text)) throw new Error(`cs-agent-ocr: config.${field} must be absolute`)
  return text
}
