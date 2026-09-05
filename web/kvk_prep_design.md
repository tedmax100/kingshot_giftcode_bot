# KvK 前哨戰報名系統 — 設計文件（草案）

目的：讓玩家不用登入就能在 `kvk_calculator.html` 上登記角色資訊與有空時段，資料自動彙整進對應屆數的 GitHub issue，方便幹部在 admin page 檢視與排班。本文件只定流程與介面，尚未實作。

## 1. 整體流程

```
幹部（admin page，需登入）
   │  建立新一屆 KvK
   ▼
POST /api/kvk/rounds  ──────────────►  Worker  ──────────────►  GitHub Issue
   （帶 round=13）                     （驗證身分 + GH Token）    標題「KvK #13」
                                                                  label: kvk-prep
                                                                  |
                                                                  ▼
玩家（kvk_calculator.html#13，免登入）                      issue number 13x
   │  填角色ID / 名稱 / 聯盟 / 有空時段
   │  按送出
   ▼
POST /api/kvk/rounds/13/submissions ──►  Worker  ──────────────►  在該 issue
   （不需登入，但需基本防濫用檢查）        （驗證 + 格式化留言）    新增一則留言
                                                                  （結構化 markdown）
                                                                  |
                                                                  ▼
幹部回到 admin page
   │  讀取這一屆的所有留言
   ▼
GET /api/kvk/rounds/13/submissions ──►  Worker 讀取 issue 留言 ──► 解析回結構化 JSON
   │
   ▼
admin page 顯示名單、依時段分組、可標記已排班
```

沿用現有 `worker/`（Cloudflare Worker）架構：它已經有 `GH_OWNER` / `GH_REPO` / `GITHUB_TOKEN`（GitHub PAT）、Google OAuth 登入 + `ALLOWED_EMAILS` 白名單（跟開通行證/改名單同一套），以及 CORS 設定。新功能是在同一個 Worker 裡加路由，不需要另外架服務。

## 2. 為什麼一定要經過後端，不能前端直接打 GitHub API

瀏覽器沒有安全的方式呼叫 GitHub REST API 建立 issue 或留言：
- 建立 issue／留言需要一個有 `Contents`/`Issues` 寫入權限的 PAT，這個 token 絕對不能放進公開網頁的 JS。
- 就算用 GitHub App + 使用者自己的 OAuth，也還是要玩家登入 GitHub 帳號，違反「不用登入」的需求。

所以中間必須有一層你控制的伺服器代打 GitHub API——這正是現有 Worker 在做的事（`/api/csv`、`/api/redeem` 都是同樣模式：前端呼叫 Worker，Worker 用自己的 GITHUB_TOKEN 去動 GitHub）。

## 3. 資料模型

### 3.1 一屆 KvK = 一個 GitHub Issue

- 建立時機：幹部在 admin page 按「開新一屆」。
- Issue 標題：`KvK #13`
- Label：`kvk-prep`（用來搜尋/篩選，不會跟其他 issue 混淆）
- Issue body（建立時寫入，之後不再修改，純粹當作說明）：
  ```markdown
  ## KvK #13 前哨戰報名

  報名頁：https://tedmax100.github.io/kingshot_giftcode_bot/kvk_calculator.html#13

  幹部請在下方留言中查看玩家登記資料。
  ```
- Round → Issue number 的對應：不能假設 issue number 就是屆數（GitHub issue number 是全 repo 遞增、不受你控制），所以要靠 **label + 標題搜尋** 來找：
  `GET /search/issues?q=repo:{owner}/{repo}+label:kvk-prep+"KvK #13" in:title`
  Worker 內部做這個查詢並快取結果（或乾脆在建立時把 `round → issue number` 存一份小 JSON 回 repo，例如 `kvk_rounds.json`，這樣查詢更快、更穩定，不依賴 GitHub 搜尋 API 的即時性）。

  **建議**：直接維護 `kvk_rounds.json`（放在 repo 內），跟現有 `kingshot_players.csv` 用同一套「Worker 讀寫 GitHub Contents API」機制。這樣查 round 對應的 issue number 是一次 Contents API GET，不吃 Search API 的速率限制。

  為了支援第 8 節的「活動結束排程」，`kvk_rounds.json` 除了 issue number 外還要存**開始日期**，格式改為：
  ```json
  {
    "13": {
      "issue": 187,
      "startDate": "2026-09-07",
      "status": "open"
    }
  }
  ```
  - `startDate`：幹部建立這一屆時輸入（活動開始那天，例如週一），格式 `YYYY-MM-DD`（Asia/Taipei）。
  - `status`：`open` / `closed`，由第 8 節的排程或幹部手動更新。

