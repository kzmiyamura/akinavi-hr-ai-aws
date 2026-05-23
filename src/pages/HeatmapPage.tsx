import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { geoMercator, geoPath } from 'd3-geo'
import type { GeoPermissibleObjects } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import { fetchPrefectureCounts, fetchSkillNames } from '../lib/db/heatmap'
import type { DataEnv } from '../lib/dataEnv'

interface Props {
  dataEnv: DataEnv
}

interface GeoFeature {
  type: string
  properties: { nam_ja: string; nam: string; id: number }
  geometry: GeoPermissibleObjects
}

/** count に応じた塗り色（薄青〜濃青） */
function getColor(count: number, max: number): string {
  if (count === 0 || max === 0) return '#e5e7eb'
  const ratio = Math.sqrt(count / max)
  const r = Math.round(219 - ratio * 174)
  const g = Math.round(234 - ratio * 145)
  const b = Math.round(254 - ratio * 55)
  return `rgb(${r},${g},${b})`
}

const MAP_W = 700
const MAP_H = 500

export function HeatmapPage({ dataEnv }: Props) {
  const [skillFilter, setSkillFilter] = useState<string>('')
  const [inputValue, setInputValue] = useState<string>('')
  const [hovered, setHovered] = useState<{ name: string; count: number; x: number; y: number } | null>(null)
  const [geoFeatures, setGeoFeatures] = useState<GeoFeature[]>([])
  const svgRef = useRef<SVGSVGElement>(null)

  // Japan TopoJSON を fetch
  useEffect(() => {
    fetch('/japan.topojson')
      .then((r) => r.json())
      .then((topo: Topology) => {
        const fc = feature(topo, topo.objects['japan']) as unknown as { features: GeoFeature[] }
        setGeoFeatures(fc.features)
      })
      .catch(console.error)
  }, [])

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

  // d3-geo Mercator プロジェクション
  const pathGenerator = useMemo(() => {
    const projection = geoMercator()
      .center([136.5, 35.5])
      .scale(1400)
      .translate([MAP_W / 2, MAP_H / 2])
    return geoPath(projection)
  }, [])

  // オートコンプリート候補
  const suggestions = useMemo(() => {
    if (!inputValue || inputValue === skillFilter) return []
    const lower = inputValue.toLowerCase()
    return skillNames.filter((n) => n.toLowerCase().includes(lower)).slice(0, 8)
  }, [inputValue, skillFilter, skillNames])

  function applySkill(skill: string) {
    setSkillFilter(skill)
    setInputValue(skill)
  }

  function clearFilter() {
    setSkillFilter('')
    setInputValue('')
  }

  function handleMouseMove(e: React.MouseEvent<SVGPathElement>, name: string, count: number) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    setHovered({ name, count, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const top10 = useMemo(() => prefData.slice(0, 10), [prefData])

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      {/* ヘッダー */}
      <div className="mb-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-800 mb-0.5">人材分布マップ</h2>
          <p className="text-xs text-gray-500">都道府県別の人材数を地図上に表示します</p>
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
              {suggestions.length > 0 && (
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
              <><span className="font-medium text-blue-600">{skillFilter}</span> を持つ人材：</>
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
                <span className="text-sm text-gray-400">集計中...</span>
              </div>
            )}

            <svg
              ref={svgRef}
              viewBox={`0 0 ${MAP_W} ${MAP_H}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              onMouseLeave={() => setHovered(null)}
            >
              {geoFeatures.map((geo) => {
                const name = geo.properties.nam_ja
                const count = countMap[name] ?? 0
                const d = pathGenerator(geo.geometry as GeoPermissibleObjects)
                if (!d) return null
                return (
                  <path
                    key={geo.properties.id}
                    d={d}
                    fill={getColor(count, maxCount)}
                    stroke="#fff"
                    strokeWidth={0.5}
                    style={{ cursor: 'pointer', transition: 'fill 0.15s' }}
                    onMouseMove={(e) => handleMouseMove(e, name, count)}
                    onMouseLeave={() => setHovered(null)}
                  />
                )
              })}
            </svg>

            {/* ツールチップ */}
            {hovered && (
              <div
                className="pointer-events-none absolute z-20 bg-gray-800 text-white text-xs rounded px-2 py-1 shadow-lg"
                style={{ left: hovered.x + 12, top: hovered.y - 8 }}
              >
                <span className="font-bold">{hovered.name}</span>
                　{hovered.count.toLocaleString()}人
              </div>
            )}
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

        {/* ランキング */}
        <div className="w-full lg:w-64 bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">都道府県ランキング</h3>
          {prefLoading ? (
            <div className="text-xs text-gray-400">集計中...</div>
          ) : prefData.length === 0 ? (
            <div className="text-xs text-gray-400">該当する人材が見つかりません</div>
          ) : (
            <ol className="space-y-1.5">
              {top10.map(({ prefecture, count }, i) => (
                <li key={prefecture} className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-right text-xs text-gray-400 shrink-0">{i + 1}</span>
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
                <li className="text-xs text-gray-400 pt-1">他 {prefData.length - 10} 都道府県…</li>
              )}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
