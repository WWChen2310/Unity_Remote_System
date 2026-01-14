using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

/// <summary>
/// 連上 integrated-server 的 WebSocket Client，專門同步 maskId 至 ObjectDetector。
/// 改進版本：增強連線狀態監控和錯誤處理
/// </summary>
public class IntegratedWsClient : MonoBehaviour
{
    [Header("Server")]
    [Tooltip("e.g. ws://192.168.0.201:3000")]
    public string serverUrl = "ws://192.168.0.201:3000";

    [Header("Targets")]
    public ObjectDetector objectDetector;

    [Header("Options")]
    public bool autoConnectOnStart = true;
    [Tooltip("最大接收訊息大小 (bytes)")]
    public int receiveBufferSize = 16 * 1024;
    [Tooltip("連線狀態更新間隔 (秒)")]
    public float statusUpdateInterval = 30f;

    [Header("Connection Status")]
    [SerializeField] private ConnectionState currentState = ConnectionState.Disconnected;
    [SerializeField] private int reconnectAttempt = 0;
    [SerializeField] private float nextReconnectTime = 0f;

    // === 內部狀態 ===
    private ClientWebSocket _ws;
    private CancellationTokenSource _cts;
    private readonly ConcurrentQueue<Action> _mainThreadActions = new ConcurrentQueue<Action>();
    private Task _runnerTask;
    private volatile bool _isClosing;
    private int _latestMaskId = -1;
    private bool _pendingApplyOnCalibrated = false;
    private float _lastStatusUpdate = 0f;
    private DateTime _connectedAt;

    public enum ConnectionState
    {
        Disconnected,
        Connecting,
        Connected,
        Reconnecting
    }

    // JSON 結構
    [Serializable] private class SystemState { public int contentMode; public int maskMode; }
    [Serializable]
    private class MessageEnvelope
    {
        public string type;
        public int mode;
        public long timestamp;
        public SystemState state;
        public int maskId;
        public string clientType;
        public bool success;
        public string source;
        public string message;
    }

    void Start()
    {
        if (autoConnectOnStart) Connect();
    }

    void Update()
    {
        // 執行主線程工作隊列
        while (_mainThreadActions.TryDequeue(out var act))
        {
            try { act?.Invoke(); }
            catch (Exception e) { Debug.LogException(e); }
        }

        // 等待校正完成後應用 Mask
        if (_pendingApplyOnCalibrated && objectDetector != null && objectDetector.IsCalibrated)
        {
            _pendingApplyOnCalibrated = false;
            EnqueueMainThread(() => SafeApplyMask(_latestMaskId));
        }

        // 定期狀態更新
        if (currentState == ConnectionState.Connected && 
            Time.time - _lastStatusUpdate >= statusUpdateInterval)
        {
            _lastStatusUpdate = Time.time;
            var uptime = DateTime.Now - _connectedAt;
            Debug.Log($"[WS] ℹ️ 連線正常 | Uptime: {uptime.TotalMinutes:F1} 分鐘 | MaskID: {_latestMaskId}");
        }
    }

    void OnDisable()
    {
        _ = CloseAsync();
    }

    void OnApplicationQuit()
    {
        _ = CloseAsync();
    }

    // ===== 公開方法 =====

    [ContextMenu("Connect")]
    public void Connect()
    {
        if (_runnerTask != null && !_runnerTask.IsCompleted)
        {
            Debug.Log("[WS] 🔵 已經在連線流程中");
            return;
        }
        
        _isClosing = false;
        _cts = new CancellationTokenSource();
        _runnerTask = Task.Run(() => RunLoop(_cts.Token));
        Debug.Log("[WS] 🔌 啟動連線流程...");
    }

    [ContextMenu("Reconnect")]
    public async void Reconnect()
    {
        Debug.Log("[WS] 🔄 手動重新連線...");
        await CloseAsync();
        Connect();
    }

