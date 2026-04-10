import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import './data-grid.css'

export type DataGridColumn<T> = {
  key: string
  label: string
  color?: string
  getValue: (row: T) => string | number
  render?: (row: T) => React.ReactNode
  sortable?: boolean
  filterable?: boolean
  width?: string
  align?: 'left' | 'right' | 'center'
}

export type DataGridProps<T> = {
  columns: DataGridColumn<T>[]
  rows: T[]
  getRowId: (row: T) => string
  selectedId?: string
  onSelect?: (row: T) => void
  emptyMessage?: string
  searchPlaceholder?: string
  maxHeight?: string
  className?: string
  stickyHeader?: boolean
  defaultSortKey?: string
  defaultSortDir?: 'asc' | 'desc'
}

export function DataGrid<T>({
  columns,
  rows,
  getRowId,
  selectedId,
  onSelect,
  emptyMessage = 'No data available.',
  searchPlaceholder = 'Search...',
  maxHeight = 'calc(100vh - 340px)',
  className,
  stickyHeader = true,
  defaultSortKey,
  defaultSortDir = 'asc'
}: DataGridProps<T>) {
  const [sortKey, setSortKey] = useState(defaultSortKey ?? '')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir)
  const [filter, setFilter] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  const gridTemplateColumns = columns.map((c) => c.width ?? '1fr').join(' ')

  const handleSort = useCallback(
    (col: DataGridColumn<T>) => {
      if (col.sortable === false) return
      if (sortKey === col.key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortKey(col.key)
        setSortDir('asc')
      }
    },
    [sortKey]
  )

  const filtered = useMemo(() => {
    if (!filter) return rows
    const q = filter.toLowerCase()
    return rows.filter((row) =>
      columns.some((col) => {
        if (col.filterable === false) return false
        return String(col.getValue(row)).toLowerCase().includes(q)
      })
    )
  }, [rows, filter, columns])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return filtered
    return [...filtered].sort((a, b) => {
      const va = col.getValue(a)
      const vb = col.getValue(b)
      let cmp: number
      if (typeof va === 'number' && typeof vb === 'number') {
        cmp = va - vb
      } else {
        cmp = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' })
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sortKey, sortDir, columns])

  // Keyboard navigation
  useEffect(() => {
    const container = bodyRef.current?.parentElement
    if (!container || !onSelect) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const idx = sorted.findIndex((r) => getRowId(r) === selectedId)
      let next = idx
      if (e.key === 'ArrowUp') next = Math.max(0, idx - 1)
      if (e.key === 'ArrowDown') next = Math.min(sorted.length - 1, idx + 1)
      if (next !== idx && sorted[next]) onSelect!(sorted[next])
    }

    container.setAttribute('tabindex', '0')
    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [sorted, selectedId, onSelect, getRowId])

  // Scroll selected row into view
  useEffect(() => {
    if (!selectedId || !bodyRef.current) return
    const el = bodyRef.current.querySelector(`[data-row-id="${selectedId}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  return (
    <div className={`data-grid${className ? ` ${className}` : ''}`}>
      <div className="data-grid-search">
        <input
          className="svc-search"
          placeholder={searchPlaceholder}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div
        className="data-grid-table"
        style={{ maxHeight, position: 'relative' }}
      >
        <div
          className="data-grid-header"
          style={{
            gridTemplateColumns,
            position: stickyHeader ? 'sticky' : undefined,
            top: stickyHeader ? 0 : undefined
          }}
        >
          {columns.map((col) => {
            const isSortable = col.sortable !== false
            const isActive = sortKey === col.key
            return (
              <div
                key={col.key}
                className={`data-grid-header-cell${isSortable ? ' sortable' : ''}${col.align ? ` align-${col.align}` : ''}`}
                style={col.color ? { borderBottomColor: col.color } : undefined}
                onClick={() => handleSort(col)}
              >
                {col.label}
                {isActive && (
                  <span className="data-grid-sort-arrow">
                    {sortDir === 'asc' ? '\u25B2' : '\u25BC'}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div className="data-grid-body" ref={bodyRef}>
          {sorted.length === 0 ? (
            <div className="data-grid-empty">{emptyMessage}</div>
          ) : (
            sorted.map((row) => {
              const id = getRowId(row)
              return (
                <div
                  key={id}
                  data-row-id={id}
                  className={`data-grid-row${id === selectedId ? ' selected' : ''}`}
                  style={{ gridTemplateColumns }}
                  onClick={() => onSelect?.(row)}
                >
                  {columns.map((col) => (
                    <div
                      key={col.key}
                      className={`data-grid-cell${col.align ? ` align-${col.align}` : ''}`}
                    >
                      {col.render ? col.render(row) : String(col.getValue(row))}
                    </div>
                  ))}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
