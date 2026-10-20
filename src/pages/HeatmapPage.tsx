import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { geoMercator, geoPath } from 'd3-geo'
import type { GeoPermissibleObjects } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import { fetchPrefectureCounts, fetchSkillNames, fetchCandidatesByPrefecture } from '../lib/db/heatmap'
import { fetchPrioritySkills } from '../lib/db/candidates'
import { BookmarkStar } from '../components/BookmarkStar'
import { readRecentSkills, writeRecentSkills, pushRecentSkill } from '../lib/recentSkillFilters'
import { readPrioritySkillPref } from '../lib/prioritySkillPref'
import {
  HEATMAP_SORT_DEFAULT,
  HEATMAP_SORT_OPTIONS,
  listCaption,
  sortMetaLabel,
  type HeatmapSortKey,
} from '../lib/heatmapCandidateSort'
import type { DataEnv } from '../lib/dataEnv'

interface Props {
  dataEnv: DataEnv
  onSelectCandidate?: (id: string) => void
}

interface GeoFeature {
  type: string
  properties: { nam_ja: string; nam: string; id: number }
  geometry: GeoPermissibleObjects
}

interface ZoomState {
  scale: number
  tx: number
  ty: number
}

const ZOOM_NONE: ZoomState = { scale: 1, tx: 0, ty: 0 }

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

/** 一覧用の短い日時。スマホでは `2026/` が氏名と件名を押し出すので年は今年なら省く
 *  （全期間表示では去年の人も出るため、年が違うときだけ出す・2026-10-20 指摘） */
function formatDateShort(iso: string): string {
  const d = new Date(iso)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return sameYear ? `${mm}/${dd} ${hh}:${min}` : `${d.getFullYear()}/${mm}/${dd}`
}

const MAP_W = 700
const MAP_H = 500

/** 県別一覧の件数上限。並び替えを入れたので「どの10件か」は並びで変わる */
const LIST_LIMIT = 10

