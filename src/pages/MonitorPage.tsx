import { useState, useEffect, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, CheckCircle, XCircle, Clock, RefreshCw, ChevronDown, ChevronUp, Play } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface AiLog {
  id: string
  type: string
  model: string
  from_address: string | null
  subject: string | null
  ai_result: Record<string, unknown> | null
  prompt_length: number | null
  status: 'success' | 'error'
  error_message: string | null
  duration_ms: number | null
  linked_id: string | null
  created_at: string
}

type FilterStatus = 'all' | 'success' | 'error'
type FilterType   = 'all' | 'candidate' | 'project'
type FilterRange  = 'today' | '7d' | '30d'

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
}

function formatMs(ms: number | null) {
  if (ms == null) return '-'
  if (ms >= 10_000) return `⚠️ ${(ms/1000).toFixed(1)}秒`
  return `${(ms/1000).toFixed(1)}秒`
}

function rangeStart(range: FilterRange): string {
  const now = Date.now()
  if (range === 'today') {
    const d = new Date(); d.setHours(0,0,0,0); return d.toISOString()
  }
  if (range === '7d') return new Date(now - 7*86400_000).toISOString()
  return new Date(now - 30*86400_000).toISOString()
}

export function MonitorPage() {
  const queryClient = useQueryClient()
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterType,   setFilterType]   = useState<FilterType>('all')
  const [filterRange,  setFilterRange]  = useState<FilterRange>('7d')
  const [selectedLog,  setSelectedLog]  = useState<AiLog | null>(null)
  const [rerunResult,  setRerunResult]  = useState<string | null>(null)
  const [rerunning,    setRerunning]    = useState<string | null>(null)

  // ── サマリー（直近24h） ──────────────────────────────
  const { data: summary = [] } = useQuery({
    queryKey: ['ai_logs_summary'],
    queryFn: async () => {
      const since = new Date(Date.now() - 86400_000).toISOString()
      const { data } = await supabase.from('ai_logs').select('status, duration_ms').gte('created_at', since)
      return data ?? []
    },
    refetchInterval: 30_000,
  })

  const total   = summary.length
  const success = summary.filter(r => r.status === 'success').length
  const failed  = summary.filter(r => r.status === 'error').length
  const avgMs   = total > 0
    ? summary.reduce((s, r) => s + (r.duration_ms ?? 0), 0) / total
    : 0

  // ── ログ一覧 ──────────────────────────────────────
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['ai_logs', filterStatus, filterType, filterRange],
    queryFn: async () => {
      let q = supabase.from('ai_logs').select('*').gte('created_at', rangeStart(filterRange)).order('created_at', { ascending: false }).limit(50)
      if (filterStatus !== 'all') q = q.eq('status', filterStatus)
      if (filterType   !== 'all') q = q.eq('type', filterType)
      const { data } = await q
      return (data ?? []) as AiLog[]
    },
    refetchInterval: 30_000,
  })

  // ── リアルタイム購読 ──────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('ai_logs_monitor')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_logs' }, () => {
        queryClient.invalidateQueries({ queryKey: ['ai_logs'] })
        queryClient.invalidateQueries({ queryKey: ['ai_logs_summary'] })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [queryClient])

  // ── 手動再実行 ────────────────────────────────────
  const handleRerun = useCallback(async (log: AiLog) => {
    setRerunning(log.id)
    setRerunResult(null)
    try {
      // raw_profile.text を candidates から取得（linked_id があれば）
      let body = (log.ai_result as Record<string, unknown>)?.rawBody as string ?? ''
      if (!body && log.linked_id && log.type !== 'project') {
        const { data: cand } = await supabase.from('candidates').select('raw_profile').eq('id', log.linked_id).single()
        body = (cand?.raw_profile as Record<string, unknown>)?.text as string ?? ''
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
      const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY as string
      const res = await fetch(`${supabaseUrl}/functions/v1/inbound-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          type: log.type,
          from: log.from_address ?? '',
          subject: log.subject ?? '',
          body,
        }),
      })
      const data = await res.json()
      setRerunResult(res.ok ? `✅ 再実行成功: ${JSON.stringify(data)}` : `❌ 再実行失敗: ${data.error ?? JSON.stringify(data)}`)
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['ai_logs'] })
        queryClient.invalidateQueries({ queryKey: ['ai_logs_summary'] })
      }
    } catch (e) {
      setRerunResult(`❌ エラー: ${String(e)}`)
    } finally {
      setRerunning(null)
    }
  }, [queryClient])

  const SUMMARY_CARDS = [
    { label: '総処理数（24h）', value: total,                    color: 'text-gray-800' },
    { label: '成功',            value: success,                  color: 'text-green-600' },
    { label: '失敗',            value: failed,                   color: 'text-red-500' },
    { label: '平均処理時間',   value: `${(avgMs/1000).toFixed(1)}秒`, color: avgMs > 10_000 ? 'text-yellow-600' : 'text-gray-800' },
  ]

  return (
    <div className="space-y-5">
      {/* サマリーカード */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {SUMMARY_CARDS.map(c => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <p className="text-xs text-gray-400 mb-1">{c.label}</p>
            <p className={`text-2xl font-bold ${c.color}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* フィルター */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap gap-3 items-center">
        <Activity size={16} className="text-blue-600 shrink-0" />
        <span className="text-sm font-medium text-gray-700">メール解析ログ</span>
        <div className="flex gap-1 ml-auto flex-wrap">
          {(['all','success','error'] as FilterStatus[]).map(v => (
            <button key={v} onClick={() => setFilterStatus(v)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${filterStatus===v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-500 hover:border-blue-400'}`}>
              {v==='all'?'全て':v==='success'?'✅ 成功':'❌ 失敗'}
            </button>
          ))}
          <span className="text-gray-300">|</span>
          {(['all','candidate','project'] as FilterType[]).map(v => (
            <button key={v} onClick={() => setFilterType(v)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${filterType===v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-500 hover:border-blue-400'}`}>
              {v==='all'?'全種別':v==='candidate'?'人材':'案件'}
            </button>
          ))}
          <span className="text-gray-300">|</span>
          {([['today','今日'],['7d','7日'],['30d','30日']] as [FilterRange,string][]).map(([v,l]) => (
            <button key={v} onClick={() => setFilterRange(v)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${filterRange===v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-500 hover:border-blue-400'}`}>
              {l}
            </button>
          ))}
          <button onClick={() => queryClient.invalidateQueries({ queryKey: ['ai_logs'] })}
            className="text-xs px-2.5 py-1 rounded-full border border-gray-300 text-gray-500 hover:border-blue-400 flex items-center gap-1">
            <RefreshCw size={11} />更新
          </button>
        </div>
      </div>

      {/* 再実行結果 */}
      {rerunResult && (
        <div className={`text-sm rounded-lg px-4 py-2 ${rerunResult.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
          {rerunResult}
        </div>
      )}

      {/* ログテーブル */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <p className="text-sm text-gray-400 p-6">読み込み中...</p>
        ) : logs.length === 0 ? (
          <p className="text-sm text-gray-400 p-6">該当するログがありません</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['受信日時','種別','差出人','件名','ステータス','処理時間','操作'].map(h => (
                    <th key={h} className="text-left text-xs text-gray-500 font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map(log => (
                  <tr key={log.id} className={`hover:bg-gray-50 transition-colors ${log.status==='error' ? 'bg-red-50/40' : ''}`}>
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{formatDate(log.created_at)}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs rounded px-1.5 py-0.5 ${log.type==='candidate' ? 'bg-blue-50 text-blue-700' : log.type==='project' ? 'bg-purple-50 text-purple-700' : 'bg-gray-100 text-gray-500'}`}>
                        {log.type==='candidate'?'人材':log.type==='project'?'案件':'不明'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-32 truncate">{log.from_address ?? '-'}</td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-40 truncate" title={log.subject ?? ''}>{log.subject ?? '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {log.status === 'success'
                        ? <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle size={12} />成功</span>
                        : <span className="flex items-center gap-1 text-xs text-red-500"><XCircle size={12} />失敗</span>}
                    </td>
                    <td className={`px-3 py-2 text-xs whitespace-nowrap ${(log.duration_ms ?? 0) > 10_000 ? 'text-yellow-600' : 'text-gray-500'}`}>
                      {formatMs(log.duration_ms)}
                    </td>
                    <td className="px-3 py-2 flex items-center gap-1.5 whitespace-nowrap">
                      <button onClick={() => { setSelectedLog(log); setRerunResult(null) }}
                        className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-0.5">
                        <ChevronDown size={12} />詳細
                      </button>
                      {log.status === 'error' && (
                        <button onClick={() => handleRerun(log)} disabled={rerunning === log.id}
                          className="text-xs bg-orange-50 text-orange-600 hover:bg-orange-100 rounded px-1.5 py-0.5 flex items-center gap-0.5 disabled:opacity-50">
                          <Play size={11} />{rerunning === log.id ? '実行中...' : '再実行'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 詳細モーダル */}
      {selectedLog && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSelectedLog(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
                <Clock size={16} className="text-blue-600" />
                解析ログ詳細
              </h2>
              <button onClick={() => setSelectedLog(null)} className="text-gray-400 hover:text-gray-600">
                <ChevronUp size={18} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-gray-400 text-xs">受信日時</span><p className="text-gray-700">{formatDate(selectedLog.created_at)}</p></div>
              <div><span className="text-gray-400 text-xs">ステータス</span>
                <p>{selectedLog.status==='success'
                  ? <span className="text-green-600 flex items-center gap-1"><CheckCircle size={13} />成功</span>
                  : <span className="text-red-500 flex items-center gap-1"><XCircle size={13} />失敗</span>}</p>
              </div>
              <div><span className="text-gray-400 text-xs">差出人</span><p className="text-gray-700 break-all">{selectedLog.from_address ?? '-'}</p></div>
              <div><span className="text-gray-400 text-xs">処理時間</span><p className={`${(selectedLog.duration_ms ?? 0) > 10_000 ? 'text-yellow-600' : 'text-gray-700'}`}>{formatMs(selectedLog.duration_ms)}</p></div>
              <div className="col-span-2"><span className="text-gray-400 text-xs">件名</span><p className="text-gray-700">{selectedLog.subject ?? '-'}</p></div>
              <div><span className="text-gray-400 text-xs">モデル</span><p className="text-gray-700">{selectedLog.model ?? '-'}</p></div>
              <div><span className="text-gray-400 text-xs">プロンプト長</span><p className="text-gray-700">{selectedLog.prompt_length != null ? `${selectedLog.prompt_length.toLocaleString()} 文字` : '-'}</p></div>
            </div>

            {selectedLog.error_message && (
              <div className="bg-red-50 rounded-lg p-3">
                <p className="text-xs text-red-500 font-medium mb-1">エラーメッセージ</p>
                <p className="text-xs text-red-700 break-all">{selectedLog.error_message}</p>
              </div>
            )}

            {selectedLog.linked_id && (
              <div className="bg-blue-50 rounded-lg p-3">
                <p className="text-xs text-blue-500 font-medium mb-1">紐付きID（{selectedLog.type==='candidate'?'候補者':'案件'}）</p>
                <p className="text-xs text-blue-700 font-mono">{selectedLog.linked_id}</p>
              </div>
            )}

            {selectedLog.ai_result && (
              <div>
                <p className="text-xs text-gray-400 font-medium mb-1">AI解析結果</p>
                <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64 text-gray-700 whitespace-pre-wrap">
                  {JSON.stringify(selectedLog.ai_result, null, 2)}
                </pre>
              </div>
            )}

            {selectedLog.status === 'error' && (
              <button onClick={() => { handleRerun(selectedLog); setSelectedLog(null) }}
                disabled={rerunning === selectedLog.id}
                className="flex items-center gap-2 bg-orange-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-orange-600 disabled:opacity-50 transition-colors">
                <Play size={14} />{rerunning === selectedLog.id ? '再実行中...' : 'このログを再実行'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
