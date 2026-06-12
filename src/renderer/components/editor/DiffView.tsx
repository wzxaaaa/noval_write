import React from 'react'
import type { DiffLine } from '../../lib/diffEngine'

interface DiffViewProps {
  diff: DiffLine[]
  onAccept: () => void
  onReject: () => void
}

export function DiffView({ diff, onAccept, onReject }: DiffViewProps) {
  if (!diff || diff.length === 0) {
    return (
      <div className="diff-view">
        <div className="diff-empty">没有检测到变更</div>
      </div>
    )
  }

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="diff-title">Agent 修改建议</span>
        <div className="diff-actions">
          <button className="diff-accept-btn" onClick={onAccept} title="接受修改">
            ✅ 接受
          </button>
          <button className="diff-reject-btn" onClick={onReject} title="拒绝修改">
            ❌ 拒绝
          </button>
        </div>
      </div>
      <div className="diff-content">
        {diff.map((line, i) => {
          let className = 'diff-line diff-line-same'
          let prefix = ' '
          if (line.type === 'add') {
            className = 'diff-line diff-line-add'
            prefix = '+'
          } else if (line.type === 'remove') {
            className = 'diff-line diff-line-remove'
            prefix = '-'
          }

          const lineNumOld = line.lineNumOld != null ? String(line.lineNumOld).padStart(4, ' ') : '    '
          const lineNumNew = line.lineNumNew != null ? String(line.lineNumNew).padStart(4, ' ') : '    '

          return (
            <div key={i} className={className}>
              <span className="diff-line-nums">
                <span className="diff-ln-old">{lineNumOld}</span>
                <span className="diff-ln-new">{lineNumNew}</span>
              </span>
              <span className="diff-line-prefix">{prefix}</span>
              <span className="diff-line-text">{line.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