### 3.2 一筆玩家登記 = 一則 Issue 留言

留言內容用固定格式，方便之後用程式解析回結構化資料，例如包一段 `<details>` + JSON：

```markdown
### 🧑‍🚀 叮叮蛋（ID: 143080583，聯盟: NuB）

**Day 1**：08:00–09:30, 20:00–21:30
**Day 2**：（未登記）
**Day 4**：13:00–15:00

<details>
<summary>raw</summary>

​```json
{
  "round": 13,
  "playerId": "143080583",
  "playerName": "叮叮蛋",
  "guild": "NuB",
  "submittedAt": "2026-09-04T12:00:00.000Z",
  "availability": {
    "day1": [0, 1, 24, 25],
    "day2": [],
    "day4": [10, 11, 12, 13]
  }
}
​```
</details>
```

- `availability` 的值是 30 分鐘時段的**格子編號**（0-47），跟 `kvk_calculator.html` 現有的時段選擇格一致：編號 0 = 當天 08:00，每 +1 代表再過 30 分鐘，編號 32 起（00:00）算隔天（顯示時標成 `+1`）。用編號而不是時間字串，是因為前端本來就用格子索引存 `localStorage`，直接沿用同一套資料格式最省事，也不會有時間字串跨午夜排序出錯的問題。Worker 收到後會用 `slotsToRanges()` 轉成人看得懂的「08:00–09:00」這種範圍字串放進留言摘要。
- 人看得懂的摘要在上面，機器解析用的 JSON 包在 `<details>` 裡（不會干擾閱讀，admin page 抓留言後解析 JSON 區塊即可）。
- 同一位玩家重複送出時：Worker 收到相同 `playerId` + `round` 就編輯（PATCH）原本那則留言，而不是一直新增留言洗版。GitHub API 支援 `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`，所以 Worker 需要先查這個 round 底下有沒有這個 playerId 的舊留言（用留言內文比對 JSON 裡的 `playerId`），有就更新、沒有就新增。

## 4. API 端點（加在既有 Worker）

| 方法 | 路徑 | 身分要求 | 說明 |
|---|---|---|---|
| POST | `/api/kvk/rounds` | 需登入（沿用現有 Google OAuth + ALLOWED_EMAILS） | 建立新一屆：開 issue、寫入 `kvk_rounds.json` |
| GET | `/api/kvk/rounds/:round` | 公開 | 回傳該屆 issue number、標題、報名頁連結（給前端顯示用） |
| POST | `/api/kvk/rounds/:round/submissions` | 公開（需基本防濫用） | 玩家送出登記，Worker 格式化後新增或更新該玩家的留言 |
| GET | `/api/kvk/rounds/:round/submissions/:playerId` | 公開 | 玩家用自己的角色 ID 查回上次登記的內容（回填表單用），查無資料回 404 |
| GET | `/api/kvk/rounds/:round/submissions` | 需登入 | 讀取該屆 issue 全部留言，解析回結構化 JSON 陣列給 admin page |
| POST | `/api/kvk/rounds/:round/close` | 服務用 token（見第 8 節） | 幫該屆 issue 加 `kvk-prep-closed` label 並關閉 issue，更新 `kvk_rounds.json` 的 `status` |

## 5. 前端改動

### 5.1 `kvk_calculator.html`

- 用 `location.hash`（例如 `#13`）取得屆數，頁面載入時呼叫 `GET /api/kvk/rounds/13` 確認這屆存在（不存在就顯示「這屆尚未開放報名」）。
- 角色 ID 輸入框失焦（或按下查詢）時呼叫 `GET /api/kvk/rounds/13/submissions/{playerId}`：
  - 200：回填名稱／聯盟／每天的時段勾選狀態，並顯示「上次登記於 {submittedAt}，可直接修改後重新送出」。
  - 404：代表這個 ID 這屆還沒登記過，維持空白表單即可。
  - 這一步是為了讓玩家換裝置、清過 `localStorage`，或活動期間任何時候重新打開頁面，都能看到自己上次填的資料，不用只靠瀏覽器本機記憶。
- 現有的角色ID／名稱／聯盟／有空時段 UI 不變，只是新增一個「送出登記」按鈕：
  - 蒐集目前狀態（playerId、playerName、guild、每天的 availability）
  - `POST /api/kvk/rounds/13/submissions`
  - 成功後顯示「已登記，若時段有更新可重新送出」，並保留本機 localStorage 當作草稿（重整頁面不用重填）。
