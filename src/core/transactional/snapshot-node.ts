import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'

export type SnapshotNode =
  | { kind: 'absent' }
  | { kind: 'file'; mode: number; size: number; hash: string }
  | { kind: 'symlink'; target: string; hash: string }
  | { kind: 'directory'; mode: number; hash: string }

export type PresentSnapshotNode = Exclude<SnapshotNode, { kind: 'absent' }>

export async function hashFileContent(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export function hashSymlinkTarget(target: string): string {
  return createHash('sha256').update(`symlink:${target}`).digest('hex')
}

export function hashDirectoryNode(mode: number): string {
  return createHash('sha256')
    .update(`directory:${mode & 0o777}`)
    .digest('hex')
}

export function hashFileNode(mode: number, contentHash: string): string {
  return createHash('sha256')
    .update(`file:${mode & 0o777}:${contentHash}`)
    .digest('hex')
}

export function snapshotNodesEqual(left: SnapshotNode, right: SnapshotNode): boolean {
  if (left.kind === 'absent' || right.kind === 'absent') {
    return left.kind === right.kind
  }
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case 'file':
      return (
        right.kind === 'file' &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.hash === right.hash
      )
    case 'symlink':
      return right.kind === 'symlink' && left.target === right.target && left.hash === right.hash
    case 'directory':
      return right.kind === 'directory' && left.mode === right.mode && left.hash === right.hash
    default:
      return false
  }
}

export async function readSnapshotNode(absolutePath: string): Promise<SnapshotNode> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' }
    }
    throw error
  }

  if (info.isSymbolicLink()) {
    const target = await readlink(absolutePath)
    return {
      kind: 'symlink',
      target,
      hash: hashSymlinkTarget(target),
    }
  }
  if (info.isFile()) {
    const contentHash = await hashFileContent(absolutePath)
    return {
      kind: 'file',
      mode: info.mode,
      size: info.size,
      hash: hashFileNode(info.mode, contentHash),
    }
  }
  if (info.isDirectory()) {
    return {
      kind: 'directory',
      mode: info.mode,
      hash: hashDirectoryNode(info.mode),
    }
  }
  throw new Error('file_checkpoint_unsupported_node')
}

export function presentNodeKind(node: PresentSnapshotNode): 'file' | 'symlink' | 'directory' {
  return node.kind
}
