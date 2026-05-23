import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { geoMercator, geoPath } from 'd3-geo'
import type { GeoPermissibleObjects } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import { fetchPrefectureCounts, fetchSkillNames, fetchCandidatesByPrefecture } from '../lib/db/heatmap'
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
function getColor(count: number, max: number, selected: boolean): string {
  if (selected) return '#f59e0b'
  if (count === 0 || max === 0) return '#e5e7eb'
  const ratio = Math.sqrt(count / max)
  const r = Math.round(219 - ratio * 174)
  const g = Math.round(234 - ratio * 145)
  const b = Math.round(254 - ratio * 55)
  return `rgb(${r},${g},${b})`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${d.getFullYear()}/${mm}/${dd} ${hh}:${min}`
}

const MAP_W = 700
const MAP_H = 500

export function HeatmapPage({ dataEnv }: Props) {
  const [skillFilter, setSkillFilter] = useState<string>('')
  const [inputValue, setInputValue] = useState<string>('')
  const [period, setPeriod] = useState<'7d' | 'all'>('7d')
  const [hovered, setHovered] = useState<{ name: string; count: number; x: number; y: number } | null>(null)
  const [selectedPref, setSelectedPref] = useState<string | null>(null)
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
    queryKey: ['heatmap', dataEnv, skillFilter, period],
    queryFn: () => fetchPrefectureCounts(dataEnv, skillFilter || null, period),
    staleTime: 60_000,
  })

  const { data: skillNames = [] } = useQuery({
    queryKey: ['skill-names-heatmap'],
    queryFn: fetchSkillNames,
    staleTime: 5 * 60_000,
  })

  const { data: prefCandidates = [], isLoading: candLoading } = useQuery({
    queryKey: ['heatmap-candidates', dataEnv, selectedPref, skillFilter, period],
    queryFn: () => fetchCandidatesByPrefecture(dataEnv, selectedPref!, skillFilter || null, period),
    enabled: !!selectedPref,
    staleTime: 30_000,
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

  function handlePrefClick(name: string) {
    setSelectedPref(prev => prev === name ? null : name)
  }

  const top10 = useMemo(() => prefData.slice(0, 10), [prefData])

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      {/* ヘッダー */}
      <div className="mb-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-800 mb-0.5">人材分布マップ</h2>
          <p className="text-xs text-gray-500">都道府県をクリックすると受信メール一覧を表示します</p>
        </div>

        {/* 期間トグル */}
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5 text-xs">
          <button
            onClick={() => setPeriod('7d')}
            className={`px-3 py-1 rounded-md transition-colors ${period === '7d' ? 'bg-white text-gray-800 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'}`}
          >
            直近7日
          </button>
          <button
            onClick={() => setPeriod('all')}
            className={`px-3 py-1 rounded-md transition-colors ${period === 'all' ? 'bg-white text-gray-800 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'}`}
          >
            全期間
          </button>
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
            {period === 'all' && <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded mr-2">全期間</span>}
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
                const isSelected = selectedPref === name
                return (
                  <path
                    key={geo.properties.id}
                    d={d}
                    fill={getColor(count, maxCount, isSelected)}
                    stroke={isSelected ? '#d97706' : '#fff'}
                    strokeWidth={isSelected ? 1.5 : 0.5}
                    style={{ cursor: 'pointer', transition: 'fill 0.15s' }}
                    onMouseMove={(e) => handleMouseMove(e, name, count)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => handlePrefClick(name)}
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
                {hovered.name !== selectedPref && <span className="ml-1 text-gray-400">（クリックで詳細）</span>}
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
                  style={{ background: getColor(Math.round(r * maxCount), maxCount, false) }}
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
                <li
                  key={prefecture}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1 -mx-1 transition-colors ${selectedPref === prefecture ? 'bg-amber-50' : 'hover:bg-gray-50'}`}
                  onClick={() => handlePrefClick(prefecture)}
                >
                  <span className="w-5 text-right text-xs text-gray-400 shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className={`text-xs truncate ${selectedPref === prefecture ? 'text-amber-700 font-medium' : 'text-gray-800'}`}>{prefecture}</span>
                      <span className="text-xs text-gray-500 ml-1 shrink-0">{count.toLocaleString()}人</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${selectedPref === prefecture ? 'bg-amber-400' : 'bg-blue-400'}`}
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

      {/* 都道府県クリック時の人材リスト */}
      {selectedPref && (
        <div className="mt-4 bg-white rounded-xl border border-amber-200 shadow-sm">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-800">{selectedPref}</span>
              {skillFilter && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{skillFilter}</span>
              )}
              <span className="text-xs text-gray-400">受信メール一覧（最大10件・新しい順）</span>
            </div>
            <button
              onClick={() => setSelectedPref(null)}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              ×
            </button>
          </div>

          {candLoading ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">読み込み中...</div>
          ) : prefCandidates.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              {skillFilter
                ? `${selectedPref}に${skillFilter}を持つ人材は見つかりません`
                : `${selectedPref}の人材は見つかりません`}
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {prefCandidates.map((c) => (
                <li key={c.id} className="px-4 py-2.5 flex items-start gap-3">
                  <div className="shrink-0 text-xs text-gray-400 mt-0.5 whitespace-nowrap">
                    {formatDate(c.created_at)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-xs font-medium text-gray-700">{c.name}</span>
                      {c.is_archived && (
                        <span className="text-xs bg-gray-100 text-gray-400 px-1 rounded">アーカイブ</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 truncate" title={c.subject ?? ''}>
                      {c.subject ?? '（件名なし）'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