- 因為不需要登入，要做基本防濫用：
  - 前端限流（例如送出後按鈕 disable 5 秒）
  - Worker 端可加 Cloudflare Turnstile（免費、不需登入）擋機器人，或至少做簡單 rate limit（同 IP 每分鐘限次數）。

### 5.2 Admin page（新頁面，例如 `web/kvk_admin.html`）

- 需登入（沿用現有 Google OAuth 流程，跟改名單的 admin 頁一樣）。
- 開新一屆：輸入屆數 → 呼叫 `POST /api/kvk/rounds`。
- 選一屆 → `GET /api/kvk/rounds/13/submissions` → 畫面用時段 × 玩家的表格呈現，方便看哪個時段人多、可以排班。
- 排班結果目前先不寫回 GitHub（避免把 issue 留言當資料庫用到太複雜），可以先讓幹部人工排完後另外貼公告；之後有需要再考慮加「排班結果」欄位寫回同一則留言或開新留言。

## 6. 已知取捨與風險

- **GitHub issue 不是資料庫**：留言數一多、或需要複雜查詢（例如跨屆比較），解析留言會越來越吃力。目前規模（一屆數十人登記）可以接受；如果之後量變大，建議改成 Worker 搭配 KV / D1 存結構化資料，issue 留言只當作「人類可讀的公告紀錄」。
- **匿名登記 = 無法驗證身分**：任何人都可以用別人的角色 ID 登記或竄改。緩解方式：
  - 送出時要求同時輸入角色 ID（已在計算機裡做比對），但不保證是本人。
  - 可考慮日後接入遊戲內驗證（例如要求玩家在遊戲內聯盟頻道貼一組驗證碼），目前先接受這個風險，比照「登記制」而非「身分驗證制」。
- **Round → Issue 對應方式**：務必落地成 `kvk_rounds.json`（Contents API 讀寫），不要單靠 GitHub Search API 現查，避免 rate limit 或索引延遲造成「找不到這屆」的假錯誤。
- **留言更新的併發問題**：兩個人幾乎同時送出時，Worker 若用「先讀留言列表找是否已存在→決定新增或更新」這個流程，理論上有 race condition（兩個請求同時判定「不存在」而都新增）。因為量體小（人工登記，不會真的同時間大量湧入），先接受風險；真要嚴謹可以在 Worker 內用 `playerId` 做簡單的記憶體/KV lock。

## 8. 活動結束排程（startDate + 5 天截止）

因為幹部通常會提早開始收集登記，所以報名截止不是活動當天，而是 `startDate + 5 天`（`startDate` 是建立這一屆、開放報名的那天）。結束時要能讓 issue 一眼看出「已截止」，不能再被誤認成還開放中：

- **多一個 label 標示結束**：新增 `kvk-prep-closed` label（與 `kvk-prep` 並存，不取代），並把 issue 狀態設為 `closed`。這樣列表頁一看 label 顏色/名稱、或 issue 是否被關閉，就知道是否還在報名。
- **判斷時機**：`startDate + 5 天`。因為 Worker 本身是被動的（只在收到 HTTP request 時執行，沒有排程能力），所以需要一個外部排程來源定時去戳它——這裡選擇用 **GitHub Actions 排程**（跟現有 `bulk_redeem.yml` 同一模式，方便在同一個 repo 的 Actions 頁面看到所有排程工作），而不是 Cloudflare Worker 自帶的 Cron Trigger。

### 8.1 新增 Worker 端點：`POST /api/kvk/rounds/:round/close`

- 身分要求：**服務用 token**，不是 Google OAuth（GitHub Actions 沒有使用者登入這回事）。用一個新的 Worker secret，例如 `KVK_CLOSE_TOKEN`，Action 呼叫時帶 `Authorization: Bearer <token>`，Worker 比對相符才放行。這個 token 只給這一個端點用，不要跟 `GITHUB_TOKEN`（操作 GitHub API 用的 PAT）搞混。
- 行為：
  1. 讀 `kvk_rounds.json` 找到這個 round 的 issue number。
  2. 若 `status` 已經是 `closed`，直接回 200（冪等，Action 重複呼叫也不會出錯）。
  3. 呼叫 GitHub API 幫 issue 加上 `kvk-prep-closed` label（`POST /repos/{owner}/{repo}/issues/{issue}/labels`）。
  4. 呼叫 GitHub API 關閉 issue（`PATCH /repos/{owner}/{repo}/issues/{issue}`，`state: closed`）。
  5. 更新 `kvk_rounds.json` 該 round 的 `status` 為 `closed`。
