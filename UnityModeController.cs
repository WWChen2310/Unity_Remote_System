// UnityModeController.cs
using UnityEngine;
using System;
using System.Collections.Generic;
using NativeWebSocket;

public class UnityModeController : MonoBehaviour
{
    [Header("伺服器設定")]
    [SerializeField] private string serverUrl = "ws://192.168.1.100:3000";
    
    [Header("當前模式")]
    [SerializeField] private int currentMode = 1;
    
    private WebSocket websocket;
    private Queue<Action> mainThreadActions = new Queue<Action>();

    async void Start()
    {
        await ConnectWebSocket();
    }

    async System.Threading.Tasks.Task ConnectWebSocket()
    {
        try
        {
            websocket = new WebSocket(serverUrl);

            websocket.OnOpen += () =>
            {
                Debug.Log("✅ WebSocket 已連接");
                EnqueueMainThreadAction(() =>
                {
                    // 識別為 Unity 客戶端
                    SendMessage(new { clientType = "unity", version = Application.version });
                    // 連接後請求當前模式
                    SendMessage(new { type = "getMode" });
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
                EnqueueMainThreadAction(() =>
                {
                    // 5 秒後重新連接
                    Invoke(nameof(ReconnectWebSocket), 5f);
                });
            };

            await websocket.Connect();
        }
        catch (Exception e)
        {
            Debug.LogError($"❌ 連接失敗: {e.Message}");
            Invoke(nameof(ReconnectWebSocket), 5f);
        }
    }

    async void ReconnectWebSocket()
    {
        Debug.Log("🔄 嘗試重新連接...");
        await ConnectWebSocket();
    }

    void HandleMessage(string message)
    {
        try
        {
            var data = JsonUtility.FromJson<MessageData>(message);
            
            if (data.type == "modeUpdate")
            {
                SwitchToMode(data.mode);
            }
        }
        catch (Exception e)
        {
            Debug.LogError($"❌ 解析訊息失敗: {e.Message}");
        }
    }

    void SwitchToMode(int mode)
    {
        if (currentMode == mode) return;
        
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

    async void SendMessage(object data)
    {
        if (websocket.State == WebSocketState.Open)
        {
            string json = JsonUtility.ToJson(data);
            await websocket.SendText(json);
        }
    }

    void Update()
    {
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
    }

    void EnqueueMainThreadAction(Action action)
    {
        mainThreadActions.Enqueue(action);
    }

    async void OnApplicationQuit()
    {
        if (websocket != null)
        {
            await websocket.Close();
        }
    }

    async void OnDestroy()
    {
        if (websocket != null)
        {
            await websocket.Close();
        }
    }

    // JSON 資料結構
    [Serializable]
    private class MessageData
    {
        public string type;
        public int mode;
    }
}