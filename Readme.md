# 目前部署設定

## Node.js 與 MadMapper

- 執行環境需為 `Node.js >= 18.1`。在本專案根目錄先執行 `npm ci`；沒有 lockfile 的情況才改用 `npm install`。
- `madmapper.config.json` 是 MadMapper OSC 的唯一部署設定來源。請在 Node JSON 內修改 `ip`、`port`、`localPort`，以及每個區域完整的 `oscAddress`；OSC Address 不在 Unity Inspector 編輯。
- 區域依投影方案分組，寫在 `profiles.<id>.areas`；工作燈寫在全域的 `lights`。舊格式（頂層 `areas`）會讓伺服器拒絕啟動，請改成新格式。
- s2（2026-07 版）的六個固定名稱依序為 `Main`、`T1`、`T2`、`T3`、`T4`、`Ground`。預設位址分別是 `/surfaces/Main/opacity`、`/surfaces/T1/opacity`、`/surfaces/T2/opacity`、`/surfaces/T3/opacity`、`/surfaces/T4/opacity`、`/surfaces/Ground/opacity`。完整 `oscAddress` 字串皆可依 MadMapper 實際命名修改。
- 首次啟動可執行 `npm start`（等同 `node integrated-server.js`）。修改 JSON 後必須重啟 Node：使用 PM2 時執行 `pm2 restart <應用程式名稱>`；直接啟動時先停止舊程序，再重新執行啟動指令。
- s1（2026-03 版）沿用當時的 15 個 surface：`Main-1`、`T1-1`～`T7-1`（模式一，預設開）與 `Main-2`、`T2-2`～`T7-2`（模式二，預設關），位址為 `/surfaces/<名稱>/opacity`。
- Node.js 負責傳送 OSC 給 MadMapper；Unity 不會傳送 OSC，也不需要安裝 Unity OSC 套件。

## Unity 九座位設定（s2）

- 本節描述 s2。s1 為 8 席，座位順序由 Node 轉成 2026-03 版要的反轉順序（座位 1 → Region 7），s1 的 Unity 不需設定。
- Unity 實際控制檔位於 `Assets/Script/Singleton/UnityModeController.cs`，其 `SeatCount = 9`。
- WebSocket 的直接座位對應為 `Seat1` → `0`、`Seat2` → `1`、`Seat3` → `2`、`Seat4` → `3`、`Seat5` → `4`、`Seat6` → `5`、`Seat7` → `6`、`Seat8` → `7`、`Seat9` → `8`。
- 在 `RegionManager` 新增 `Region ID 8`，並在 `CloudMaterials` 加入第九個材質，也就是 `CloudMaterials[8]`。
- 如第九區需要區域特效，請在 `RegionVFX` 設定中加入 `RegionId = 8`，並依專案使用的狀態補齊對應清單。
- `RegionManager` 缺少 index 8 時執行時仍安全，但第九座位不會產生對應視覺效果，直到設定完成。
- 當 Region 或 CloudMaterials 設定數量未達至少 9 時，每個 `UnityModeController` 生命週期只顯示一次警告。

## Web 部署

Web 伺服器必須同時部署 `interface/console.html` 與 `interface/control-settings.js`；只部署 HTML 會使控制設定無法載入。

控制台預設連 `192.168.0.201`（現場的 Node）。辦公室或本機測試不必改原始碼，在網址加 `?server=`，例如 `console.html?server=10.0.1.251` 或 `console.html?server=127.0.0.1`。

## 投影方案切換（s1／s2）

控制台最上方的「投影方案」可以切換兩套投影方式與內容：

| 方案 | 內容 | Unity | MadMapper surface |
|---|---|---|---|
| s1 | 2026-03 版（`release/s1`，`dadf77a`） | `C:\Room\S1\RoomS1.exe`，單一實例 | 15 個 `*-1`／`*-2` |
| s2 | 2026-07 版（`main`） | `C:\Room\S2\RoomS2.exe`，tables 與 ground 兩個實例 | 六區 |

