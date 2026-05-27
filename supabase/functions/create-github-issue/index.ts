// GitHub Issues API Edge Function
// POST: Issue作成
// GET:  Issue一覧取得（state=all, label=bug）

const REPO = 'kzmiyamura/akinavi-hr-ai-aws'
const GITHUB_API = 'https://api.github.com'

function githubHeaders(token: string) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'akinavi-hr-ai',
  }
}

Deno.serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    })
  }

  const token = Deno.env.get('GITHUB_TOKEN')
  if (!token) {
    return json({ error: 'GITHUB_TOKEN not configured' }, 500)
  }

  // GET: Issue一覧
  if (req.method === 'GET') {
    const res = await fetch(
      `${GITHUB_API}/repos/${REPO}/issues?state=all&labels=bug&per_page=20&sort=created&direction=desc`,
      { headers: githubHeaders(token) }
    )
    if (!res.ok) {
      const err = await res.text()
      return json({ error: err }, res.status)
    }
    const issues = await res.json()
    const result = issues.map((i: Record<string, unknown>) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      html_url: i.html_url,
      created_at: i.created_at,
    }))
    return json(result, 200)
  }

  // POST: Issue作成
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const { memo, url, userAgent, nickname, timestamp } = body as Record<string, string>

    if (!memo?.trim()) {
      return json({ error: 'memo is required' }, 400)
    }

    // タイトル: 先頭50文字
    const firstLine = memo.trim().split('\n')[0].slice(0, 50)
    const title = `[Bug] ${firstLine}`

    const issueBody = `## 報告内容

${memo.trim()}

## 環境情報

| 項目 | 値 |
|---|---|
| 日時 | ${timestamp ?? new Date().toISOString()} |
| URL | ${url ?? ''} |
| ニックネーム | ${nickname ?? ''} |
| UserAgent | ${userAgent ?? ''} |
`

    const res = await fetch(`${GITHUB_API}/repos/${REPO}/issues`, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({
        title,
        body: issueBody,
        labels: ['bug'],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return json({ error: err }, res.status)
    }

    const issue = await res.json() as Record<string, unknown>
    return json({
      number: issue.number,
      title: issue.title,
      html_url: issue.html_url,
      state: issue.state,
    }, 201)
  }

  return json({ error: 'Method not allowed' }, 405)
})

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
