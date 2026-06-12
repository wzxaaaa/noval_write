import { resolve } from 'path'

const approvedPaths = new Set<string>()

export function approvePath(path: string): void {
  approvedPaths.add(resolve(path))
}

export function approvePaths(paths: string[]): void {
  paths.forEach(approvePath)
}

export function isApprovedPath(path: string): boolean {
  return approvedPaths.has(resolve(path))
}