- 也可以額外支援「不帶 round 直接呼叫，Worker 自己掃描 `kvk_rounds.json` 裡所有 `status: open` 且 `startDate + 5天 <= 今天（Asia/Taipei）` 的屆數逐一關閉」，這樣 GitHub Actions 那邊不用知道目前開了哪幾屆、也不用自己算日期，只要每天定時戳一次即可。**建議採用這個做法**，Action 只需要無腦呼叫，判斷邏輯全部留在 Worker。

### 8.2 新增 GitHub Actions workflow：`.github/workflows/kvk_prep_close.yml`

草稿（放在 `.github/workflows/`，比照 `bulk_redeem.yml` 的排程寫法）：

```yaml
name: Close finished KvK prep rounds

on:
  schedule:
    # 每天 09:00 Asia/Taipei (UTC+8) == 01:00 UTC
    # 選一個當天已經確定「5 天到期」的時間點執行即可，不用太準
    - cron: "0 1 * * *"
  workflow_dispatch: {}

jobs:
  close:
    runs-on: ubuntu-latest
    steps:
      - name: Call Worker close endpoint
        env:
          KVK_CLOSE_TOKEN: ${{ secrets.KVK_CLOSE_TOKEN }}
        run: |
          curl -fsS -X POST \
            -H "Authorization: Bearer ${KVK_CLOSE_TOKEN}" \
            "https://<your-worker-domain>/api/kvk/rounds/close-due"
```

- `secrets.KVK_CLOSE_TOKEN`：repo secret，跟 Worker 端的 `KVK_CLOSE_TOKEN` 用同一個值（在 Cloudflare Worker 那邊用 `wrangler secret put KVK_CLOSE_TOKEN` 設定）。
- 路徑用 `/api/kvk/rounds/close-due`（掃描全部到期的屆數），不用帶特定 round number，對應 8.1 建議的「Worker 自己掃描」做法。
- 不需要 `contents: write` 權限（不像 `bulk_redeem.yml` 會 commit 檔案回 repo），這個 workflow 只是單純打一支 API，`permissions` 可以留預設或明確寫 `contents: read`。

### 8.3 admin page 的手動保險

排程有可能因為 GitHub Actions 延遲、Worker 掛掉等原因沒準時觸發。admin page（`kvk_admin.html`）上也放一顆「結束本屆」按鈕，直接呼叫同一個 close 端點（帶 round number 的版本，`POST /api/kvk/rounds/:round/close`），讓幹部隨時能手動關閉，不用完全依賴排程。

## 9. 后續實作順序建議

1. ~~Worker：加 `kvk_rounds.json` 讀寫（含 `startDate` / `status` 欄位）+ `POST /api/kvk/rounds`（建立 issue，要求輸入開始日期）。~~ 已完成。
2. ~~Worker：加 `POST /api/kvk/rounds/:round/submissions`（新增/更新留言）。~~ 已完成（另外多加了 `GET /api/kvk/rounds/:round/submissions/:playerId` 查自己上次登記）。
3. ~~`kvk_calculator.html`：加送出按鈕與呼叫邏輯。~~ 已完成。
4. ~~Worker：加 `GET /api/kvk/rounds/:round/submissions`（解析留言回 JSON）。~~ 已完成。
5. ~~新增 `kvk_admin.html`：建立新屆 + 檢視登記名單 + 手動「結束本屆」按鈕。~~ 已完成。
6. ~~Worker：加 `POST /api/kvk/rounds/close-due`（掃描到期屆數並關閉）+ 設定 `KVK_CLOSE_TOKEN` secret。~~ 已完成程式碼，secret 仍需部署時設定。
7. ~~新增 `.github/workflows/kvk_prep_close.yml`（每日排程呼叫 close-due）。~~ 已完成。
8. 視需要再談：防濫用（Turnstile / rate limit）、排班結果回寫。

**尚未做的（部署前必須）**：
- `wrangler secret put KVK_CLOSE_TOKEN`，並在 repo secrets 設同樣的值。
- `GITHUB_TOKEN` 這個 PAT 補上 `Issues: Read and write` 權限（目前只有 Contents，建 issue/留言會 403）。
- repo variable `KVK_WORKER_URL`（給 `kvk_prep_close.yml` 用）。
- `kvk_admin.html` / `kvk_calculator.html` 頂部的 `WORKER_URL` / `GOOGLE_CLIENT_ID` 已比照 `index.html` 填好正式值，不用再改；但整條流程還沒有實際部署 Worker 後端對測過。