    [ContextMenu("Disconnect")]
    public async void Disconnect()
    {
        Debug.Log("[WS] 🔌 手動斷線...");
        await CloseAsync();
    }

    // ===== 內部方法 =====

    private async Task CloseAsync()
    {
        try { _isClosing = true; } catch { }
        
        currentState = ConnectionState.Disconnected;
        
        try
        {
            _cts?.Cancel();
            if (_ws != null && _ws.State == WebSocketState.Open)
            {
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "closing", CancellationToken.None);
            }
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[WS] 關閉時發生錯誤: {e.Message}");
        }
        finally
        {
            try { _ws?.Dispose(); } catch { }
            _ws = null;
        }
    }

    // 背景主循環（自動重連 + 接收）
    private async Task RunLoop(CancellationToken ct)
    {
        var backoff = new[] { 0.5f, 1f, 2f, 3f, 5f, 8f, 10f, 15f, 20f, 30f };
        int tries = 0;

        while (!ct.IsCancellationRequested && !_isClosing)
        {
            try
            {
                using (_ws = new ClientWebSocket())
                {
                    var uri = new Uri(serverUrl);
                    
                    // 設置連線狀態
                    EnqueueMainThread(() => {
                        currentState = tries > 0 ? ConnectionState.Reconnecting : ConnectionState.Connecting;
                        reconnectAttempt = tries;
                    });
                    
                    await _ws.ConnectAsync(uri, ct);

                    tries = 0; // 連上後重置退避
                    _connectedAt = DateTime.Now;
                    _lastStatusUpdate = Time.time;
                    
                    EnqueueMainThread(() => {
                        currentState = ConnectionState.Connected;
                        reconnectAttempt = 0;
                    });
                    
                    Debug.Log($"[WS] ✅ Connected: {serverUrl}");

                    // 身分識別：clientType = "unity"
                    await SendJsonAsync(new MessageEnvelope { 
                        clientType = "unity",
                        source = $"IntegratedWsClient@{Application.platform}"
                    }, ct);

                    // 請求完整系統狀態
                    await SendJsonAsync(new MessageEnvelope { type = "getState" }, ct);
                    Debug.Log("[WS] 📡 已請求系統狀態同步");

                    // 啟動接收循環
                    await ReceiveLoop(ct);
                }
            }
            catch (OperationCanceledException)
            {
                Debug.Log("[WS] ⏹️ 連線已取消");
            }
            catch (Exception e)
            {
                if (!_isClosing)
                {
                    Debug.LogWarning($"[WS] ❌ Disconnected: {e.Message}");
                    
                    EnqueueMainThread(() => {
                        currentState = ConnectionState.Disconnected;
                    });
                }
            }

            if (ct.IsCancellationRequested || _isClosing) break;

            // 重連退避
            float wait = backoff[Mathf.Min(tries, backoff.Length - 1)];
            tries++;
            
            EnqueueMainThread(() => {
                nextReconnectTime = Time.time + wait;
            });
            
            Debug.Log($"[WS] 🔄 Reconnecting in {wait:F1}s... (attempt #{tries})");
            
            await Task.Delay(TimeSpan.FromSeconds(wait), ct);
        }

        Debug.Log("[WS] 🔚 連線循環已結束");
    }

    private async Task ReceiveLoop(CancellationToken ct)
    {
        var buffer = new ArraySegment<byte>(new byte[receiveBufferSize]);

        while (!ct.IsCancellationRequested && _ws != null && _ws.State == WebSocketState.Open)
        {
            var sb = new StringBuilder();
            WebSocketReceiveResult result;

            // 讀一個完整訊息（可能分片）
            do
            {
                result = await _ws.ReceiveAsync(buffer, ct);
                
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    Debug.Log($"[WS] ⚠️ Server initiated close: {result.CloseStatus}");
                    await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "server close", ct);
                    return;
                }

                var chunk = Encoding.UTF8.GetString(buffer.Array, 0, result.Count);
                sb.Append(chunk);
            }
            while (!result.EndOfMessage);

            var json = sb.ToString();
            HandleMessage(json);
        }
    }

    private async Task SendJsonAsync(object payload, CancellationToken ct)
    {
        try
        {
            var json = JsonUtility.ToJson(payload);
            var bytes = Encoding.UTF8.GetBytes(json);
            var seg = new ArraySegment<byte>(bytes);
            
            if (_ws != null && _ws.State == WebSocketState.Open)
            {
                await _ws.SendAsync(seg, WebSocketMessageType.Text, true, ct);
            }
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[WS] 發送訊息失敗: {e.Message}");
        }
    }

    // ===== 訊息處理 =====

    private void HandleMessage(string json)
    {
        MessageEnvelope msg = null;
        try { msg = JsonUtility.FromJson<MessageEnvelope>(json); }
        catch (Exception e)
        {
            Debug.LogWarning($"[WS] JSON parse failed: {e.Message}\n{json}");
            return;
        }
        if (msg == null) return;

        // 1) 初始完整系統狀態（包含 maskMode）
        if (msg.type == "systemStateUpdate" && msg.state != null)
        {
            int mask = msg.state.maskMode;
            _latestMaskId = mask;
            OnMaskIdArrived(mask, reason: "systemStateUpdate");
            Debug.Log($"[WS] 📊 系統狀態同步完成: contentMode={msg.state.contentMode}, maskMode={mask}");
            return;
        }

        // 2) 後續遮罩變更事件（其他端操作）
        if (msg.type == "maskStatusUpdate")
        {
            int mask = msg.maskId;
            _latestMaskId = mask;
            OnMaskIdArrived(mask, reason: "maskStatusUpdate");
            return;
        }

        // 3) 伺服器關閉通知
        if (msg.type == "serverShutdown")
        {
            Debug.LogWarning($"[WS] ⚠️ 伺服器即將關閉: {msg.message}");
            return;
        }

        // 其他訊息類型可視需要擴充
    }

    // 將 maskId 寫入 ObjectDetector，並決定是否立即 ApplyMask 或等後
    private void OnMaskIdArrived(int maskId, string reason)
    {
        if (objectDetector == null)
        {
            Debug.LogWarning("[WS] ⚠️ ObjectDetector 未設定，無法應用 Mask");
            return;
        }

        // 先將數值設定確保，確保之後 ObjectDetector 初始化流程會套用正確 _maskId
        objectDetector._maskId = maskId;

        // 若已完成校正/不必等校正，可立即 Apply；否則等校正完成時 Apply
        if (objectDetector.IsCalibrated)
        {
            EnqueueMainThread(() => SafeApplyMask(maskId));
        }
        else
        {
            _pendingApplyOnCalibrated = true;
            Debug.Log($"[WS] ⏳ Mask 將在校正完成後套用: maskId = {maskId}");
        }

        Debug.Log($"[WS] 🎭 Mask sync ({reason}): maskId = {maskId}");
    }

    private void SafeApplyMask(int maskId)
    {
        try
        {
            if (objectDetector == null)
            {
                Debug.LogWarning("[WS] ⚠️ ObjectDetector 已被移除");
                return;
            }

            objectDetector.ApplyMask(maskId);
            Debug.Log($"[WS] ✅ Mask 已套用: maskId = {maskId}");
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[WS] ❌ ApplyMask({maskId}) failed: {e.Message}");
        }
    }

    private void EnqueueMainThread(Action act) => _mainThreadActions.Enqueue(act);

    // ===== 公開狀態查詢 =====

    public bool IsConnected() => currentState == ConnectionState.Connected;
    public ConnectionState GetConnectionState() => currentState;
    public int GetLatestMaskId() => _latestMaskId;
    public int GetReconnectAttempt() => reconnectAttempt;
}