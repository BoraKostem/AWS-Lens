import { promises as fs } from 'node:fs'
import path from 'node:path'

function extractReferencedFiles(contents) {
  const matches = [...contents.matchAll(/^\s*(?:path|url):\s*["']?(.+?)["']?\s*$/gmu)]

  return matches
    .map((match) => match[1]?.trim())
    .filter(Boolean)
}

async function main() {
  const targetDir = process.argv[2]

  if (!targetDir) {
    throw new Error('Usage: node scripts/validate-updater-metadata.mjs <release-dir>')
  }

  const releaseDir = path.resolve(targetDir)
  const entries = await fs.readdir(releaseDir)
  const metadataFiles = entries.filter((entry) => /^latest.*\.ya?ml$/iu.test(entry))

  if (metadataFiles.length === 0) {
    throw new Error(`No updater metadata files found in ${releaseDir}`)
  }

  for (const metadataFile of metadataFiles) {
    const metadataPath = path.join(releaseDir, metadataFile)
    const contents = await fs.readFile(metadataPath, 'utf8')
    const referencedFiles = extractReferencedFiles(contents)

    if (referencedFiles.length === 0) {
      throw new Error(`${metadataFile} does not reference any downloadable files`)
    }

    for (const referencedFile of referencedFiles) {
      const resolvedPath = path.join(releaseDir, referencedFile)

      try {
        const stats = await fs.stat(resolvedPath)
        if (!stats.isFile()) {
          throw new Error(`${metadataFile} references ${referencedFile}, but it is not a file`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${metadataFile} references missing file ${referencedFile}: ${message}`)
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
