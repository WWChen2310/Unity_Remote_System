using UnityEngine;
using System;
using System.Collections.Concurrent; // [新增] 用於執行緒安全的 Queue
using System.Collections.Generic;
using NativeWebSocket;
using System.Threading.Tasks;

public class UnityModeController : MonoBehaviour
{
    public const int SeatCount = 9;

    [Header("伺服器設定")]
    [SerializeField] private string serverUrl = "ws://192.168.0.201:3000"; // 請確認 IP
    
    [Header("當前狀態")]
    [SerializeField] private int currentMode = 1;
    // [新功能] 9個座位的模式
    [SerializeField] private int[] currentTableModes = new int[SeatCount];

    private WebSocket websocket;
    // [修改] 改用 ConcurrentQueue 以確保執行緒安全
    private ConcurrentQueue<Action> mainThreadActions = new ConcurrentQueue<Action>();
    private bool isReconnecting = false;

    async void Start()
    {
        await ConnectWebSocket();
    }

    async Task ConnectWebSocket()
    {
        if (websocket != null)
        {
            // 清理舊連線
            try { await websocket.Close(); } catch { }
        }

        websocket = new WebSocket(serverUrl);

        websocket.OnOpen += () =>
        {
            Debug.Log("✅ WebSocket 已連接");
            isReconnecting = false;
            EnqueueMainThreadAction(() =>
            {
                // 發送識別與同步請求
                SendMessage(new { clientType = "unity", type = "unitySync" });
            });
        };

        websocket.OnMessage += (bytes) =>
        {
            string message = System.Text.Encoding.UTF8.GetString(bytes);
            EnqueueMainThreadAction(() => HandleMessage(message));
        };

        websocket.OnClose += (e) =>
        {
            Debug.Log($"❌ WebSocket 斷線: {e}");
            if (!isReconnecting) ReconnectLoop();
        };

        websocket.OnError += (e) =>
        {
            Debug.LogError($"❌ WebSocket 錯誤: {e}");
            if (!isReconnecting) ReconnectLoop();
        };

        try {
            await websocket.Connect();
        } catch (Exception ex) {
            Debug.LogError($"連線例外: {ex.Message}");
            if (!isReconnecting) ReconnectLoop();
        }
    }

    // [強韌性] 無限重連迴圈
    async void ReconnectLoop()
    {
        isReconnecting = true;
        while (isReconnecting)
        {
            Debug.Log("🔄 5秒後嘗試重連...");
            await Task.Delay(5000);
            
            // 如果物件已被銷毀(停止播放)，停止重連
            if (this == null) return; 

            try {
                await ConnectWebSocket();
                // 如果 ConnectWebSocket 成功 (跑到 OnOpen)，isReconnecting 會變成 false，迴圈結束
            } catch { 
                // 失敗則繼續迴圈
            }
        }
    }

    void HandleMessage(string message)
    {
        try
        {
            var data = JsonUtility.FromJson<MessageData>(message);

            // 1. 系統完整狀態同步 (連線初期)
            if (data.type == "systemStateUpdate" && data.state != null)
            {
                UpdateLocalState(data.state.contentMode, data.state.tableModes);
            }
            // 2. 模式切換 (一般切換或自動循環)
            else if (data.type == "modeUpdate")
            {
                UpdateLocalState(data.mode, data.tableModes);
            }
            // 3. [新功能] 僅桌子狀態更新
            else if (data.type == "tableModeUpdate")
            {
                UpdateLocalState(currentMode, data.tableModes);
            }
        }
        catch (Exception e)
        {
            Debug.LogError($"JSON 解析失敗: {e.Message}");
        }
    }

    void UpdateLocalState(int newMode, int[] newTableModes)
    {
        // 更新桌子資料
        if (newTableModes != null)
        {
            currentTableModes = NormalizeTableModes(newTableModes);
        }
        else if (currentTableModes == null || currentTableModes.Length != SeatCount)
        {
            currentTableModes = NormalizeTableModes(currentTableModes);
        }

        bool modeChanged = (currentMode != newMode);
        currentMode = newMode;

        if (modeChanged)
        {
            SwitchToMode(currentMode);
        }
        
        // 如果是在模式 8，且收到桌子更新，即使主模式沒變也要刷新
        if (currentMode == 8)
        {
            ApplyMode8();
        }
    }

    void SwitchToMode(int mode)
    {
        Debug.Log($"🎬 切換至主模式: {mode}");
        switch (mode)
        {
            case 1: ApplyMode1(); break;
            case 2: ApplyMode2(); break;
            case 3: ApplyMode3(); break;
            case 4: ApplyMode4(); break;
            case 8: ApplyMode8(); break; // [新功能]
            default: Debug.LogWarning($"未定義的模式: {mode}"); break;
        }
    }

    void ApplyMode1() { /* 原有邏輯 */ }
    void ApplyMode2() { /* 原有邏輯 */ }
    void ApplyMode3() { /* 原有邏輯 */ }
    void ApplyMode4() { /* 原有邏輯 */ }

    // [新功能] 分割內容模式實作
    void ApplyMode8()
    {
        currentTableModes = NormalizeTableModes(currentTableModes);

        if (RegionManager.Instance == null) return;
        Debug.Log("🪟 應用分割內容模式");
        for (int i = 0; i < SeatCount; i++)
        {
            int tableMode = currentTableModes[i];
            int regionIndex = RegionIndexForSeat(i);
            Debug.Log($"   - 座位 {i+1}: 模式 {tableMode}");
            RegionManager.Instance.SetRegionStatus(regionIndex, tableMode);
            RegionManager.Instance.SetCloudMaterial(regionIndex, tableMode);
            RegionManager.Instance.SetRegionVFX(regionIndex, tableMode);
        }
    }

    public static int[] NormalizeTableModes(int[] values)
    {
        int[] normalized = new int[SeatCount];
        if (values != null)
        {
            Array.Copy(values, normalized, Math.Min(values.Length, SeatCount));
        }

        return normalized;
    }

    public static int RegionIndexForSeat(int seatIndex)
    {
        return seatIndex;
    }

    async void SendMessage(object data)
    {
        if (websocket != null && websocket.State == WebSocketState.Open)
        {
            string json = JsonUtility.ToJson(data);
            await websocket.SendText(json);
        }
    }

    // [補回遺失的函式] 將動作排入主執行緒佇列
    void EnqueueMainThreadAction(Action action)
    {
        mainThreadActions.Enqueue(action);
    }

    void Update()
    {
        #if !UNITY_WEBGL || UNITY_EDITOR
        if (websocket != null) websocket.DispatchMessageQueue();
        #endif

        // [修改] 使用 ConcurrentQueue 的 TryDequeue
        while (mainThreadActions.TryDequeue(out var action))
        {
            action?.Invoke();
        }
    }

    async void OnDestroy()
    {
        isReconnecting = false;
        if (websocket != null) await websocket.Close();
    }

    // JSON 資料結構
    [Serializable]
    private class MessageData
    {
        public string type;
        public int mode;
        public int[] tableModes;
        public SystemState state;
    }

    [Serializable]
    private class SystemState
    {
        public int contentMode;
        public int maskMode;
        public int[] tableModes;
    }
}
