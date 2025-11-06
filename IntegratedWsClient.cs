using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

/// <summary>
/// 連上 integrated-server 的 WebSocket Client，專門同步 maskId 到 ObjectDetector。
/// - 連線成功後：送出 {clientType:"unity"}，等待 systemStateUpdate -> 取 state.maskMode。
/// - 後續持續監聽 maskStatusUpdate -> 取 maskId。
/// - 主緒排程：所有 Unity API 呼叫都經由主緒佇列執行。
/// - 自動重連 + 指數退避。
/// </summary>
public class IntegratedWsClient : MonoBehaviour
{
    [Header("Server")]
    [Tooltip("e.g. ws://192.168.0.200:3000")]
    public string serverUrl = "ws://127.0.0.1:3000";

    [Header("Targets")]
    public ObjectDetector objectDetector;

    [Header("Options")]
    public bool autoConnectOnStart = true;
    [Tooltip("最大接收訊息大小 (bytes)")]
    public int receiveBufferSize = 16 * 1024;

    // === 內部狀態 ===
    private ClientWebSocket _ws;
    private CancellationTokenSource _cts;
    private readonly ConcurrentQueue<Action> _mainThreadActions = new ConcurrentQueue<Action>();
    private Task _runnerTask;
    private volatile bool _isClosing;
    private int _latestMaskId = -1;     // 最近一次從 WS 得到的 maskId
    private bool _pendingApplyOnCalibrated = false; // 等待 ObjectDetector 初始化完成時補 ApplyMask

    // JSON 封裝（用 JsonUtility）
    [Serializable] private class SystemState { public int contentMode; public int maskMode; }
    [Serializable]
    private class MessageEnvelope
    {
        public string type;
        public int mode;
        public long timestamp;
        public SystemState state; // for systemStateUpdate
        public int maskId;        // for maskStatusUpdate
        public string clientType; // we send this when identifying ourselves
        public bool success;
        public string source;
    }

    void Start()
    {
        if (autoConnectOnStart) Connect();
    }

    void Update()
    {
        // 將背景緒排入的主緒工作取出執行（例如 ApplyMask）
        while (_mainThreadActions.TryDequeue(out var act))
            try { act?.Invoke(); } catch (Exception e) { Debug.LogException(e); }

        // 若等初始化完成才補 ApplyMask
        if (_pendingApplyOnCalibrated && objectDetector != null && objectDetector.IsCalibrated)
        {
            _pendingApplyOnCalibrated = false;
            EnqueueMainThread(() => SafeApplyMask(_latestMaskId));
        }
    }

    void OnDisable()
    {
        // 結束時關閉連線
        _ = CloseAsync();
    }

    /// <summary>手動觸發連線</summary>
    [ContextMenu("Connect")]
    public void Connect()
    {
        if (_runnerTask != null && !_runnerTask.IsCompleted) return;
        _isClosing = false;
        _cts = new CancellationTokenSource();
        _runnerTask = Task.Run(() => RunLoop(_cts.Token));
    }

    /// <summary>手動中斷並重連</summary>
    [ContextMenu("Reconnect")]
    public async void Reconnect()
    {
        await CloseAsync();
        Connect();
    }