可執行檔名稱分別是 `RoomS1.exe` 與 `RoomS2.exe`。

切換流程：熄掉兩個方案的所有區域 → 關掉舊的 Unity、啟動新的 → 等新方案的每個實例都連上 → 等畫面穩定 → 恢復新方案的區域。全程約 1–2 分鐘，期間全場黑畫面、除了工作燈之外的控制都會暫停。兩個方案各自保存背景、座位、遮罩與區域開關，切回來時恢復上次的狀態。

### 主機與設定檔

| 主機 | 角色 | 設定檔 |
|---|---|---|
| 192.168.0.201 | Node 控制伺服器（WebSocket 3000）與控制台 | `profiles.config.json`（方案、Unity 協定差異、等待時間、agent 位址）、`madmapper.config.json` |
| 192.168.0.202 | Unity、MadMapper、room-agent（WebSocket 3100） | `agent/agent.config.json`（exe 路徑與啟動參數） |

- 兩台都要設定相同的 `ROOM_AGENT_TOKEN`（使用者層級環境變數）。它優先於設定檔裡的 `token`，真正的值不要提交進 git。
- room-agent 只會啟動 `agent/agent.config.json` 列出的 exe；Node 只能指定「哪個方案」，不能指定執行檔。
- agent 啟動前會讀 exe 同目錄的 `build-info.json`，`build` 與方案不符就拒絕，現場正在播的方案不會被關掉。

### 建置 Unity

兩個方案都用同一支建置腳本，會在 exe 旁寫出 `build-info.json`：

```bash
"C:\Program Files\Unity\Hub\Editor\6000.0.70f1\Editor\Unity.exe" -batchmode -quit -projectPath "<Unity 專案或 s1 worktree>" -executeMethod RoomPlayerBuild.BuildFromCommandLine -roomBuildOutput "C:\Room\S2\RoomS2.exe" -roomBuildCommit <git short hash> -logFile build.log
```

- s1 從 `release/s1` 分支（建議用獨立的 git worktree）建置，輸出改成 `C:\Room\S1\RoomS1.exe`。
- 專案設定的後端是 IL2CPP，現場版本請用 IL2CPP 建置。沒有安裝 IL2CPP 模組的機器可加 `-roomScriptingBackend mono` 做測試用建置，後端會記在 `build-info.json`。
- 兩個 build 預設都連 `ws://192.168.0.201:3000`；辦公室測試用命令列參數 `-roomServerUrl` 覆寫，例如 `-roomServerUrl ws://10.0.1.251:3000`。

### 安裝 room-agent（192.168.0.202）

1. 安裝 `Node.js >= 18.1`，把本 repo clone 到 `C:\Room\remote`，執行 `npm ci --omit=dev`。
2. 放好 `C:\Room\S1\`、`C:\Room\S2\`（含 `build-info.json`），建立 `C:\Room\logs\`。
3. 停用舊的 Unity 自動啟動（啟動資料夾、工作排程器、捷徑），否則會和 agent 啟動的 Unity 搶 UDP 9000。
4. 防火牆只開給 201：

   ```bash
   netsh advfirewall firewall add rule name="Room Agent" dir=in action=allow protocol=TCP localport=3100 remoteip=192.168.0.201
   ```

5. 登入時自動啟動。必須在使用者工作階段執行，不可做成 Windows Service，否則 Unity 沒有桌面可以開視窗：

   ```bash
   schtasks /Create /TN "RoomAgent" /TR "\"C:\Program Files\nodejs\node.exe\" C:\Room\remote\agent\room-agent.js" /SC ONLOGON /RL LIMITED /F
   ```

6. 在 201 檢查：`npm run agent:ping -- ws://192.168.0.202:3100`。成功時印出方案清單與正在執行的 process。

