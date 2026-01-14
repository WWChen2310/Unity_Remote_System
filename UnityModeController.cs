// UnityModeController.cs
// 改進版本：完善的重連機制和狀態同步
using UnityEngine;
using System;
using System.Collections.Generic;
using NativeWebSocket;

public class UnityModeController : MonoBehaviour
{
    [Header("伺服器設定")]
    [SerializeField] private string serverUrl = "ws://192.168.0.201:3000";
    
    [Header("當前模式")]
    [SerializeField] private int currentMode = 1;
    
    [Header("重連設定")]
    [SerializeField] private bool autoReconnect = true;
    [SerializeField] private float[] reconnectBackoff = { 1f, 2f, 3f, 5f, 8f, 10f, 15f, 20f, 30f };
    
    [Header("狀態監控")]
    [SerializeField] private ConnectionState connectionState = ConnectionState.Disconnected;
    [SerializeField] private int reconnectAttempt = 0;
    [SerializeField] private float nextReconnectTime = 0f;
    
    private WebSocket websocket;
    private Queue<Action> mainThreadActions = new Queue<Action>();
    private bool isManualDisconnect = false;
    private float reconnectTimer = 0f;

    public enum ConnectionState
    {
        Disconnected,
        Connecting,
        Connected,
        Reconnecting
    }

    async void Start()
    {
        await ConnectWebSocket();
    }

    void Update()
    {
        // NativeWebSocket 訊息分發
        #if !UNITY_WEBGL || UNITY_EDITOR
        if (websocket != null)
        {
            websocket.DispatchMessageQueue();
        }
        #endif

        // 執行主執行緒的動作
        while (mainThreadActions.Count > 0)
        {
            mainThreadActions.Dequeue()?.Invoke();
        }

        // 自動重連邏輯
        if (autoReconnect && !isManualDisconnect && 
            (connectionState == ConnectionState.Disconnected || connectionState == ConnectionState.Reconnecting))
        {
            if (Time.time >= nextReconnectTime)
            {
                Debug.Log($"🔄 準備重新連接... (第 {reconnectAttempt + 1} 次嘗試)");
                _ = ConnectWebSocket();
            }
        }
    }

    async System.Threading.Tasks.Task ConnectWebSocket()
    {
        // 避免重複連線
        if (websocket != null && websocket.State == WebSocketState.Connecting)
        {
            Debug.Log("🔵 已經在連線中，跳過重複連線");
            return;
        }

        if (websocket != null && websocket.State == WebSocketState.Open)
        {
            Debug.Log("✅ WebSocket 已連線，無需重複連線");
            return;
        }

        try
        {
            connectionState = reconnectAttempt > 0 ? ConnectionState.Reconnecting : ConnectionState.Connecting;
            
            // 清理舊連線
            if (websocket != null)
            {
                try
                {
                    await websocket.Close();
                }
                catch { }
                websocket = null;
            }

            websocket = new WebSocket(serverUrl);

            websocket.OnOpen += () =>
            {
                Debug.Log("✅ WebSocket 已連接");
                connectionState = ConnectionState.Connected;
                reconnectAttempt = 0; // 重置重連計數器
                isManualDisconnect = false;
                
                EnqueueMainThreadAction(() =>
                {
                    // 識別為 Unity 客戶端
                    SendMessage(new { 
                        clientType = "unity", 
                        version = Application.version,
                        platform = Application.platform.ToString()
                    });
                    
                    // 連接後請求當前完整系統狀態
                    SendMessage(new { type = "getState" });
                    
                    Debug.Log("📡 已請求系統狀態同步");
                });
            };

            websocket.OnMessage += (bytes) =>
            {
                string message = System.Text.Encoding.UTF8.GetString(bytes);
                Debug.Log($"📨 收到訊息: {message}");
                
                EnqueueMainThreadAction(() =>
                {
                    HandleMessage(message);
                });
            };

            websocket.OnError += (errorMsg) =>
            {
                Debug.LogError($"❌ WebSocket 錯誤: {errorMsg}");
            };

            websocket.OnClose += (closeCode) =>
            {
                Debug.Log($"❌ WebSocket 已斷線: {closeCode}");
                connectionState = ConnectionState.Disconnected;
                
                EnqueueMainThreadAction(() =>
                {
                    // 只有非手動斷線時才重連
                    if (!isManualDisconnect && autoReconnect)
                    {
                        ScheduleReconnect();
                    }
                });
            };

            await websocket.Connect();
        }
        catch (Exception e)
        {
            Debug.LogError($"❌ 連接失敗: {e.Message}");
            connectionState = ConnectionState.Disconnected;
            
            if (!isManualDisconnect && autoReconnect)
            {
                ScheduleReconnect();
            }
        }
    }

    void ScheduleReconnect()
    {
        // 使用退避算法計算等待時間
        int backoffIndex = Mathf.Min(reconnectAttempt, reconnectBackoff.Length - 1);
        float waitTime = reconnectBackoff[backoffIndex];
        
        nextReconnectTime = Time.time + waitTime;
        reconnectAttempt++;
        connectionState = ConnectionState.Reconnecting;
        
        Debug.Log($"⏰ {waitTime} 秒後重新連接... (第 {reconnectAttempt} 次嘗試)");
    }

