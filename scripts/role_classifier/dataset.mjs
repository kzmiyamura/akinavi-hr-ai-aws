#!/usr/bin/env node
/**
 * 役割分類の学習データを作る。**ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * 設計（2026-09-19 のユーザー合意）:
 *   全員 → 分類器（無料・全件）
 *     ├ 確信あり  → 採用 ＋ 抜き取りで claude -p 監査
 *     └ 割れている → claude -p に**独立に**判断させる → 採用＆教師データに追加
 *
 * 教師ラベルは人手ではなく**弱教師（weak supervision）**で作る。
 * 今ある独立した信号を突き合わせ、全部一致したものだけを確実な例として扱い、
 * 割れたものは「不明」として学習から外し、claude -p に回す候補にする。
 *
 * ⚠ 今のラベル（rp_roles）をそのまま正解にしてはいけない。
 *   regex は語一致でしか拾えておらず、**盲点をそのまま学習する**。
 *   実測（prod 3,008人）: クラウドエンジニア18人しか居ないのに、
 *   インフラ役割の人は平均6.01個のクラウドスキルを持つ。語を名乗っていない人が全員落ちている。
 */
import fs from 'fs'
import path from 'path'

const DB_ROOT = 'D:\\akinavi-archive\\db\\candidates'

/** スキル分類。基盤側と開発側に分ける（2026-09-19 実測で両方向に差が出た）
 *  インフラ役割あり/なし の平均本数:
 *    clouds 6.01/3.49  infrastructures 4.84/3.10  os 4.45/2.95
 *    languages 3.98/6.64  frameworks 2.19/3.89  libraries 1.54/2.33 */
export const BASE_CATS = ['clouds', 'infrastructures', 'os']
export const DEV_CATS = ['languages', 'frameworks', 'libraries']
export const ALL_CATS = [
  'clouds', 'infrastructures', 'os', 'tools', 'methodologies', 'certifications',
  'databases', 'others', 'design', 'dwh', 'marketing', 'libraries', 'frameworks', 'languages',
]

/** 基盤の仕事でしか出てこない具体的な技術。語一致とは独立した信号にする。
 *  「インフラ」と一度も書いていない人でも、これが複数あれば基盤の人。 */
export const STRONG_INFRA_SKILLS = [
  'VMware', 'VMware ESXi', 'ESXi', 'Hyper-V', 'Zabbix', 'JP1', 'Hulft', 'Nagios',
  'Terraform', 'Ansible', 'Kubernetes', 'OpenShift', 'Docker',
  'Active Directory', 'Cisco', 'Juniper', 'Fortigate', 'YAMAHA',
  'Apache HTTP Server', 'Tomcat', 'Nginx', 'IIS',
  'RHEL', 'Red Hat Enterprise Linux', 'CentOS', 'Ubuntu', 'AIX', 'Solaris',
  'Windows Server', 'Linux', 'LDAP', 'DNS', 'DHCP', 'NAS', 'SAN',
  'Amazon EC2', 'Amazon S3', 'AWS RDS', 'Azure', 'GCP', 'CloudFormation',
]
const normSkill = (s) => String(s ?? '').toLowerCase().replace(/[\s　・\-_]/g, '')
const STRONG_SET = new Set(STRONG_INFRA_SKILLS.map(normSkill))

/** 本文に「基盤の仕事をした」と書いてあるか。役割名の名乗りとは別の信号。
 *  裸の「インフラ」は案件文にも出るので使わない（2026-09-19 の ROLE_DEFS 修正と同じ考え方）。 */
const INFRA_WORK_RE = /インフラ[　 ]?(?:エンジニア|構築|設計|運用|保守|移行|刷新|要件定義|基盤)|(?:サーバ|ネットワーク|NW)[　 ]?(?:構築|設計|運用|保守|移行)|基盤[　 ]?(?:構築|設計|移行)/

/** 1人分の特徴量を作る。**数値だけ**。氏名や本文は入れない（学習に不要で、扱いも重くなる） */
export function featurize(row) {
  const sbc = row.rp_skillsByCategory && typeof row.rp_skillsByCategory === 'object'
    ? row.rp_skillsByCategory : {}
  const cnt = {}
  for (const c of ALL_CATS) cnt[c] = Array.isArray(sbc[c]) ? sbc[c].length : 0
  const base_n = BASE_CATS.reduce((a, c) => a + cnt[c], 0)
  const dev_n = DEV_CATS.reduce((a, c) => a + cnt[c], 0)
  const total = ALL_CATS.reduce((a, c) => a + cnt[c], 0)
  const skills = Array.isArray(row.skills) ? row.skills : []
  const strongHits = skills.filter((s) => STRONG_SET.has(normSkill(s))).length

  return {
    ...Object.fromEntries(ALL_CATS.map((c) => [`cat_${c}`, cnt[c]])),
    base_n,
    dev_n,
    total_skills: total,
    // 比は 0..1。スキルが無い人は 0.5（どちらでもない）に寄せる
    base_ratio: base_n + dev_n > 0 ? base_n / (base_n + dev_n) : 0.5,
    strong_infra_skills: strongHits,
    experience_years: Number(row.experience_years ?? 0) || 0,
    age: Number(row.rp_age ?? 0) || 0,
  }
}