Node 連上 agent 後會自動確保目前方案在跑；現場重開機後只要兩台都登入，畫面就會自己回來。

### 切換失敗與當機

- 切換失敗時區域維持關閉，控制台顯示失敗的步驟與原因，可以按「重試」或「回到原方案」。系統不會自動反覆重試。
- Unity 非預期結束時，控制台顯示警告與「重新啟動目前方案」按鈕；同樣不會自動重啟。
- agent 離線時無法切換，控制台的投影方案卡片會顯示「代理離線」。

### 辦公室測試

- `npm run fake-site`：不接 Unity、MadMapper 與 agent，用假的 Unity 跑完整切換流程。再以靜態網站伺服器開 `interface/`，瀏覽器開 `console.html?server=127.0.0.1`。
- 整機演練時，可用 `ROOM_CONFIG_DIR` 指定另一份 Node 設定檔目錄、`ROOM_AGENT_CONFIG` 指定另一份 agent 設定檔，不必改動 repo 裡的檔案。

## Logo 疊圖

- 控制台的「Logo 疊圖」卡片：上傳 PNG／JPEG（透明背景用 PNG，上限 4 MB；超過 2048 px 的圖瀏覽器會先縮小）、開關、大小、角度、水平／垂直位置。
- Logo 疊在桌面輸出最上層（s2 的 `Room_Tables`、s1 的 `Spout Sender`），地面不疊。s1、s2 共用同一張圖與同一組設定，切換方案不會改變；切換途中也可以操作。
- 圖存在 `system_state.json` 旁邊的 `room-logo.png` 或 `room-logo.jpg`（已加入 `.gitignore`），狀態檔只記 `logo.imageId`。搬機器時兩個檔案要一起帶走；只有狀態檔沒有圖時，Node 啟動會把 Logo 清掉並關閉。
- 協定：控制台送 `uploadLogo`、`logoControl`、`removeLogo`、`requestLogoImage`；Node 廣播 `logoUpdate`（設定）與 `logoImage`（圖，base64），`systemStateUpdate.state.logo` 也帶設定。細節見 `logo-model.js`。
- Unity 端需要含 `RoomLogoOverlay` 的 build（main 與 release/s1 都要重新建置）；舊 build 收到這些訊息會直接忽略。

---

# Unity 遠端控制系統 - 部署指南

## 📋 系統架構

```
手機/平板網頁 <--WebSocket--> Node.js 伺服器（201）<--WebSocket--> Unity（202）
                                   │  └──WebSocket 3100──> room-agent（202，啟停 Unity）
                                   └──OSC──> MadMapper（202）
```

---

## 🚀 步驟 1：設置 Node.js 伺服器

### 1.1 啟動目前專案

安裝 `Node.js >= 18.1`，在目前已簽入的專案根目錄執行：

```bash
npm ci
# 沒有 lockfile 時才使用 npm install
```

接著編輯 `madmapper.config.json`，再啟動整合伺服器：

```bash
npm start
# 或 node integrated-server.js
```

### 1.2 查看內網 IP
**Windows:**
```bash
ipconfig
```
尋找「IPv4 位址」，例如：`192.168.1.100`

**Mac/Linux:**
```bash
ifconfig
# 或
ip addr show
```

---

## 📱 步驟 2：部署網頁介面

### 2.1 伺服器位址
控制台預設連現場的 `192.168.0.201`。連其他主機時在網址加 `?server=`（只寫主機名稱或 IP，不要加 `ws://` 或連接埠），例如：

```text
http://192.168.0.201:8080/?server=192.168.1.100
```

### 2.2 部署必要檔案

網頁介面不是單一 HTML 檔案。部署時必須保持下列兩個檔案位於同一個目錄：

- `interface/console.html`
- `interface/control-settings.js`

### 2.3 靜態網站伺服器設定

使用 IIS、Apache、Nginx 或其他靜態網站伺服器，並將專案的 `interface/` 目錄設為網站根目錄。設定必須符合以下條件：

