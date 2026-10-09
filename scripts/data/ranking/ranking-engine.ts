import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

export async function archiveLatest(runtimeDir: string, runId: string): Promise<void> {
  try {
    const archive = resolve(runtimeDir, 'archive', `${runId}.json`)
    await mkdir(dirname(archive), { recursive: true })
    await copyFile(resolve(runtimeDir, 'latest.json'), archive)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