export const FEATURE_NAMES = [
  ...ALL_CATS.map((c) => `cat_${c}`),
  'base_n', 'dev_n', 'total_skills', 'base_ratio', 'strong_infra_skills',
  'experience_years', 'age',
]

/**
 * 弱教師のラベル関数（labeling functions）。
 * それぞれ独立した根拠で「基盤の人か」を判定する。1つも正解ではない。
 * @returns {{lf: Record<string, -1|0|1>, votes: number, abstains: number}}
 *          1=そう / -1=違う / 0=判断しない
 */
export function labelFunctions(row) {
  const f = featurize(row)
  const roles = Array.isArray(row.rp_roles) ? row.rp_roles : []
  const text = String(row.rp_text ?? '') + '\n' + String(row.rp_subject ?? '')

  const lf = {
    // ① 既存の語一致（再現率は低いが、付いていれば信頼できる）
    word_role: roles.includes('インフラエンジニア') ? 1 : 0,
    // ② スキル構成の比（実測の閾値。再現率は高いが粗い）
    skill_ratio: f.base_n >= 4 && f.base_ratio >= 0.6 ? 1
      : (f.base_n + f.dev_n >= 6 && f.base_ratio <= 0.25 ? -1 : 0),
    // ③ 基盤固有の技術がいくつ出るか（語を一度も書いていない人を拾う）
    strong_skills: f.strong_infra_skills >= 4 ? 1
      : (f.total_skills >= 8 && f.strong_infra_skills === 0 ? -1 : 0),
    // ④ 本文に基盤の仕事が書かれているか（役割名の名乗りとは別）
    work_text: INFRA_WORK_RE.test(text) ? 1 : 0,
  }
  const vals = Object.values(lf)
  return {
    lf,
    votes: vals.reduce((a, v) => a + v, 0),
    abstains: vals.filter((v) => v === 0).length,
  }
}

/**
 * 弱教師ラベルをまとめる。
 * 全部の「意見のある」関数が同じ向きなら確実（label 1/0）、割れたら null（＝claude -p 行き）。
 */
export function weakLabel(row) {
  const { lf, votes } = labelFunctions(row)
  const pos = Object.values(lf).filter((v) => v === 1).length
  const neg = Object.values(lf).filter((v) => v === -1).length

  // 全員が棄権 = そもそも判断材料が無い（スキルがほとんど取れていない人）。
  // 学習から外す。claude -p に回しても数値の材料が無いので、ここは抽出側の問題
  if (pos === 0 && neg === 0) return { label: null, reason: '信号なし', votes, lf }

  // 2つ以上が「そう」と言い、反対が無い → 確実な正例
  if (pos >= 2 && neg === 0) return { label: 1, reason: '一致(正)', votes, lf }
  // 反対が1つでもあり、賛成が無い → 確実な負例。
  // 負に振れる関数は2つしか無い（skill_ratio / strong_skills）ので 1票で足りる。
  // 「スキル8本以上あるのに基盤技術が1つも無い」は、それだけで十分強い根拠
  if (neg >= 1 && pos === 0) return { label: 0, reason: '一致(負)', votes, lf }

  // 賛成1つだけ、または賛成と反対が混在 → **ここが claude -p の出番**。
  // 数値だけでは決められず、文脈を読まないと分からない人たち
  return { label: null, reason: pos >= 1 && neg >= 1 ? '対立' : '弱い賛成のみ', votes, lf }
}

/** ローカル控えを読む。id 重複は後勝ち（更新されたもの） */
export function loadRows(dbRoot = DB_ROOT) {
  const byId = new Map()
  for (const f of fs.readdirSync(dbRoot).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dbRoot, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r?.id) byId.set(r.id, r)
    }
  }
  return [...byId.values()]
}

// ── CLI: ラベルの分布を見る ──
const { pathToFileURL } = await import('url')
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = loadRows()
  const byReason = new Map()
  const agree = new Map()
  for (const r of rows) {
    const w = weakLabel(r)
    byReason.set(w.reason, (byReason.get(w.reason) ?? 0) + 1)
    const key = Object.entries(w.lf).map(([k, v]) => `${k}:${v > 0 ? '+' : v < 0 ? '-' : '.'}`).join(' ')
    agree.set(key, (agree.get(key) ?? 0) + 1)
  }
  console.log(`控えの人数: ${rows.length}`)
  for (const [k, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    const note = k === '一致(正)' ? '  ← 学習の正例'
      : k === '一致(負)' ? '  ← 学習の負例'
      : k === '信号なし' ? '  ← スキルが取れていない。学習からも除外'
      : '  ← claude -p に回す'
    console.log(`  ${k.padEnd(10)}: ${String(n).padStart(5)}人${note}`)
  }
  console.log()
  console.log('■ ラベル関数の一致パターン 上位12（word_role / skill_ratio / strong_skills / work_text）')
  for (const [k, n] of [...agree].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(5)}人  ${k}`)
  }
}
