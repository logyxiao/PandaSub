import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Pager } from './ui'

export type TableAlign = 'left' | 'center' | 'right'

export interface TableColumn<T> {
  key: string
  title?: ReactNode
  dataIndex?: keyof T
  width?: number | string
  align?: TableAlign
  className?: string
  ellipsis?: boolean | { rows?: number }
  render?: (value: unknown, record: T, index: number) => ReactNode
}

export interface TablePagination {
  pageSize?: number
  pageSizeOptions?: number[]
  showSizeChanger?: boolean
  hideOnSinglePage?: boolean
}

export function Table<T>({
  columns,
  dataSource,
  rowKey,
  pagination = false,
  empty = '暂无数据',
  rowClassName,
  onRow,
  resetKey,
  className = '',
}: {
  columns: TableColumn<T>[]
  dataSource: T[]
  rowKey: keyof T | ((record: T, index: number) => string | number)
  pagination?: false | TablePagination
  empty?: ReactNode
  rowClassName?: string | ((record: T, index: number) => string)
  onRow?: (record: T, index: number) => { onClick?: () => void }
  resetKey?: string | number
  className?: string
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(pagination ? pagination.pageSize ?? 10 : 10)

  useEffect(() => { setPage(1) }, [resetKey, pageSize])

  const pageCount = Math.max(1, Math.ceil(dataSource.length / Math.max(1, pageSize)))
  useEffect(() => { setPage((p) => Math.min(p, pageCount)) }, [pageCount])

  const rows = useMemo(() => {
    if (!pagination) return dataSource
    const start = (Math.min(page, pageCount) - 1) * pageSize
    return dataSource.slice(start, start + pageSize)
  }, [dataSource, pagination, page, pageCount, pageSize])

  const fixed = columns.some((col) => col.width != null || col.ellipsis)
  const showPager = Boolean(pagination) && dataSource.length > 0
    && !(pagination && pagination.hideOnSinglePage && pageCount <= 1)
  const safePage = Math.min(page, pageCount)

  const keyOf = (record: T, index: number) => (
    typeof rowKey === 'function' ? rowKey(record, index) : String(record[rowKey] ?? index)
  )

  return (
    <div className={`ui-table-shell ${className}`.trim()}>
      <div className="ui-table-wrap">
        <table className={`ui-table${fixed ? ' is-fixed' : ''}`}>
          <colgroup>
            {columns.map((col) => (
              <col key={col.key} style={colWidth(col.width)} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={cellClass(col)} style={cellAlign(col.align)}>
                  {col.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((record, index) => {
              const absIndex = pagination ? (safePage - 1) * pageSize + index : index
              const extra = onRow?.(record, absIndex)
              const cls = typeof rowClassName === 'function' ? rowClassName(record, absIndex) : rowClassName
              return (
                <tr key={keyOf(record, absIndex)} className={cls || undefined} onClick={extra?.onClick}>
                  {columns.map((col) => {
                    const value = col.dataIndex != null ? record[col.dataIndex] : undefined
                    const content = col.render ? col.render(value, record, absIndex) : (value as ReactNode)
                    return (
                      <td key={col.key} className={cellClass(col)} style={cellAlign(col.align)}>
                        {wrapEllipsis(content, col.ellipsis)}
                      </td>
                    )
                  })}
                </tr>
              )
            }) : (
              <tr className="ui-table-empty-row">
                <td colSpan={Math.max(1, columns.length)}>
                  <div className="ui-table-empty">{empty}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {showPager && pagination && (
        <Pager
          page={safePage}
          pageCount={pageCount}
          pageSize={pageSize}
          total={dataSource.length}
          onPage={setPage}
          onPageSize={pagination.showSizeChanger === false ? undefined : setPageSize}
          pageSizes={pagination.pageSizeOptions}
        />
      )}
    </div>
  )
}

function colWidth(width?: number | string): CSSProperties | undefined {
  if (width == null) return undefined
  return { width: typeof width === 'number' ? `${width}px` : width }
}

function cellAlign(align?: TableAlign): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined
}

function cellClass(col: { ellipsis?: unknown; className?: string }) {
  return ['ui-table-cell', col.ellipsis ? 'has-ellipsis' : '', col.className ?? ''].filter(Boolean).join(' ')
}

function wrapEllipsis(content: ReactNode, ellipsis?: boolean | { rows?: number }) {
  if (!ellipsis) return content
  const rows = typeof ellipsis === 'object' ? (ellipsis.rows ?? 1) : 1
  return (
    <div
      className="ui-table-ellipsis"
      style={{ WebkitLineClamp: rows, lineClamp: rows } as CSSProperties}
      title={typeof content === 'string' ? content : undefined}
    >
      {content}
    </div>
  )
}
