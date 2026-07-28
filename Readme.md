# 目前部署設定

## Node.js 與 MadMapper

- 執行環境需為 `Node.js >= 18.1`。在本專案根目錄先執行 `npm ci`；沒有 lockfile 的情況才改用 `npm install`。
- `madmapper.config.json` 是 MadMapper OSC 的唯一部署設定來源。請在 Node JSON 內修改 `ip`、`port`、`localPort`，以及每個區域完整的 `oscAddress`；OSC Address 不在 Unity Inspector 編輯。
- 六個固定名稱依序為 `Main`、`T1`、`T2`、`T3`、`T4`、`Ground`。預設位址分別是 `/surfaces/Main/opacity`、`/surfaces/T1/opacity`、`/surfaces/T2/opacity`、`/surfaces/T3/opacity`、`/surfaces/T4/opacity`、`/surfaces/Ground/opacity`。完整 `oscAddress` 字串皆可依 MadMapper 實際命名修改。
- 首次啟動可執行 `npm start`（等同 `node integrated-server.js`）。修改 JSON 後必須重啟 Node：使用 PM2 時執行 `pm2 restart <應用程式名稱>`；直接啟動時先停止舊程序，再重新執行啟動指令。
- Node.js 負責傳送 OSC 給 MadMapper；Unity 不會傳送 OSC，也不需要安裝 Unity OSC 套件。

## Unity 九座位設定

- Unity 實際控制檔位於 `Assets/Script/Singleton/UnityModeController.cs`，其 `SeatCount = 9`。
- WebSocket 的直接座位對應為 `Seat1` → `0`、`Seat2` → `1`、`Seat3` → `2`、`Seat4` → `3`、`Seat5` → `4`、`Seat6` → `5`、`Seat7` → `6`、`Seat8` → `7`、`Seat9` → `8`。
- 在 `RegionManager` 新增 `Region ID 8`，並在 `CloudMaterials` 加入第九個材質，也就是 `CloudMaterials[8]`。
- 如第九區需要區域特效，請在 `RegionVFX` 設定中加入 `RegionId = 8`，並依專案使用的狀態補齊對應清單。
- `RegionManager` 缺少 index 8 時執行時仍安全，但第九座位不會產生對應視覺效果，直到設定完成。
- 當 Region 或 CloudMaterials 設定數量未達至少 9 時，每個 `UnityModeController` 生命週期只顯示一次警告。

## Web 部署

Web 伺服器必須同時部署 `interface/console.html` 與 `interface/control-settings.js`；只部署 HTML 會使控制設定無法載入。

---

# Unity 遠端控制系統 - 部署指南

## 📋 系統架構

```
手機/平板網頁 <--WebSocket--> Node.js 伺服器 <--WebSocket--> Unity
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

### 2.1 修改網頁代碼
打開 `interface/console.html`，將 `serverUrl` 改成 WebSocket 伺服器的主機名稱或 IP（不要加 `ws://` 或連接埠）：

```javascript
const serverUrl = '192.168.1.100';
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
1. 啟動 Node.js 伺服器
2. 啟動 Unity（Play Mode）
3. 用手機開啟網頁

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
