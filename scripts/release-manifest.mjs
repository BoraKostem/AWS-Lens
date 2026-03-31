import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

async function collectFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath))
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    files.push(fullPath)
  }

  return files
}

async function sha256ForFile(filePath) {
  const hash = createHash('sha256')
  const contents = await fs.readFile(filePath)
  hash.update(contents)
  return hash.digest('hex')
}

async function generateManifest(rootDir, metadata) {
  const absoluteRoot = path.resolve(rootDir)
  const manifestFileName = `release-manifest-${metadata.platform}.json`
  const checksumsFileName = `release-checksums-${metadata.platform}.txt`
  const filePaths = (await collectFiles(absoluteRoot))
    .filter((filePath) => !/^release-manifest-.*\.json$/u.test(path.basename(filePath)) && !/^release-checksums-.*\.txt$/u.test(path.basename(filePath)))
    .sort((left, right) => left.localeCompare(right))

  const files = []
  for (const filePath of filePaths) {
    const relativePath = path.relative(absoluteRoot, filePath).split(path.sep).join('/')
    const stats = await fs.stat(filePath)
    files.push({
      path: relativePath,
      size: stats.size,
      sha256: await sha256ForFile(filePath)
    })
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    ...metadata,
    fileCount: files.length,
    files
  }

  const manifestPath = path.join(absoluteRoot, manifestFileName)
  const checksumsPath = path.join(absoluteRoot, checksumsFileName)
  const checksums = files.map((file) => `${file.sha256}  ${file.path}`).join('\n')

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fs.writeFile(checksumsPath, checksums ? `${checksums}\n` : '', 'utf8')
}

async function verifyManifestDirectory(rootDir) {
  const absoluteRoot = path.resolve(rootDir)
  const manifestCandidates = (await fs.readdir(absoluteRoot))
    .filter((entry) => /^release-manifest-.*\.json$/u.test(entry))

  if (manifestCandidates.length !== 1) {
    throw new Error(`Expected exactly one release manifest in ${absoluteRoot}, found ${manifestCandidates.length}`)
  }

  const manifestPath = path.join(absoluteRoot, manifestCandidates[0])
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

  for (const file of manifest.files) {
    const filePath = path.join(absoluteRoot, file.path)
    const stats = await fs.stat(filePath)
    if (stats.size !== file.size) {
      throw new Error(`Size mismatch for ${file.path}: expected ${file.size}, got ${stats.size}`)
    }

    const digest = await sha256ForFile(filePath)
    if (digest !== file.sha256) {
      throw new Error(`SHA256 mismatch for ${file.path}`)
    }
  }
}

async function verifyTree(rootDir) {
  const absoluteRoot = path.resolve(rootDir)
  const allFiles = await collectFiles(absoluteRoot)
  const manifestFiles = allFiles.filter((filePath) => /^release-manifest-.*\.json$/u.test(path.basename(filePath)))

  if (manifestFiles.length === 0) {
    throw new Error(`No release manifest files found under ${absoluteRoot}`)
  }

  for (const manifestPath of manifestFiles) {
    await verifyManifestDirectory(path.dirname(manifestPath))
  }
}

async function main() {
  const [command, targetDir, channel, platform, version, commitSha] = process.argv.slice(2)

  if (command === 'generate') {
    if (!targetDir || !channel || !platform || !version || !commitSha) {
      throw new Error('Usage: node scripts/release-manifest.mjs generate <dir> <channel> <platform> <version> <commitSha>')
    }

    await generateManifest(targetDir, {
      channel,
      platform,
      version,
      commitSha
    })
    return
  }

  if (command === 'verify-tree') {
    if (!targetDir) {
      throw new Error('Usage: node scripts/release-manifest.mjs verify-tree <dir>')
    }

    await verifyTree(targetDir)
    return
  }

  throw new Error('Unsupported command. Use "generate" or "verify-tree".')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
