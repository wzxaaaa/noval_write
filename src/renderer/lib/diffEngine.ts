export interface DiffLine {
  type: 'add' | 'remove' | 'same'
  lineNumOld?: number
  lineNumNew?: number
  text: string
}

export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  // Myers diff simplified — use LCS-based approach
  const lcs = longestCommonSubsequence(oldLines, newLines)
  const result: DiffLine[] = []

  let oldIdx = 0
  let newIdx = 0
  let lcsIdx = 0

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx < lcs.length && oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === lcs[lcsIdx] && newLines[newIdx] === lcs[lcsIdx]) {
      result.push({ type: 'same', lineNumOld: oldIdx + 1, lineNumNew: newIdx + 1, text: oldLines[oldIdx] })
      oldIdx++
      newIdx++
      lcsIdx++
    } else if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx]) {
      // New has extra line
      result.push({ type: 'add', lineNumNew: newIdx + 1, text: newLines[newIdx] })
      newIdx++
    } else if (lcsIdx < lcs.length && newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
      // Old has extra line
      result.push({ type: 'remove', lineNumOld: oldIdx + 1, text: oldLines[oldIdx] })
      oldIdx++
    } else if (oldIdx < oldLines.length && newIdx < newLines.length) {
      result.push({ type: 'remove', lineNumOld: oldIdx + 1, text: oldLines[oldIdx] })
      result.push({ type: 'add', lineNumNew: newIdx + 1, text: newLines[newIdx] })
      oldIdx++
      newIdx++
    } else if (oldIdx < oldLines.length) {
      result.push({ type: 'remove', lineNumOld: oldIdx + 1, text: oldLines[oldIdx] })
      oldIdx++
    } else if (newIdx < newLines.length) {
      result.push({ type: 'add', lineNumNew: newIdx + 1, text: newLines[newIdx] })
      newIdx++
    }
  }

  // Collapse context: keep 3 lines around changes
  return collapseContext(result, 3)
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const result: string[] = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1])
      i--
      j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  return result
}

function collapseContext(diff: DiffLine[], contextLines: number): DiffLine[] {
  const result: DiffLine[] = []
  let lastChangeIdx = -contextLines - 1

  for (let i = 0; i < diff.length; i++) {
    if (diff[i].type !== 'same') {
      // Include context lines before this change
      const start = Math.max(0, i - contextLines)
      for (let j = Math.max(lastChangeIdx + 1, start); j < i; j++) {
        if (j >= 0 && diff[j].type === 'same') {
          result.push(diff[j])
        }
      }
      result.push(diff[i])
      lastChangeIdx = i
    }
  }

  // Include trailing context
  for (let i = lastChangeIdx + 1; i < Math.min(diff.length, lastChangeIdx + contextLines + 1); i++) {
    if (diff[i].type === 'same') {
      result.push(diff[i])
    }
  }

  if (result.length === 0) {
    return diff.filter(d => d.type === 'add' || d.text.trim() !== '')
  }

  return result
}

export function diffSummary(diff: DiffLine[]): { additions: number; deletions: number } {
  return {
    additions: diff.filter(d => d.type === 'add').length,
    deletions: diff.filter(d => d.type === 'remove').length
  }
}