    void HandleMessage(string message)
    {
        try
        {
            var data = JsonUtility.FromJson<MessageData>(message);
            
            // 處理完整系統狀態更新
            if (data.type == "systemStateUpdate" && data.state != null)
            {
                Debug.Log($"📊 收到完整系統狀態: contentMode={data.state.contentMode}, maskMode={data.state.maskMode}");
                SwitchToMode(data.state.contentMode);
                return;
            }
            
            // 處理模式更新
            if (data.type == "modeUpdate")
            {
                SwitchToMode(data.mode);
                return;
            }

            // 處理自動循環更新
            if (data.type == "autoCycleUpdate")
            {
                Debug.Log($"🔄 自動循環狀態: enabled={data.autoCycleEnabled}");
                // 這裡可以添加自動循環相關的處理邏輯
                return;
            }

            // 處理伺服器關閉通知
            if (data.type == "serverShutdown")
            {
                Debug.LogWarning($"⚠️ 伺服器即將關閉: {data.message}");
                return;
            }
        }
        catch (Exception e)
        {
            Debug.LogError($"❌ 解析訊息失敗: {e.Message}\n訊息內容: {message}");
        }
    }

    void SwitchToMode(int mode)
    {
        if (currentMode == mode) 
        {
            Debug.Log($"ℹ️ 已經是模式 {mode}，跳過切換");
            return;
        }
        
        currentMode = mode;
        Debug.Log($"🔄 切換至模式: {mode}");
        
        // 在這裡實作你的模式切換邏輯
        switch (mode)
        {
            case 1:
                ApplyMode1();
                break;
            case 2:
                ApplyMode2();
                break;
            case 3:
                ApplyMode3();
                break;
            case 4:
                ApplyMode4();
                break;
            case 5:
                ApplyMode5();
                break;
            default:
                Debug.LogWarning($"⚠️ 未知的模式: {mode}");
                break;
        }
    }

    // 實作各個模式的邏輯
    void ApplyMode1()
    {
        Debug.Log("🌅 應用模式 1");
        // 例如：切換場景、改變渲染設定、調整後處理效果等
        // RenderSettings.skybox = mode1Skybox;
        // Volume volume = FindObjectOfType<Volume>();
        // if (volume.profile.TryGet<ColorAdjustments>(out var colorAdjustments))
        // {
        //     colorAdjustments.saturation.value = 0f;
        // }
    }

    void ApplyMode2()
    {
        Debug.Log("🌆 應用模式 2");
        // 你的模式 2 邏輯
    }

    void ApplyMode3()
    {
        Debug.Log("🌃 應用模式 3");
        // 你的模式 3 邏輯
    }

    void ApplyMode4()
    {
        Debug.Log("🌌 應用模式 4");
        // 你的模式 4 邏輯
    }

    void ApplyMode5()
    {
        Debug.Log("✨ 應用模式 5");
        // 你的模式 5 邏輯
    }

    async void SendMessage(object data)
    {
        if (websocket != null && websocket.State == WebSocketState.Open)
        {
            try
            {
                string json = JsonUtility.ToJson(data);
                await websocket.SendText(json);
            }
            catch (Exception e)
            {
                Debug.LogError($"❌ 發送訊息失敗: {e.Message}");
            }
        }
        else
        {
            Debug.LogWarning("⚠️ WebSocket 未連接，無法發送訊息");
        }
    }

    void EnqueueMainThreadAction(Action action)
    {
        mainThreadActions.Enqueue(action);
    }

    // ===== 手動控制方法 =====

    [ContextMenu("手動重新連接")]
    public async void ManualReconnect()
    {
        Debug.Log("🔄 手動觸發重新連接...");
        isManualDisconnect = false;
        reconnectAttempt = 0;
        await ConnectWebSocket();
    }

    [ContextMenu("手動斷線")]
    public async void ManualDisconnect()
    {
        Debug.Log("🔌 手動斷線...");
        isManualDisconnect = true;
        autoReconnect = false;
        connectionState = ConnectionState.Disconnected;
        
        if (websocket != null)
        {
            await websocket.Close();
            websocket = null;
        }
    }

    // ===== 生命週期管理 =====

    async void OnApplicationQuit()
    {
        isManualDisconnect = true;
        if (websocket != null)
        {
            await websocket.Close();
        }
    }

    async void OnDestroy()
    {
        isManualDisconnect = true;
        if (websocket != null)
        {
            await websocket.Close();
        }
    }

    void OnDisable()
    {
        isManualDisconnect = true;
    }

    // ===== JSON 資料結構 =====

    [Serializable]
    private class MessageData
    {
        public string type;
        public int mode;
        public long timestamp;
        public SystemState state;
        public bool autoCycleEnabled;
        public string message;
    }

    [Serializable]
    private class SystemState
    {
        public int contentMode;
        public int maskMode;
        // 可以根據需要添加更多字段
    }

    // ===== 狀態查詢方法（供其他腳本使用）=====

    public bool IsConnected()
    {
        return connectionState == ConnectionState.Connected && 
               websocket != null && 
               websocket.State == WebSocketState.Open;
    }

    public ConnectionState GetConnectionState()
    {
        return connectionState;
    }

    public int GetCurrentMode()
    {
        return currentMode;
    }
}