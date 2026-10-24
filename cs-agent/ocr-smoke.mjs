// OCR tool smoke test: path guard, vision backend, tesseract backend.
// Run with: node cs-agent/ocr-smoke.mjs
import { promises as fs } from 'node:fs'
import { writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './ocr.js'

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** Mount the tool with one config and return its execute function. */
function mount(config) {
  const tools = new Map()
  apply({ logger: { warn: () => {}, info: () => {} }, tools: { register: (d) => { tools.set(d.name, d); return () => {} } } }, config)
  return tools.get('ocr_image').execute
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-'))
const imageRoot = path.join(temp, 'images')
await fs.mkdir(imageRoot, { recursive: true })

// 1) 跨出目录的路径必须拒绝
{
  const execute = mount({ imageRoot, backend: 'vision', visionBinary: '/nonexistent' })
  let error
  try {
    await execute({ path: '/etc/passwd' })
  } catch (caught) {
    error = caught
  }
  check(error !== undefined && /inside/.test(error.message), 'rejects paths outside the image root')
}

// 2) macOS Vision 后端（需要已编译的二进制）
{
  const sample = path.join(imageRoot, 'sample.png')
  await fs.copyFile('../.build/sample.png', sample)
  const execute = mount({
    imageRoot,
    backend: 'vision',
    visionBinary: path.resolve('../tools/bin/ocr'),
  })
  const result = await execute({ path: sample })
  check(result.backend === 'vision' && result.text.includes('-122'), 'vision backend reads the screenshot', result.text.replace(/\n/g, ' ').slice(0, 60))
}

// 3) tesseract 后端：用一个假命令验证参数与输出解析
{
  const fake = path.join(temp, 'fake-tesseract.sh')
  writeFileSync(fake, '#!/bin/sh\necho "错误码 -122 disk quota exceed"\n')
  chmodSync(fake, 0o755)
  const sample = path.join(imageRoot, 'sample.png')
  const execute = mount({ imageRoot, backend: 'tesseract', tesseractBinary: fake })
  const result = await execute({ path: sample })
  check(result.backend === 'tesseract' && result.text.includes('-122'), 'tesseract backend parses plain text')
}

// 4) 没有可用后端时给出安装指引
{
  const execute = mount({ imageRoot, backend: 'tesseract', tesseractBinary: '/nonexistent/tesseract' })
  let error
  try {
    await execute({ path: path.join(imageRoot, 'sample.png') })
  } catch (caught) {
    error = caught
  }
  check(error !== undefined, 'missing backend surfaces an error', error?.message?.slice(0, 60))
}

await fs.rm(temp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
