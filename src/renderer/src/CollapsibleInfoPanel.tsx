import type { ReactNode } from 'react'

export function CollapsibleInfoPanel({
  title,
  eyebrow,
  children,
  defaultOpen = false,
  className = ''
}: {
  title: string
  eyebrow?: string
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  return (
    <details className={`info-disclosure ${className}`.trim()} open={defaultOpen}>
      <summary className="info-disclosure__summary">
        <div className="info-disclosure__copy">
          {eyebrow ? <div className="eyebrow info-disclosure__eyebrow">{eyebrow}</div> : null}
          <h3>{title}</h3>
        </div>
        <span className="info-disclosure__chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="info-disclosure__body">
        {children}
      </div>
    </details>
  )
}
