# Unity 遠端控制系統 - 部署指南

## 📋 系統架構

```
手機/平板網頁 <--WebSocket--> Node.js 伺服器 <--WebSocket--> Unity
```

---

## 🚀 步驟 1：設置 Node.js 伺服器

### 1.1 安裝 Node.js
- 從 [nodejs.org](https://nodejs.org/) 下載並安裝 LTS 版本

### 1.2 建立專案目錄
```bash
mkdir unity-control-server
cd unity-control-server
```

### 1.3 初始化專案並安裝依賴
```bash
npm init -y
npm install ws
```

### 1.4 儲存伺服器代碼
將 `server.js` 檔案儲存到專案目錄

### 1.5 啟動伺服器
```bash
node server.js
```

成功後會顯示：
```
🚀 WebSocket 伺服器已啟動於 ws://0.0.0.0:3000
```

### 1.6 查看內網 IP
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
打開 HTML 檔案，修改第 190 行的伺服器位址：

```javascript
const serverUrl = 'ws://192.168.1.100:3000'; // 改成你的內網 IP
```

### 2.2 部署選項

**選項 A：使用 Node.js 提供網頁（推薦）**

建立 `web-server.js`：
```javascript
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;

const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(500);
            res.end('Error loading page');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 網頁伺服器運行於 http://0.0.0.0:${PORT}`);
});
```

啟動：
```bash
node web-server.js
```

用手機瀏覽器開啟：`http://192.168.1.100:8080`

**選項 B：使用任何 Web 伺服器**
- IIS、Apache、Nginx 都可以
- 只需將 HTML 放在網頁根目錄

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

### 3.2 加入控制器腳本

1. 在 Unity 專案中建立 `Scripts` 資料夾
2. 建立新的 C# 腳本 `UnityModeController.cs`
3. 複製提供的程式碼

### 3.3 掛載腳本

1. 在 Hierarchy 中建立空物件，命名為 `ModeController`
2. 將 `UnityModeController.cs` 拖曳到該物件上
3. 在 Inspector 中修改 `Server Url` 為你的內網位址：
   ```
   ws://192.168.1.100:3000
   ```

### 3.4 實作模式邏輯

在 `ApplyMode1()` ~ `ApplyMode4()` 函式中實作你的邏輯，例如：

```csharp
void ApplyMode1()
{
    // 範例：切換 Skybox
    RenderSettings.skybox = mode1Skybox;
    
    // 範例：調整 HDRP Volume
    Volume volume = FindObjectOfType<Volume>();
    if (volume.profile.TryGet<ColorAdjustments>(out var colorAdj))
    {
        colorAdj.saturation.value = 0f; // 黑白模式
    }
    
    // 範例：切換光照
    DirectionalLight.intensity = 1.5f;
}
```

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