import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ComposableMap,
  Geographies,
  Geography,
  ZoomableGroup,
} from 'react-simple-maps'
import { Tooltip } from 'react-tooltip'
import { fetchPrefectureCounts, fetchSkillNames } from '../lib/db/heatmap'
import type { DataEnv } from '../lib/dataEnv'

const JAPAN_TOPOJSON = '/japan.topojson'

interface Props {
  dataEnv: DataEnv
}

/** count に応じた塗り色（薄い青〜濃い青） */
function getColor(count: number, max: number): string {
  if (count === 0 || max === 0) return '#e5e7eb'
  const ratio = Math.sqrt(count / max) // sqrt で中間値を見やすく
  const r = Math.round(219 - ratio * 174) // 219→45
  const g = Math.round(234 - ratio * 145) // 234→89
  const b = Math.round(254 - ratio * 55)  // 254→199
  return `rgb(${r},${g},${b})`
}

export function HeatmapPage({ dataEnv }: Props) {
  const [skillFilter, setSkillFilter] = useState<string>('')
  const [inputValue, setInputValue] = useState<string>('')
  const [tooltip, setTooltip] = useState<{ name: string; count: number } | null>(null)

  const { data: prefData = [], isLoading: prefLoading } = useQuery({
    queryKey: ['heatmap', dataEnv, skillFilter],
    queryFn: () => fetchPrefectureCounts(dataEnv, skillFilter || null),
    staleTime: 60_000,
  })

  const { data: skillNames = [] } = useQuery({
    queryKey: ['skill-names-heatmap'],
    queryFn: fetchSkillNames,
    staleTime: 5 * 60_000,
  })

  const countMap = useMemo(() => {
    const m: Record<string, number> = {}
    for (const { prefecture, count } of prefData) m[prefecture] = count
    return m
  }, [prefData])

  const maxCount = useMemo(
    () => Math.max(1, ...prefData.map((p) => p.count)),
    [prefData]
  )

  const totalCount = useMemo(
    () => prefData.reduce((s, p) => s + p.count, 0),
    [prefData]
  )

  // スキル入力のサジェスト候補
  const suggestions = useMemo(() => {
    if (!inputValue) return []
    const lower = inputValue.toLowerCase()
    return skillNames.filter((n) => n.toLowerCase().includes(lower)).slice(0, 8)
  }, [inputValue, skillNames])

  function applySkill(skill: string) {
    setSkillFilter(skill)
    setInputValue(skill)
  }

  function clearFilter() {
    setSkillFilter('')
    setInputValue('')
  }

  // ランキング上位10件
  const top10 = useMemo(() => prefData.slice(0, 10), [prefData])

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="mb-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-800 mb-0.5">人材分布マップ</h2>
          <p className="text-xs text-gray-500">
            都道府県別の人材数を地図上に表示します
          </p>
        </div>

        {/* スキルフィルター */}
        <div className="relative sm:ml-auto">
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applySkill(inputValue)
                  if (e.key === 'Escape') clearFilter()
                }}
                placeholder="スキルで絞り込み（例: Java）"
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
              {suggestions.length > 0 && inputValue && inputValue !== skillFilter && (
                <ul className="absolute z-10 bg-white border border-gray-200 rounded-md shadow-lg mt-1 w-full max-h-48 overflow-y-auto text-sm">
                  {suggestions.map((s) => (
                    <li
                      key={s}
                      className="px-3 py-1.5 hover:bg-blue-50 cursor-pointer"
                      onMouseDown={() => applySkill(s)}
                    >
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {skillFilter && (
              <button
                onClick={clearFilter}
                className="text-xs text-gray-400 hover:text-gray-600 underline whitespace-nowrap"
              >
                クリア
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 集計サマリー */}
      <div className="mb-4 text-sm text-gray-500">
        {prefLoading ? (
          <span>集計中...</span>
        ) : (
          <span>
            {skillFilter ? (
              <>
                <span className="font-medium text-blue-600">{skillFilter}</span> を持つ人材：
              </>
            ) : '全人材：'}
            <span className="font-bold text-gray-800 ml-1">{totalCount.toLocaleString()}人</span>
            　{prefData.length}都道府県に分布
          </span>
        )}
      </div>

      <div className="flex flex-col lg:flex-row gap-4">
        {/* 地図 */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="relative">
            {prefLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/70 z-10">
                <span className="text-sm text-gray-400">読み込み中...</span>
              </div>
            )}
            <ComposableMap
              projection="geoMercator"
              projectionConfig={{ center: [136.5, 35.5], scale: 1400 }}
              width={700}
              height={500}
              style={{ width: '100%', height: 'auto' }}
            >
              <ZoomableGroup>
                <Geographies geography={JAPAN_TOPOJSON}>
                  {({ geographies }) =>
                    geographies.map((geo) => {
                      const name: string = String(geo.properties.nam_ja ?? '')
                      const count = countMap[name] ?? 0
                      return (
                        <Geography
                          key={geo.rsmKey}
                          geography={geo}
                          fill={getColor(count, maxCount)}
                          stroke="#fff"
                          strokeWidth={0.5}
                          data-tooltip-id="pref-tooltip"
                          onMouseEnter={() => setTooltip({ name, count })}
                          onMouseLeave={() => setTooltip(null)}
                          style={{
                            default: { outline: 'none' },
                            hover: { fill: '#3b82f6', outline: 'none', cursor: 'pointer' },
                            pressed: { outline: 'none' },
                          }}
                        />
                      )
                    })
                  }
                </Geographies>
              </ZoomableGroup>
            </ComposableMap>

            <Tooltip id="pref-tooltip" float>
              {tooltip && (
                <div className="text-sm">
                  <span className="font-bold">{tooltip.name}</span>
                  　{tooltip.count.toLocaleString()}人
                </div>
              )}
            </Tooltip>
          </div>

          {/* 凡例 */}
          <div className="px-4 pb-3 flex items-center gap-2 text-xs text-gray-500">
            <span>少</span>
            <div className="flex h-3 flex-1 max-w-32 rounded overflow-hidden">
              {[0.05, 0.2, 0.4, 0.6, 0.8, 1.0].map((r) => (
                <div
                  key={r}
                  className="flex-1"
                  style={{ background: getColor(Math.round(r * maxCount), maxCount) }}
                />
              ))}
            </div>
            <span>多</span>
          </div>
        </div>

        {/* 右サイドバー：ランキング */}
        <div className="w-full lg:w-64 bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            都道府県ランキング
          </h3>
          {prefLoading ? (
            <div className="text-xs text-gray-400">集計中...</div>
          ) : prefData.length === 0 ? (
            <div className="text-xs text-gray-400">
              該当する人材が見つかりません
            </div>
          ) : (
            <ol className="space-y-1.5">
              {top10.map(({ prefecture, count }, i) => (
                <li key={prefecture} className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-right text-xs text-gray-400 shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-gray-800 text-xs truncate">{prefecture}</span>
                      <span className="text-xs text-gray-500 ml-1 shrink-0">{count.toLocaleString()}人</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-400 rounded-full"
                        style={{ width: `${(count / maxCount) * 100}%` }}
                      />
                    </div>
                  </div>
                </li>
              ))}
              {prefData.length > 10 && (
                <li className="text-xs text-gray-400 pt-1">
                  他 {prefData.length - 10} 都道府県…
                </li>
              )}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
