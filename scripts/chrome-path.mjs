import { existsSync } from 'node:fs'

export const DEFAULT_CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/local/bin/google-chrome',
]

/**
 * 解析系统 Chrome/Chromium。playwright-core 不下载浏览器，因此显式检查路径，
 * 给本地、Cursor 镜像和 GitHub runner 一致且可诊断的行为。
 */
export function resolveChromePath(options = {}) {
  const exists = options.exists ?? existsSync
  const envPath = options.envPath ?? process.env.CHROME_PATH
  const candidates = options.candidates ?? DEFAULT_CHROME_PATHS

  if (envPath) {
    if (exists(envPath)) return envPath
    throw new Error(`CHROME_PATH does not exist: ${envPath}`)
  }
  const detected = candidates.find((path) => exists(path))
  if (detected) return detected
  throw new Error(
    `Chrome/Chromium was not found. Set CHROME_PATH or install one of: ${candidates.join(', ')}`,
  )
}