    private async Task CloseAsync()
    {
        try { _isClosing = true; } catch { }
        try
        {
            _cts?.Cancel();
            if (_ws != null && _ws.State == WebSocketState.Open)
            {
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "closing", CancellationToken.None);
            }
        }
        catch { /* ignore */ }
        finally
        {
            try { _ws?.Dispose(); } catch { }
            _ws = null;
        }
    }

    // === 背景主迴圈（自動重連 + 收發）===
    private async Task RunLoop(CancellationToken ct)
    {
        var backoff = new[] { 0.5f, 1f, 2f, 4f, 8f, 10f };
        int tries = 0;

        while (!ct.IsCancellationRequested && !_isClosing)
        {
            try
            {
                using (_ws = new ClientWebSocket())
                {
#if UNITY_EDITOR || UNITY_STANDALONE
                    // 在某些平台需要允許不安全/自簽憑證情境，若有需要可在此配置
#endif
                    var uri = new Uri(serverUrl);
                    await _ws.ConnectAsync(uri, ct);

                    tries = 0; // 連上後重置退避
                    Debug.Log("[WS] Connected: " + serverUrl);

                    // 身份註冊：clientType = "unity"
                    await SendJsonAsync(new MessageEnvelope { clientType = "unity" }, ct);

                    // 啟動接收迴圈
                    await ReceiveLoop(ct);
                }
            }
            catch (OperationCanceledException) { /* 關閉/跳出 */ }
            catch (Exception e)
            {
                if (!_isClosing) Debug.LogWarning("[WS] Disconnected: " + e.Message);
            }

            if (ct.IsCancellationRequested || _isClosing) break;

            // 重連退避
            float wait = backoff[Mathf.Min(tries, backoff.Length - 1)];
            tries++;
            await Task.Delay(TimeSpan.FromSeconds(wait), ct);
            Debug.Log($"[WS] Reconnecting... (after {wait:0.0}s)");
        }
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
        var json = JsonUtility.ToJson(payload);
        var bytes = Encoding.UTF8.GetBytes(json);
        var seg = new ArraySegment<byte>(bytes);
        if (_ws != null && _ws.State == WebSocketState.Open)
            await _ws.SendAsync(seg, WebSocketMessageType.Text, true, ct);
    }

    // === 訊息處理 ===
    private void HandleMessage(string json)
    {
        MessageEnvelope msg = null;
        try { msg = JsonUtility.FromJson<MessageEnvelope>(json); }
        catch (Exception e)
        {
            Debug.LogWarning("[WS] JSON parse failed: " + e.Message + "\n" + json);
            return;
        }
        if (msg == null) return;

        // 1) 初始完整系統狀態（包含 maskMode）
        if (msg.type == "systemStateUpdate" && msg.state != null)
        {
            int mask = msg.state.maskMode; // 伺服器廣播的欄位名稱
            _latestMaskId = mask;
            OnMaskIdArrived(mask, reason: "systemStateUpdate");
            return;
        }

        // 2) 後續面罩變更事件（其他端切換）
        if (msg.type == "maskStatusUpdate")
        {
            int mask = msg.maskId;
            _latestMaskId = mask;
            OnMaskIdArrived(mask, reason: "maskStatusUpdate");
            return;
        }

        // 其他訊息（modeUpdate/autoCycleUpdate/…）可視需要擴充
    }

    // 將 maskId 寫入 ObjectDetector，並決定是否立即 ApplyMask 或延後
    private void OnMaskIdArrived(int maskId, string reason)
    {
        if (objectDetector == null) return;

        // 先把欄位設正確，確保之後 ObjectDetector 初始化流程會用對的 _maskId
        objectDetector._maskId = maskId;

        // 若已完成基準/尺寸等初始化，可立刻 Apply；否則等初始化完成補 Apply
        if (objectDetector.IsCalibrated)
        {
            EnqueueMainThread(() => SafeApplyMask(maskId));
        }
        else
        {
            _pendingApplyOnCalibrated = true;
        }

        // 附帶 Debug
        Debug.Log($"[WS] Mask sync ({reason}): maskId = {maskId}");
    }

    private void SafeApplyMask(int maskId)
    {
        try
        {
            // 你的 ObjectDetector.ApplyMask(maskId) 會檢查 mask 尺寸與深度影像尺寸是否一致
            // 若此時 _w/_h 尚未建立，這裡不會呼叫；但正常來說 IsCalibrated==true 時就會有值
            objectDetector.ApplyMask(maskId);
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[WS] ApplyMask({maskId}) failed: {e.Message}");
        }
    }

    private void EnqueueMainThread(Action act) => _mainThreadActions.Enqueue(act);
}