export function HeatmapPage({ dataEnv, onSelectCandidate }: Props) {
  const [skillFilter, setSkillFilter] = useState<string>('')
  const [inputValue, setInputValue] = useState<string>('')
  const [period, setPeriod] = useState<'7d' | 'all'>('7d')
  const [hovered, setHovered] = useState<{ name: string; count: number; x: number; y: number } | null>(null)
  const [selectedPref, setSelectedPref] = useState<string | null>(null)
  const [showAllPrefs, setShowAllPrefs] = useState(false)
  // 並び替えはボタンで押す（2026-10-20 営業の要望）。並べるのは DB 側
  const [sortKey, setSortKey] = useState<HeatmapSortKey>(HEATMAP_SORT_DEFAULT)
  const [zoom, setZoom] = useState<ZoomState>(ZOOM_NONE)
  const [geoFeatures, setGeoFeatures] = useState<GeoFeature[]>([])
  // 最近の絞り込みは端末ごとに覚える（認証が無くユーザーを識別できないため）
  const [recentSkills, setRecentSkills] = useState<string[]>(() => readRecentSkills())
  const svgRef = useRef<SVGSVGElement>(null)

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

  // ボタンで絞り込むためのスキル（2026-10-20 営業の要望「ボタンだけで絞りが効くように」）。
  // 人材タブの「表示優先スキル」と同じ集合を使う。別の表を作ると、営業が見ている
  // 優先スキルと地図のボタンがズレる。端末ごとの上書き（localStorage）も同じ約束で読む
  const { data: settingsPrioritySkills } = useQuery({
    queryKey: ['priority-skills'],
    queryFn: fetchPrioritySkills,
    staleTime: 5 * 60_000,
  })
  const priorityPref = useMemo(() => readPrioritySkillPref(), [])
  const skillButtons = useMemo(() => {
    const base = priorityPref.skills ?? settingsPrioritySkills ?? []
    // 最近使ったスキルのうち、優先スキルに無いものを後ろに足す（打ち直さずに戻れる）
    const extra = recentSkills.filter((s) => !base.includes(s))
    return [...base, ...extra].slice(0, 10)
  }, [priorityPref.skills, settingsPrioritySkills, recentSkills])

  const { data: prefCandidates = [], isLoading: candLoading } = useQuery({
    queryKey: ['heatmap-candidates', dataEnv, selectedPref, skillFilter, period, sortKey],
    queryFn: () =>
      fetchCandidatesByPrefecture(dataEnv, selectedPref!, skillFilter || null, period, LIST_LIMIT, sortKey),
    enabled: !!selectedPref,
    staleTime: 30_000,
  })

  const countMap = useMemo(() => {
    const m: Record<string, number> = {}
    for (const { prefecture, count } of prefData) m[prefecture] = count
    return m
  }, [prefData])

  const maxCount = useMemo(() => Math.max(1, ...prefData.map((p) => p.count)), [prefData])
  const totalCount = useMemo(() => prefData.reduce((s, p) => s + p.count, 0), [prefData])

  const pathGenerator = useMemo(() => {
    const projection = geoMercator()
      .center([136.5, 35.5])
      .scale(1400)
      .translate([MAP_W / 2, MAP_H / 2])
    return geoPath(projection)
  }, [])

  // geoFeature を名前で引けるマップ
  const geoByName = useMemo(() => {
    const m: Record<string, GeoFeature> = {}
    for (const geo of geoFeatures) m[geo.properties.nam_ja] = geo
    return m
  }, [geoFeatures])

  const suggestions = useMemo(() => {
    if (!inputValue || inputValue === skillFilter) return []
    const lower = inputValue.toLowerCase()
    return skillNames.filter((n) => n.toLowerCase().includes(lower)).slice(0, 8)
  }, [inputValue, skillFilter, skillNames])

  function applySkill(skill: string) {
    const s = skill.trim()
    setSkillFilter(s)
    setInputValue(s)
    // 空打ち（クリア相当）は履歴に残さない
    if (!s) return
    setRecentSkills((prev) => {
      const next = pushRecentSkill(prev, s)
      writeRecentSkills(next)
      return next
    })
  }

  function clearFilter() {
    setSkillFilter('')
    setInputValue('')
  }

  /** 履歴だけを消す。いま掛かっている絞り込みには触らない */
  function clearRecent() {
    setRecentSkills([])
    writeRecentSkills([])
  }

  function handleMouseMove(e: React.MouseEvent<SVGPathElement>, name: string, count: number) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    setHovered({ name, count, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  function zoomToPref(name: string) {
    const geo = geoByName[name]
    if (!geo) return
    const [[x0, y0], [x1, y1]] = pathGenerator.bounds(geo.geometry as GeoPermissibleObjects)
    const dx = x1 - x0
    const dy = y1 - y0
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const scale = Math.min((MAP_W / dx) * 0.75, (MAP_H / dy) * 0.75, 8)
    const tx = MAP_W / 2 - scale * cx
    const ty = MAP_H / 2 - scale * cy
    setZoom({ scale, tx, ty })
  }

  function handlePrefClick(name: string) {
    if (selectedPref === name) {
      setSelectedPref(null)
      setZoom(ZOOM_NONE)
    } else {
      setSelectedPref(name)
      zoomToPref(name)
    }
  }

  function handleReset() {
    setSelectedPref(null)
    setZoom(ZOOM_NONE)
  }

  // 既定は上位10件。ボタンで全件に広げられる（地図を触らずに県を選べるように）
  const rankedPrefs = useMemo(() => (showAllPrefs ? prefData : prefData.slice(0, 10)), [prefData, showAllPrefs])

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      {/* ヘッダー */}
      <div className="mb-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-800 mb-0.5">人材分布マップ</h2>
          <p className="text-xs text-gray-500">都道府県をクリックするとズームして受信メール一覧を表示します</p>
        </div>

        {/* 期間トグル */}
        {/* 指で押せる大きさ（40px）に揃える。通知タブと同じ基準（2026-10-20） */}
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5 text-sm self-start">
          <button
            onClick={() => setPeriod('7d')}
            className={`px-4 min-h-10 rounded-md transition-colors ${period === '7d' ? 'bg-white text-gray-800 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'}`}
          >
            直近7日
          </button>
          <button
            onClick={() => setPeriod('all')}
            className={`px-4 min-h-10 rounded-md transition-colors ${period === 'all' ? 'bg-white text-gray-800 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'}`}
          >
            全期間
          </button>
        </div>

      </div>

      {/* スキルの絞り込み。
          スマホで文字を打たずに使えるよう、まずボタンを出す（2026-10-20 営業の要望）。
          並びは人材タブの「表示優先スキル」そのままなので、両方の画面で同じ言葉を押せる。
          入力欄はその下に残す（ボタンに無いスキルを見たいときだけ使う） */}
      <div className="mb-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          <button
            type="button"
            onClick={clearFilter}
            className={`shrink-0 text-sm rounded-lg px-4 min-h-10 border transition-colors ${
              skillFilter === ''
                ? 'bg-blue-600 border-blue-600 text-white font-medium'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            すべて
          </button>
          {skillButtons.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => (s === skillFilter ? clearFilter() : applySkill(s))}
              className={`shrink-0 text-sm rounded-lg px-4 min-h-10 border transition-colors ${
                s === skillFilter
                  ? 'bg-blue-600 border-blue-600 text-white font-medium'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <details className="mt-1.5">
          <summary className="text-xs text-gray-400 cursor-pointer select-none">ほかのスキルで絞る</summary>
          <div className="relative mt-1.5 flex items-center gap-2">
            <div className="relative">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applySkill(inputValue)
                  if (e.key === 'Escape') clearFilter()
                }}
                placeholder="スキル名（例: AS/400）"
                className="border border-gray-300 rounded-md px-3 min-h-10 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
              {suggestions.length > 0 && (
                <ul className="absolute z-10 bg-white border border-gray-200 rounded-md shadow-lg mt-1 w-full max-h-48 overflow-y-auto text-sm">
                  {suggestions.map((s) => (
                    <li
                      key={s}
                      className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                      onMouseDown={() => applySkill(s)}
                    >
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {recentSkills.length > 0 && (
              <button
                type="button"
                onClick={clearRecent}
                className="text-xs text-gray-400 hover:text-gray-600 underline whitespace-nowrap"
              >
                履歴を消す
              </button>
            )}
          </div>
        </details>
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
            <span className="font-bold text-gray-800 ml-1">{totalCount.toLocaleString()} 人</span>
            　{prefData.length} 都道府県に分布
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

            {/* ズームリセットボタン */}
            {selectedPref && (
              <button
                onClick={handleReset}
                className="absolute top-2 right-2 z-10 bg-white border border-gray-200 rounded-md px-2 py-1 text-xs text-gray-500 hover:text-gray-800 shadow-sm flex items-center gap-1"
              >
                ← 全体表示
              </button>
            )}

            <svg
              ref={svgRef}
              viewBox={`0 0 ${MAP_W} ${MAP_H}`}
              style={{ width: '100%', height: 'auto', display: 'block', cursor: selectedPref ? 'zoom-out' : 'default' }}
              onMouseLeave={() => setHovered(null)}
              onClick={(e) => {
                // SVG背景クリックでリセット
                if (e.target === svgRef.current) handleReset()
              }}
            >
              <g
                style={{
                  transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
                  transformOrigin: '0 0',
                  transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                {geoFeatures.map((geo) => {
                  const name = geo.properties.nam_ja
                  const count = countMap[name] ?? 0
                  const d = pathGenerator(geo.geometry as GeoPermissibleObjects)
                  if (!d) return null
                  const isSelected = selectedPref === name
                  const strokeW = isSelected ? 2 / zoom.scale : 0.5 / zoom.scale
                  return (
                    <path
                      key={geo.properties.id}
                      d={d}
                      fill={getColor(count, maxCount, isSelected)}
                      stroke={isSelected ? '#d97706' : '#fff'}
                      strokeWidth={strokeW}
                      style={{
                        cursor: 'pointer',
                        transition: 'fill 0.3s',
                        filter: isSelected ? 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))' : undefined,
                      }}
                      onMouseMove={(e) => handleMouseMove(e, name, count)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={(e) => { e.stopPropagation(); handlePrefClick(name) }}
                    />
                  )
                })}
              </g>
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
                <div key={r} className="flex-1" style={{ background: getColor(Math.round(r * maxCount), maxCount, false) }} />
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
              {rankedPrefs.map(({ prefecture, count }, i) => (
                <li
                  key={prefecture}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1 -mx-1 py-1.5 min-h-11 transition-colors ${selectedPref === prefecture ? 'bg-amber-50' : 'hover:bg-gray-50'}`}
                  onClick={() => handlePrefClick(prefecture)}
                >
                  <span className="w-5 text-right text-xs text-gray-400 shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-sm truncate ${selectedPref === prefecture ? 'text-amber-700 font-medium' : 'text-gray-800'}`}>{prefecture}</span>
                      <span className="text-xs text-gray-500 ml-1 shrink-0">{count.toLocaleString()}人</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${selectedPref === prefecture ? 'bg-amber-400' : 'bg-blue-400'}`}
                        style={{ width: `${(count / maxCount) * 100}%` }}
                      />
                    </div>
                  </div>
                </li>
              ))}
              {prefData.length > 10 && (
                // 「他 18 都道府県…」は押せない字だった。地図を触らずに県を選べるようにする
                <li className="pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAllPrefs((v) => !v)}
                    className="w-full text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded min-h-10 px-2 text-left"
                  >
                    {showAllPrefs ? '上位10件だけ表示' : `他 ${prefData.length - 10} 都道府県を表示`}
                  </button>
                </li>
              )}
            </ol>
          )}
        </div>
      </div>

      {/* 都道府県クリック時の人材リスト */}
      {selectedPref && (
        <div className="mt-4 bg-white rounded-xl border border-amber-200 shadow-sm">
          <div className="flex items-start justify-between gap-2 px-3 sm:px-4 py-3 border-b border-gray-100">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-gray-800">{selectedPref}</span>
                {skillFilter && (
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{skillFilter}</span>
                )}
              </div>
              {/* 狭い画面では同じ行に入らず氏名を押し出していたので、説明は下の行に置く */}
              <div className="text-[11px] text-gray-400 mt-0.5">{listCaption(sortKey, LIST_LIMIT, period)}</div>
            </div>
            <button
              onClick={handleReset}
              title="閉じる"
              className="shrink-0 flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 text-lg leading-none"
            >
              ×
            </button>
          </div>

          {/* 並び替え。文字を打たずに押せる形（スキル絞り込みのボタンと同じ基準・40px）。
              押すと DB に並びを渡して引き直す＝出てくる10件そのものが入れ替わる */}
          <div className="flex items-center gap-2 overflow-x-auto px-3 sm:px-4 py-2 border-b border-gray-100">
            <span className="shrink-0 text-[11px] text-gray-400">並び</span>
            {HEATMAP_SORT_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setSortKey(o.value)}
                aria-pressed={sortKey === o.value}
                className={`shrink-0 text-xs rounded-lg px-3 min-h-10 border transition-colors ${
                  sortKey === o.value
                    ? 'bg-amber-500 border-amber-500 text-white font-medium'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {o.label}
              </button>
            ))}
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
              {prefCandidates.map((c) => {
                const canOpen = !c.is_archived && !!onSelectCandidate
                // 並び替えの基準になっている値（単価順のときだけ入る）
                const meta = sortMetaLabel(c, sortKey)
                return (
                  // スマホでは氏名が右端に飛ばされ、件名がその下に半分だけ出ていた
                  // （2026-10-20 指摘）。日時を先頭に置くのをやめ、**氏名を行の頭**にして
                  // 日時は右肩へ逃がす。行の高さも指で押せる大きさ（56px）にする
                  <li
                    key={c.id}
                    className={`px-3 sm:px-4 py-3 min-h-14 flex items-start gap-2 sm:gap-3 transition-colors ${canOpen ? 'cursor-pointer hover:bg-amber-50' : ''}`}
                    onClick={canOpen ? () => onSelectCandidate(c.id) : undefined}
                  >
                    {/* アーカイブ済みは candidates から消えているので星を出さない */}
                    {!c.is_archived && (
                      <BookmarkStar candidateId={c.id} dataEnv={dataEnv} bookmarked={c.bookmarked} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className={`text-sm font-medium truncate ${canOpen ? 'text-blue-700 underline' : 'text-gray-700'}`}>
                          {c.name}
                        </span>
                        {c.is_archived && (
                          <span className="text-[10px] bg-gray-100 text-gray-400 px-1 rounded shrink-0">アーカイブ</span>
                        )}
                        <span
                          className="ml-auto shrink-0 text-[11px] text-gray-400 whitespace-nowrap"
                          title={formatDate(c.created_at)}
                        >
                          {formatDateShort(c.created_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-500 truncate" title={c.subject ?? ''}>
                          {c.subject ?? '（件名なし）'}
                        </span>
                        {/* 単価で並べたのに単価が見えないと、並んでいるか確かめようがない */}
                        {meta && (
                          <span
                            className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded ${
                              c.desired_rate ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-400'
                            }`}
                          >
                            {meta}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
