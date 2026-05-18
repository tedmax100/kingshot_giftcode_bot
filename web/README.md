# Web UI 部署步驟

`web/index.html` 是一個純靜態頁,讓允許名單內的 Google 使用者可以新增 / 刪除玩家
ID。儲存按鈕會把更新後的 `kingshot_players.csv` 透過 Cloudflare Worker commit 回
本 repo,下次的 GitHub Actions 排程就會用新名單。

整個鏈路:

```
瀏覽器 ── Google ID Token ──▶ Cloudflare Worker ── PAT ──▶ GitHub Contents API
   ▲                              │
   └──── GitHub Pages 服務 ◀──────┘ (deploy by .github/workflows/pages.yml)
```

## 1. Google Cloud Console:建立 OAuth Web Client

1. https://console.cloud.google.com → APIs & Services → Credentials
2. 「Create credentials → OAuth client ID」→ Application type: **Web application**
3. **Authorized JavaScript origins** 加入:
   - `https://tedmax100.github.io`
   - (本機測試用) `http://localhost:8080`
4. 拿到 `Client ID`(類似 `123-xxx.apps.googleusercontent.com`)

## 2. Cloudflare:部署 Worker

```bash
cd worker
npm install
npx wrangler login            # 第一次需登入
npx wrangler secret put GITHUB_TOKEN      # 貼上 PAT(repo Contents 寫入權)
npx wrangler secret put GOOGLE_CLIENT_ID  # 貼上上一步的 Client ID
npx wrangler secret put ALLOWED_EMAILS    # 例: tedmax100@gmail.com,friend@gmail.com
npx wrangler secret put ALLOWED_ORIGINS   # 例: https://tedmax100.github.io
npx wrangler deploy
```

部署完會印出 Worker URL,類似 `https://kingshot-csv.xxx.workers.dev`。

### GitHub PAT 建議:fine-grained token,只授權本 repo

- 範圍: Repository access → Only select repositories → `kingshot_giftcode_bot`
- Repository permissions → **Contents: Read and write**
- 其他全部 No access

## 3. 填回 index.html

打開 `web/index.html`,把這兩行的值換掉:

```js
window.GOOGLE_CLIENT_ID = "REPLACE_WITH_GOOGLE_CLIENT_ID";
window.WORKER_URL       = "REPLACE_WITH_WORKER_URL";
```

commit + push,`.github/workflows/pages.yml` 會自動部署到 GitHub Pages。

## 4. GitHub Settings → Pages

第一次部署前需要把 Pages 來源切到「GitHub Actions」:

1. Repo Settings → Pages
2. Source: **GitHub Actions**
3. 等 `Deploy Pages (web/)` workflow 跑完,網址會是
   `https://tedmax100.github.io/kingshot_giftcode_bot/`

## 安全模型

- Worker 是唯一持有 GitHub PAT 的地方;PAT 不會出現在瀏覽器或頁面原始碼。
- 任何請求都要附 Google ID Token,Worker 會打 Google 的 tokeninfo 驗證簽章,
  並比對 `aud == GOOGLE_CLIENT_ID` 與 `email ∈ ALLOWED_EMAILS`。
- `ALLOWED_ORIGINS` 限制只允許特定來源呼叫(CORS),減少從他處 fetch 的可能性。
  注意:`Origin` header 可由 server-side 工具偽造,所以這只是基本的瀏覽器保護,
  真正的身份檢查靠 ID Token + email allowlist。
