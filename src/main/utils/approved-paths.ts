import type { IpcMainInvokeEvent } from 'electron'
import { realpathSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

export type ApprovedPathPurpose = 'project-root' | 'knowledge-document' | 'background-image' | 'skill-package'

interface PathApproval {
  canonicalPath: string
  expiresAt: number
}

const APPROVAL_TTL_MS = 10 * 60 * 1000
const approvedPaths = new Map<string, PathApproval>()

function canonicalizeExistingPath(path: string): string | null {
  if (typeof path !== 'string' || !path.trim()) return null
  try {
    return realpathSync.native(resolve(path))
  } catch {
    return null
  }
}

function comparisonKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function approvalKey(path: string, purpose: ApprovedPathPurpose): string {
  return `${purpose}\0${comparisonKey(path)}`
}

function pruneExpiredApprovals(now: number = Date.now()): void {
  for (const [key, approval] of approvedPaths) {
    if (approval.expiresAt <= now) approvedPaths.delete(key)
  }
}

/**
 * Records a short-lived, purpose-scoped approval for a path returned by a
 * native file picker. Only paths that currently exist can be approved.
 */
export function approvePath(path: string, purpose: ApprovedPathPurpose): void {
  const canonicalPath = canonicalizeExistingPath(path)
  if (!canonicalPath) return
  pruneExpiredApprovals()
  approvedPaths.set(approvalKey(canonicalPath, purpose), {
    canonicalPath,
    expiresAt: Date.now() + APPROVAL_TTL_MS
  })
}

export function approvePaths(paths: string[], purpose: ApprovedPathPurpose): void {
  paths.forEach(path => approvePath(path, purpose))
}

/**
 * Consumes an approval exactly once and returns the canonical path that was
 * approved. This prevents a renderer from reusing an old picker result for a
 * different operation or from replacing it with a symlink alias.
 */
export function consumeApprovedPath(path: string, purpose: ApprovedPathPurpose): string | null {
  const canonicalPath = canonicalizeExistingPath(path)
  if (!canonicalPath) return null

  pruneExpiredApprovals()
  const key = approvalKey(canonicalPath, purpose)
  const approval = approvedPaths.get(key)
  if (!approval) return null

  approvedPaths.delete(key)
  return approval.canonicalPath
}

export function isApprovedPath(path: string, purpose: ApprovedPathPurpose): boolean {
  const canonicalPath = canonicalizeExistingPath(path)
  if (!canonicalPath) return false
  pruneExpiredApprovals()
  return approvedPaths.has(approvalKey(canonicalPath, purpose))
}

export function isTrustedRendererUrl(
  candidateUrl: string,
  configuredRendererUrl: string | undefined = process.env.ELECTRON_RENDERER_URL,
  packagedRendererUrl: string = pathToFileURL(join(__dirname, '../renderer/index.html')).href
): boolean {
  try {
    const candidate = new URL(candidateUrl)

    if (configuredRendererUrl) {
      const configured = new URL(configuredRendererUrl)
      return (configured.protocol === 'http:' || configured.protocol === 'https:') &&
        candidate.origin === configured.origin
    }

    if (candidate.protocol !== 'file:') return false
    const packaged = new URL(packagedRendererUrl)
    if (packaged.protocol !== 'file:') return false
    return comparisonKey(fileURLToPath(candidate)) === comparisonKey(fileURLToPath(packaged))
  } catch {
    return false
  }
}

/** Rejects privileged IPC calls that did not originate from the app renderer. */
export function assertTrustedIpcSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL()
  if (!isTrustedRendererUrl(senderUrl)) {
    throw new Error('IPC request rejected: untrusted renderer origin')
  }
}