- `/` 回傳 `console.html`。
- `/control-settings.js` 回傳同目錄中的 `control-settings.js`，不可把找不到的路徑一律回傳 HTML。
- `.html` 使用 `text/html`，`.js` 使用 `application/javascript`（或 `text/javascript`）。
- 將要求的路徑正規化並限制在 `interface/` 根目錄內；包含 `..`、編碼後的 traversal 或解析後位於根目錄外的要求必須回傳 `403` 或 `404`。

完成後可從 `http://192.168.1.100:8080/` 開啟控制台。瀏覽器開發者工具中，`/control-settings.js` 應回傳 JavaScript 與成功狀態碼。

---

## 🎮 步驟 3：設置 Unity

### 3.1 安裝 WebSocket 套件

使用 **Package Manager** 安裝：

1. 打開 Unity
2. Window → Package Manager
3. 點擊左上角 `+` → Add package from git URL
4. 輸入：
   ```
   https://github.com/endel/NativeWebSocket.git#upm
   ```

### 3.2 使用現有控制器

請依上方「目前部署設定」使用既有的 `Assets/Script/Singleton/UnityModeController.cs`，不要另建或複製控制器腳本。

---

## ✅ 步驟 4：測試系統

### 4.1 啟動順序
1. 啟動 Node.js 伺服器（201）
2. 確認 room-agent 在 202 執行；Node 連上後會自動啟動目前方案的 Unity
3. 用手機開啟網頁，投影方案卡片應顯示「代理已連線」與已連線的 Unity

### 4.2 驗證連接
- 網頁應顯示「已連接」綠色狀態
- Unity Console 應顯示「✅ WebSocket 已連接」

### 4.3 測試切換
- 在手機上點擊任一模式按鈕
- Unity Console 應顯示模式切換訊息
- Unity 場景應即時改變

---

## 🔧 常見問題

### Q1: 網頁無法連接到伺服器
- 檢查防火牆是否允許 3000 port
- 確認手機和電腦在同一個區域網路
- 確認 IP 位址正確

**Windows 防火牆設定：**
```bash
netsh advfirewall firewall add rule name="Unity Control" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="Unity Web" dir=in action=allow protocol=TCP localport=8080
```

### Q2: Unity 無法連接
- 檢查 `serverUrl` 是否正確
- 檢查 NativeWebSocket 套件是否安裝成功
- 查看 Unity Console 錯誤訊息

### Q3: 手機找不到網頁
- 確認網頁伺服器已啟動
- 在電腦瀏覽器先測試 `http://localhost:8080`
- 確認手機連接到相同 Wi-Fi

---

## 🎯 進階功能建議

### 1. 持久化當前模式
在伺服器加入檔案儲存：
```javascript
const fs = require('fs');
fs.writeFileSync('mode.json', JSON.stringify({ mode: currentMode }));
```

### 2. 加入身份驗證
防止未授權存取：
```javascript
ws.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.token !== 'YOUR_SECRET_TOKEN') {
        ws.close();
        return;
    }
    // 處理訊息...
});
```

### 3. 多台 Unity 控制
為每個 Unity 實例分配 ID：
```javascript
const unityClients = new Map();

ws.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'register') {
            unityClients.set(data.unityId, ws);
        }
    });
});
```

---

## 📊 系統優勢

✅ **即時響應** - WebSocket 推送，無延遲  
✅ **低資源消耗** - 不需要輪詢  
✅ **連線狀態可視** - 即時顯示連接狀況  
✅ **易於擴展** - 可輕鬆加入更多功能  
✅ **跨平台** - 任何有瀏覽器的裝置都能使用  

---

## 🆘 需要幫助？

如果遇到問題：
1. 檢查所有 Console 的錯誤訊息
2. 確認網路連接狀態
3. 使用 `ping` 指令測試網路連通性
4. 檢查防火牆設定
